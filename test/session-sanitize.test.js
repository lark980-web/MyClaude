/**
 * Tool-call pairing repair and stream-interruption retry classification.
 *
 * A run killed between an assistant tool_calls message and its results leaves
 * a history that every OpenAI-compatible endpoint rejects - and because the
 * broken history replays on each resume, the session fails forever. That is
 * the "Error in input stream 持续出现" bug. The sanitizer repairs pairing at
 * load time; the router classifies interrupted streams so a silent retry
 * never duplicates output.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const HOME = mkdtempSync(join(tmpdir(), "myclaude-home-"));
process.env.MYCLAUDE_HOME = HOME;
const { sanitizeToolPairing, loadSession, saveSession } = await import(
  pathToFileURL(join(import.meta.dirname, "..", "src", "session.js")).href
);
const { isRetryable } = await import(
  pathToFileURL(join(import.meta.dirname, "..", "src", "providers", "router.js")).href
);

test("a dangling tool_call at the end gets a synthesized result", () => {
  const msgs = [
    { role: "user", content: "跑一下" },
    { role: "assistant", content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "Bash", arguments: "{}" } }] },
  ];
  const { messages, fixed } = sanitizeToolPairing(msgs);
  assert.equal(fixed, 1);
  assert.equal(messages.length, 3);
  assert.equal(messages[2].role, "tool");
  assert.equal(messages[2].tool_call_id, "c1");
  assert.match(messages[2].content, /已中断/);
});

test("a dangling call mid-history is closed before the next user turn", () => {
  const msgs = [
    { role: "assistant", content: "", tool_calls: [{ id: "a", function: { name: "Read", arguments: "{}" } }, { id: "b", function: { name: "Read", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "a", content: "ok" },
    { role: "user", content: "继续" },
  ];
  const { messages, fixed } = sanitizeToolPairing(msgs);
  assert.equal(fixed, 1);
  assert.equal(messages[2].tool_call_id, "b");
  assert.equal(messages[3].role, "user", "the synthesized result lands before the next user message");
});

test("orphan tool results (call gone) are dropped", () => {
  const msgs = [
    { role: "user", content: "hi" },
    { role: "tool", tool_call_id: "ghost", content: "?" },
    { role: "assistant", content: "你好" },
  ];
  const { messages, fixed } = sanitizeToolPairing(msgs);
  assert.equal(fixed, 1);
  assert.equal(messages.length, 2);
  assert.ok(!messages.some((m) => m.role === "tool"));
});

test("a healthy history passes through untouched", () => {
  const msgs = [
    { role: "user", content: "读文件" },
    { role: "assistant", content: "", tool_calls: [{ id: "x", function: { name: "Read", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "x", content: "内容" },
    { role: "assistant", content: "读完了" },
  ];
  const { messages, fixed } = sanitizeToolPairing(msgs);
  assert.equal(fixed, 0);
  assert.deepEqual(messages, msgs);
});

test("the sanitizer is idempotent", () => {
  const msgs = [
    { role: "assistant", content: "", tool_calls: [{ id: "z", function: { name: "Bash", arguments: "{}" } }] },
  ];
  const once = sanitizeToolPairing(msgs).messages;
  const twice = sanitizeToolPairing(once);
  assert.equal(twice.fixed, 0);
  assert.deepEqual(twice.messages, once);
});

test("loadSession repairs a broken session file on disk", () => {
  const dir = join(HOME, "sessions");
  mkdirSync(dir, { recursive: true });
  const broken = {
    id: "brk1",
    savedAt: new Date().toISOString(),
    messages: [
      { role: "user", content: "继续任务" },
      { role: "assistant", content: "", tool_calls: [{ id: "d1", function: { name: "Bash", arguments: "{}" } }] },
    ],
  };
  writeFileSync(join(dir, "brk1.json"), JSON.stringify(broken), "utf8");
  const loaded = loadSession("brk1");
  assert.equal(loaded.messages.length, 3);
  assert.equal(loaded.messages[2].role, "tool");
  assert.equal(loaded.messages[2].tool_call_id, "d1");
});

test("stream interruption signatures are retryable", () => {
  for (const msg of ["Error in input stream", "stream interrupted: socket hang up", "premature close", "broken pipe", "terminated"]) {
    assert.equal(isRetryable(new Error(msg)), true, msg);
  }
});

test("noRetry marks survive even with a retryable status", () => {
  const e = Object.assign(new Error("stream interrupted: x"), { status: 502 });
  assert.equal(isRetryable(e), true);
  e.noRetry = true;
  assert.equal(isRetryable(e), false, "partial output already streamed: never silently replay");
});
