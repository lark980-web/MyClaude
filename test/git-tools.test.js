/**
 * Git tool tests.
 *
 * A throw-away repository is created in the OS temp directory so the real
 * workspace is never touched (no accidental commits, no dependence on the
 * developer's git identity).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  gitStatusTool,
  gitDiffTool,
  gitLogTool,
  gitCommitTool,
  parseUnifiedDiff,
  diffSummary,
} from "../src/tools/git.js";

function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), "mc-git-"));
  const quiet = { stdio: "ignore" };
  execSync("git init --quiet", { cwd: dir, ...quiet });
  execSync("git config user.email t@example.com", { cwd: dir, ...quiet });
  execSync("git config user.name Tester", { cwd: dir, ...quiet });
  execSync("git config commit.gpgsign false", { cwd: dir, ...quiet });
  writeFileSync(join(dir, "a.js"), "const a = 1;\nconst b = 2;\n");
  execSync("git add -A && git commit -m init --quiet", { cwd: dir, ...quiet });
  return dir;
}

test("GitStatus reports branch, changes and recent commits", async () => {
  const dir = makeRepo();
  try {
    writeFileSync(join(dir, "a.js"), "const a = 1;\nconst b = 9;\n");
    writeFileSync(join(dir, "new.txt"), "hello");

    const r = await gitStatusTool.run({ cwd: dir });
    assert.equal(r.ok, true);
    assert.match(r.content, /branch:/);
    assert.match(r.content, /unstaged \(1\)/);
    assert.match(r.content, /untracked \(1\)/);
    assert.deepEqual(r.git.branch !== "", true);
    assert.equal(r.git.unstaged.length, 1);
    assert.equal(r.git.untracked.length, 1);
    assert.equal(r.git.recent[0].includes("init"), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("GitStatus fails clearly outside a repository", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mc-nogit-"));
  try {
    const r = await gitStatusTool.run({ cwd: dir });
    assert.equal(r.ok, false);
    assert.match(r.content, /not a git|git failed|git is not installed/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("GitDiff returns text plus a parsed structure", async () => {
  const dir = makeRepo();
  try {
    writeFileSync(join(dir, "a.js"), "const a = 1;\nconst b = 9;   // bumped\n");
    const r = await gitDiffTool.run({ cwd: dir });
    assert.equal(r.ok, true);
    assert.equal(r.diff.length, 1);
    assert.equal(r.diff[0].added, 1);
    assert.equal(r.diff[0].removed, 1);
    assert.match(r.git.summary, /1 file/);

    const lines = r.diff[0].hunks.flatMap((h) => h.lines);
    const adds = lines.filter((l) => l.type === "add").map((l) => l.text);
    assert.deepEqual(adds, ["const b = 9;   // bumped"]);
    const dels = lines.filter((l) => l.type === "del").map((l) => l.text);
    assert.deepEqual(dels, ["const b = 2;"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("GitDiff reports no changes cleanly and honours path filters", async () => {
  const dir = makeRepo();
  try {
    const clean = await gitDiffTool.run({ cwd: dir });
    assert.equal(clean.content, "(no changes)");

    writeFileSync(join(dir, "a.js"), "const a = 2;\nconst b = 2;\n");
    const scoped = await gitDiffTool.run({ cwd: dir, paths: ["a.js"] });
    assert.equal(scoped.diff.length, 1);

    const other = await gitDiffTool.run({ cwd: dir, paths: ["does-not-exist.js"] });
    assert.equal(other.content, "(no changes)");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("stat_only keeps the diffstat without the hunks", async () => {
  const dir = makeRepo();
  try {
    writeFileSync(join(dir, "a.js"), "const a = 1;\nconst b = 7;\n");
    const r = await gitDiffTool.run({ cwd: dir, stat_only: true });
    assert.equal(r.ok, true);
    assert.match(r.content, /a\.js/);
    assert.equal(r.content.includes("@@"), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("GitLog lists commits, in both formats and scoped to paths", async () => {
  const dir = makeRepo();
  try {
    const full = await gitLogTool.run({ cwd: dir });
    assert.equal(full.ok, true);
    assert.match(full.content, /commit /);
    assert.match(full.content, /Author:/);
    assert.match(full.content, /Tester/);

    const one = await gitLogTool.run({ cwd: dir, oneline: true });
    assert.match(one.content, /^[0-9a-f]{7,} init/);

    const scoped = await gitLogTool.run({ cwd: dir, paths: ["a.js"] });
    assert.match(scoped.content, /commit /);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("GitCommit stages the given paths and reports the hash", async () => {
  const dir = makeRepo();
  try {
    writeFileSync(join(dir, "a.js"), "const a = 5;\nconst b = 2;\n");
    writeFileSync(join(dir, "b.txt"), "unrelated");
    const r = await gitCommitTool.run({ cwd: dir, message: "fix: bump a", paths: ["a.js"] });
    assert.equal(r.ok, true);
    assert.match(r.content, /created commit [0-9a-f]{7,}/);
    assert.match(r.git.hash, /^[0-9a-f]{7,}$/);

    const log = await gitLogTool.run({ cwd: dir, oneline: true });
    assert.match(log.content, /fix: bump a/);

    // b.txt must still be untracked: only the named path was staged.
    const st = await gitStatusTool.run({ cwd: dir });
    assert.equal(st.git.untracked.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("GitCommit refuses an empty message and an empty index", async () => {
  const dir = makeRepo();
  try {
    const emptyMsg = await gitCommitTool.run({ cwd: dir, message: "   " });
    assert.equal(emptyMsg.ok, false);
    assert.match(emptyMsg.content, /message must not be empty/);

    const nothing = await gitCommitTool.run({ cwd: dir, message: "no changes" });
    assert.equal(nothing.ok, false);
    assert.match(nothing.content, /nothing staged/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("parseUnifiedDiff separates metadata from content lines", () => {
  const sample = [
    "diff --git a/x.js b/x.js",
    "index 1234567..89abcde 100644",
    "--- a/x.js",
    "+++ b/x.js",
    "@@ -1,3 +1,4 @@",
    " const one = 1;",
    "-const two = 2;",
    "+const two = 22;",
    "+const three = 3;",
  ].join("\n");

  const files = parseUnifiedDiff(sample);
  assert.equal(files.length, 1);
  assert.equal(files[0].name, "x.js");
  assert.equal(files[0].added, 2);
  assert.equal(files[0].removed, 1);

  const lines = files[0].hunks.flatMap((h) => h.lines);
  const types = lines.map((l) => l.type);
  // The "diff --git" line only opens the file entry; the index / --- / +++
  // lines are metadata, everything after "@@" is content.
  assert.equal(types.filter((t) => t === "meta").length, 3, "index/---/+++");
  assert.equal(lines.filter((l) => l.type === "ctx" && l.text === "const one = 1;").length, 1);
  assert.match(diffSummary(files), /1 file, \+2 \/ -1/);
});

test("diffSummary handles an empty file list", () => {
  assert.equal(diffSummary([]), "(no changes)");
});
