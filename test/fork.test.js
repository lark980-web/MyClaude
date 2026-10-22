/**
 * Forking a session (/fork, /branch).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

process.env.MYCLAUDE_HOME = mkdtempSync(join(process.env.TEMP || ".", "fork-"));
const { saveSession, loadSession, forkSession, listSessions, sessionFile } = await import("../src/session.js");

test("a fork copies the history into a new session", () => {
  const id = "2026-10-23T20-00-00_aaa111";
  const msgs = [
    { role: "user", content: "第一条" },
    { role: "assistant", content: "第一条回复" },
  ];
  saveSession(id, msgs, { cwd: process.cwd() });
  const res = forkSession(id);
  assert.equal(res.ok, true);
  assert.notEqual(res.id, id, "the fork gets its own id");
  assert.equal(res.messages, 2);

  const forked = loadSession(res.id);
  assert.deepEqual(forked.messages, msgs, "the history is copied verbatim");
  assert.equal(forked.forkedFrom, id, "the fork records where it came from");
});

test("the original session is untouched", () => {
  const id = "2026-10-23T20-10-00_bbb222";
  saveSession(id, [{ role: "user", content: "原会话" }], { cwd: process.cwd() });
  const before = loadSession(id).messages.length;
  forkSession(id);
  assert.equal(loadSession(id).messages.length, before, "original unchanged");
});

test("forking an unknown session fails", () => {
  const res = forkSession("no-such-session");
  assert.equal(res.ok, false);
  assert.match(res.error, /no such session/);
});

test("forking an empty session is refused", () => {
  // A fork with no history would look exactly like a fresh chat.
  const id = "2026-10-23T20-20-00_ccc333";
  saveSession(id, [{ role: "user", content: "x" }], { cwd: process.cwd() });
  // Remove the messages to simulate an empty session file.
  writeFileSync(sessionFile(id), JSON.stringify({ id, messages: [] }), "utf8");
  const res = forkSession(id);
  assert.equal(res.ok, false);
  assert.match(res.error, /no history/);
});

test("a fork can be named at creation", () => {
  const id = "2026-10-23T20-30-00_ddd444";
  saveSession(id, [{ role: "user", content: "起点" }], { cwd: process.cwd() });
  const res = forkSession(id, { title: "方案二" });
  assert.equal(res.ok, true);
  assert.equal(loadSession(res.id).title, "方案二");
});

test("both branches show up in the session list", () => {
  const id = "2026-10-23T20-40-00_eee555";
  saveSession(id, [{ role: "user", content: "分叉点" }], { cwd: process.cwd() });
  const res = forkSession(id);
  const ids = listSessions().map((s) => s.id);
  assert.ok(ids.includes(id), "original listed");
  assert.ok(ids.includes(res.id), "fork listed");
});
