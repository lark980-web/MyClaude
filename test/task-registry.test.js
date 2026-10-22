/**
 * The task registry.
 *
 * Every kind of long-running job goes through this, so the lifecycle has to
 * hold for all of them: one way to start, one way to finish, one way to
 * cancel, and one place to ask what is going on.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  TaskRegistry,
  TASK_TYPES,
  TASK_STATUS,
  isTerminal,
  isActive,
} from "../src/tasks/registry.js";

test("a new task starts out pending", () => {
  const reg = new TaskRegistry();
  const t = reg.create({ type: TASK_TYPES.LOCAL_BASH, label: "npm test" });
  assert.equal(t.status, TASK_STATUS.PENDING);
  assert.equal(t.type, "local_bash");
  assert.equal(t.label, "npm test");
  assert.equal(t.output, "");
  assert.equal(t.error, null);
  assert.ok(isActive(t.status));
  assert.ok(!isTerminal(t.status));
});

test("an unknown task type is refused", () => {
  const reg = new TaskRegistry();
  assert.throws(() => reg.create({ type: "nonsense" }), /unknown task type/);
});

test("ids are unique per type", () => {
  const reg = new TaskRegistry();
  const a = reg.create({ type: TASK_TYPES.LOCAL_BASH });
  const b = reg.create({ type: TASK_TYPES.LOCAL_BASH });
  const c = reg.create({ type: TASK_TYPES.LOCAL_AGENT });
  assert.notEqual(a.id, b.id);
  assert.notEqual(a.id, c.id);
  assert.match(a.id, /^local_bash_/);
  assert.match(c.id, /^local_agent_/);
});

test("a task runs, produces output and completes", () => {
  const reg = new TaskRegistry();
  const t = reg.create({ type: TASK_TYPES.LOCAL_AGENT });
  reg.start(t);
  assert.equal(t.status, TASK_STATUS.RUNNING);
  assert.ok(t.startedAt);
  reg.appendOutput(t, "hello\n");
  reg.appendOutput(t, "world\n");
  assert.equal(t.output, "hello\nworld\n");
  reg.complete(t, { answer: 42 });
  assert.equal(t.status, TASK_STATUS.COMPLETED);
  assert.deepEqual(t.result, { answer: 42 });
  assert.ok(t.finishedAt);
  assert.ok(isTerminal(t.status));
});

test("a failed task keeps the reason", () => {
  const reg = new TaskRegistry();
  const t = reg.create({ type: TASK_TYPES.MCP_TASK });
  reg.start(t);
  reg.fail(t, new Error("connection refused"));
  assert.equal(t.status, TASK_STATUS.FAILED);
  assert.equal(t.error, "connection refused");
});

test("cancelling runs the task hook and records the state", () => {
  const reg = new TaskRegistry();
  const t = reg.create({ type: TASK_TYPES.MONITOR_MCP });
  reg.start(t);
  let called = 0;
  t.cancel = () => { called++; };
  const res = reg.cancel(t);
  assert.equal(res.ok, true);
  assert.equal(called, 1);
  assert.equal(t.status, TASK_STATUS.CANCELLED);
});

test("a finished task cannot be cancelled again", () => {
  const reg = new TaskRegistry();
  const t = reg.create({ type: TASK_TYPES.LOCAL_BASH });
  reg.start(t);
  reg.complete(t);
  let called = 0;
  t.cancel = () => { called++; };
  const res = reg.cancel(t);
  assert.equal(res.ok, true);
  assert.equal(res.note, "already finished");
  assert.equal(called, 0, "the hook did not run");
  assert.equal(t.status, TASK_STATUS.COMPLETED, "the state did not change");
});

test("the output buffer is capped and keeps the newest text", () => {
  const reg = new TaskRegistry();
  const t = reg.create({ type: TASK_TYPES.LOCAL_BASH });
  for (let i = 0; i < 500; i++) { reg.appendOutput(t, "x".repeat(1000)); }
  assert.ok(t.output.length <= 200000, `buffer stayed bounded: ${t.output.length}`);
  assert.ok(t.output.length > 0);
});

test("listeners hear about every step", () => {
  const reg = new TaskRegistry();
  const seen = [];
  const off = reg.on((e) => seen.push(e.type));
  const t = reg.create({ type: TASK_TYPES.LOCAL_BASH });
  reg.start(t);
  reg.appendOutput(t, "x");
  reg.complete(t);
  assert.deepEqual(seen, ["created", "started", "output", "completed"]);
  off();
  reg.appendOutput(t, "y");
  assert.equal(seen.length, 4, "the listener was removed");
});

test("a broken listener does not stop the others", () => {
  const reg = new TaskRegistry();
  const seen = [];
  reg.on(() => { throw new Error("boom"); });
  reg.on(() => seen.push("ok"));
  reg.create({ type: TASK_TYPES.LOCAL_BASH });
  assert.deepEqual(seen, ["ok"]);
});

test("list filters by type and status", () => {
  const reg = new TaskRegistry();
  const a = reg.create({ type: TASK_TYPES.LOCAL_BASH });
  const b = reg.create({ type: TASK_TYPES.LOCAL_AGENT });
  reg.start(a); reg.complete(a);
  assert.equal(reg.list({ type: TASK_TYPES.LOCAL_BASH }).length, 1);
  assert.equal(reg.list({ status: TASK_STATUS.COMPLETED }).length, 1);
  assert.equal(reg.list({ status: TASK_STATUS.PENDING }).length, 1);
  assert.equal(reg.list().length, 2);
  assert.equal(b.status, TASK_STATUS.PENDING);
});

test("clearFinished keeps what is still running", () => {
  const reg = new TaskRegistry();
  const a = reg.create({ type: TASK_TYPES.LOCAL_BASH });
  const b = reg.create({ type: TASK_TYPES.LOCAL_BASH });
  reg.start(a); reg.complete(a); reg.start(b);
  reg.clearFinished();
  assert.equal(reg.get(a.id), null);
  assert.ok(reg.get(b.id));
});

test("wait returns when the task finishes", async () => {
  const reg = new TaskRegistry();
  const t = reg.create({ type: TASK_TYPES.LOCAL_BASH });
  reg.start(t);
  setTimeout(() => reg.complete(t, "done"), 30);
  const done = await reg.wait(t.id, { timeout: 2000, pollMs: 10 });
  assert.equal(done.status, TASK_STATUS.COMPLETED);
  assert.equal(done.result, "done");
});

test("wait gives up on a task that never finishes", async () => {
  const reg = new TaskRegistry();
  const t = reg.create({ type: TASK_TYPES.LOCAL_BASH });
  reg.start(t);
  const done = await reg.wait(t.id, { timeout: 60, pollMs: 10 });
  assert.equal(done.status, TASK_STATUS.RUNNING);
});

test("cancelAll stops everything that is still running", () => {
  const reg = new TaskRegistry();
  const a = reg.create({ type: TASK_TYPES.LOCAL_BASH });
  const b = reg.create({ type: TASK_TYPES.LOCAL_AGENT });
  reg.start(a); reg.start(b);
  reg.cancelAll();
  assert.equal(a.status, TASK_STATUS.CANCELLED);
  assert.equal(b.status, TASK_STATUS.CANCELLED);
});
