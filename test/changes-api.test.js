/**
 * /api/changes — the right-panel "变更" data source, aligned with the Claude
 * Code changes panel: git numstat for turn/branch scopes, binary and untracked
 * handling, and a clean non-git degradation.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "myclaude-changes-"));
process.env.MYCLAUDE_HOME = home;
const { startGui } = await import("../src/ui/gui-server.js");

function makeRepo() {
  const repo = mkdtempSync(join(tmpdir(), "changes-repo-"));
  const g = (args) => spawnSync("git", args, { cwd: repo, encoding: "utf8", windowsHide: true });
  g(["init"]);
  g(["config", "user.email", "t@t"]);
  g(["config", "user.name", "t"]);
  writeFileSync(join(repo, "base.txt"), "line1\nline2\nline3\n");
  g(["add", "."]);
  g(["commit", "-m", "base"]);
  return repo;
}

async function start(cwd) {
  const config = {
    provider: "openai", baseUrl: "http://127.0.0.1:1/v1", apiKey: "k",
    model: "test-model", permissionMode: "auto", maxTurns: 3,
    contextWindow: 100000, compactThreshold: 0.8, vision: true,
  };
  const { server, address } = await startGui({ config, port: 0, open: false, cwd });
  return { gui: server, address };
}

async function stop(ctx) {
  await new Promise((r) => ctx.gui.close(r));
}

test("branch scope reports modified, untracked and binary files", async () => {
  const repo = makeRepo();
  const ctx = await start(repo);
  try {
    // modify, create untracked, create a binary file
    writeFileSync(join(repo, "base.txt"), "line1\nline2-changed\nline3\nline4\n");
    writeFileSync(join(repo, "new.txt"), "brand new");
    writeFileSync(join(repo, "logo.bin"), Buffer.from([0, 159, 146, 150, 0, 1]));
    const j = await (await fetch(ctx.address + "/api/changes?scope=branch")).json();
    assert.equal(j.ok, true);
    const byPath = Object.fromEntries(j.files.map((f) => [f.path, f]));
    assert.ok(byPath["base.txt"], "modified file listed");
    assert.equal(byPath["base.txt"].status, "M");
    assert.equal(byPath["base.txt"].added, 2);
    assert.equal(byPath["base.txt"].removed, 1);
    assert.equal(byPath["new.txt"].status, "A", "untracked file shows as added");
    assert.equal(byPath["logo.bin"].status, "binary", "binary file flagged");
    assert.equal(j.totalAdded, 2 + 1, "base 2 added + new.txt 1 line; binary adds 0");
    assert.equal(j.totalRemoved, 1);
  } finally { await stop(ctx); rmSync(repo, { recursive: true, force: true }); }
});

test("turn scope with no touched files is empty, not an error", async () => {
  const repo = makeRepo();
  const ctx = await start(repo);
  try {
    const j = await (await fetch(ctx.address + "/api/changes?sessionKey=tab1&scope=turn")).json();
    assert.equal(j.ok, true);
    assert.deepEqual(j.files, []);
  } finally { await stop(ctx); rmSync(repo, { recursive: true, force: true }); }
});

test("non-git directory degrades instead of erroring", async () => {
  const plain = mkdtempSync(join(tmpdir(), "changes-plain-"));
  const ctx = await start(plain);
  try {
    const j = await (await fetch(ctx.address + "/api/changes?scope=branch")).json();
    assert.equal(j.ok, false);
    assert.equal(j.reason, "non-git");
  } finally { await stop(ctx); rmSync(plain, { recursive: true, force: true }); }
});

test("per-file diff returns the unified diff", async () => {
  const repo = makeRepo();
  const ctx = await start(repo);
  try {
    writeFileSync(join(repo, "base.txt"), "line1\nchanged\nline3\n");
    const j = await (await fetch(ctx.address + "/api/changes/diff?path=" + encodeURIComponent("base.txt"))).json();
    assert.equal(j.ok, true);
    assert.match(j.diff, /-line2/);
    assert.match(j.diff, /\+changed/);
  } finally { await stop(ctx); rmSync(repo, { recursive: true, force: true }); }
});
