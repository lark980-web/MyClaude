/**
 * Naming a session.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

process.env.MYCLAUDE_HOME = mkdtempSync(join(process.env.TEMP || ".", "title-"));
const { saveSession, loadSession, setSessionTitle, listSessions } = await import("../src/session.js");

const scratch = () => mkdtempSync(join(process.env.TEMP || ".", "t-"));

test("naming a session that already has messages", () => {
  const id = "2026-10-23T10-00-00_aaa111";
  saveSession(id, [{ role: "user", content: "hello" }], { cwd: process.cwd() });
  assert.equal(setSessionTitle(id, "我的会话"), true);
  assert.equal(loadSession(id).title, "我的会话");
  // Messages must survive the rename.
  assert.equal(loadSession(id).messages.length, 1);
});

test("naming a session that has no file yet creates it", () => {
  // Naming before chatting is legitimate; the title is the reason to keep it.
  const id = "2026-10-23T11-00-00_bbb222";
  assert.equal(setSessionTitle(id, "提前命名"), true);
  assert.equal(loadSession(id).title, "提前命名");
  assert.deepEqual(loadSession(id).messages, []);
});

test("a title longer than 120 characters is capped", () => {
  const id = "2026-10-23T12-00-00_ccc333";
  const long = "x".repeat(300);
  setSessionTitle(id, long);
  assert.equal(loadSession(id).title.length, 120);
});

test("a named empty session shows up in the list", () => {
  // The sidebar reads listSessions, so a title-only session must appear.
  const id = "2026-10-23T13-00-00_ddd444";
  setSessionTitle(id, "空会话也有名字");
  const row = listSessions().find((s) => s.id === id);
  assert.ok(row, "the named session is listed");
  assert.equal(row.title, "空会话也有名字");
});

test("an empty title clears the name", () => {
  const id = "2026-10-23T14-00-00_eee555";
  setSessionTitle(id, "临时");
  assert.equal(loadSession(id).title, "临时");
  setSessionTitle(id, "");
  assert.equal(loadSession(id).title, null);
});
