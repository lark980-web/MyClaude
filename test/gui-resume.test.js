/**
 * Resuming a conversation must not leave a second copy of it behind.
 *
 * The sidebar showed two entries for one chat. The cause was rotate(): it
 * wrote the conversation once more under the saver's own id before switching
 * to the id of the session being resumed, so the resume left a copy behind.
 * These tests pin the fix.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "myclaude-resume-"));
process.env.MYCLAUDE_HOME = home;
const { startGui } = await import("../src/ui/gui-server.js");
const { listSessions, saveSession, SESSIONS_DIR } = await import("../src/session.js");

async function start() {
  const config = {
    provider: "openai", baseUrl: "http://127.0.0.1:1/v1", apiKey: "k",
    model: "test-model", permissionMode: "auto", maxTurns: 3,
    contextWindow: 100000, compactThreshold: 0.8, vision: true,
  };
  const { server, address } = await startGui({ config, port: 0, open: false });
  return { gui: server, address, config };
}

async function stop(ctx) {
  await new Promise((r) => ctx.gui.close(r));
}

test("resuming a session does not create another session file", async () => {
  const ctx = await start();
  try {
    // A conversation that exists on disk.
    const id = "2026-10-21T09-00-00_abc123";
    saveSession(id, [
      { role: "user", content: "请在项目根目录创建 test-diff-approval.txt" },
      { role: "assistant", content: "创建被拒绝" },
    ], { cwd: process.cwd(), model: "test-model", turnCount: 1 });
    const before = listSessions().length;
    assert.ok(before >= 1, "the session is on disk");

    // Resume it the way the browser does: by id, with its own session key.
    const res = await fetch(ctx.address + "/api/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "resume", id }),
    });
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.id, id, "the resumed session keeps its own id");
    assert.equal(body.messages, 2, "the transcript came back");

    // The bug: a saver left under the browser key wrote the same messages into
    // a second file. Give any pending write a chance to land, then count.
    await new Promise((r) => setTimeout(r, 400));
    const after = listSessions();
    assert.equal(after.length, before, `expected ${before} sessions, found ${after.length}`);
    const same = after.filter((s) => {
      try {
        const d = JSON.parse(readFileSync(join(SESSIONS_DIR, s.id + ".json"), "utf8"));
        return (d.messages || []).length === 2;
      } catch { return false; }
    });
    assert.equal(same.length, 1, "only one file holds this conversation");
  } finally {
    await stop(ctx);
  }
});

test("resuming twice still keeps one session", async () => {
  const ctx = await start();
  try {
    const id = "2026-10-21T09-30-00_def456";
    saveSession(id, [{ role: "user", content: "hello" }], {
      cwd: process.cwd(), model: "test-model", turnCount: 1,
    });
    const before = listSessions().length;
    for (const key of ["tab-1", "tab-2", "default"]) {
      const res = await fetch(ctx.address + "/api/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "resume", id, sessionKey: key }),
      });
      assert.equal((await res.json()).ok, true);
      await new Promise((r) => setTimeout(r, 250));
    }
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(listSessions().length, before, "no extra session files appeared");
  } finally {
    await stop(ctx);
  }
});

test("cleanup", () => {
  rmSync(home, { recursive: true, force: true });
});
