/**
 * A command that outlives its timeout must not be killed.
 *
 * Killing it threw away the work (a test suite at 90% is not a failure) and
 * the model re-ran the same command until it burned its turns. The child is
 * adopted by the background registry instead, and the tool result says so.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { findTool } from "../src/tools/index.js";
import { readTaskOutput, killAllTasks } from "../src/tools/tasks.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("a timed-out command is promoted to a background task, not killed", async () => {
  const bash = findTool("Bash");
  // ping keeps the process alive ~5s on Windows; timeout after 1.2s.
  const started = Date.now();
  const res = await bash.run({ command: "ping -n 6 127.0.0.1", timeout_ms: 1200 });
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 4000, "the tool must return promptly, not wait for the command");
  assert.ok(res.ok, "a promoted command is not a failure");
  assert.match(res.content, /background task task_/, "result names the adopted task");
  assert.match(res.content, /BashOutput/, "result tells the model how to poll");
  assert.match(res.content, /do NOT re-run/, "result forbids re-running");
  const id = (res.content.match(/task_[a-z0-9]+/) || [])[0];
  assert.ok(id, "task id present");
  // The adopted task must actually finish and keep its output.
  let out = "";
  for (let i = 0; i < 30; i++) {
    await sleep(400);
    const r = await readTaskOutput(id);
    out = typeof r === "string" ? r : (r && (r.output || r.content)) || "";
    if (/finished with exit code/.test(out)) break;
  }
  assert.match(out, /finished with exit code/, "adopted task completes and records its exit");
  killAllTasks();
});

test("a short command still returns inline, unpromoted", async () => {
  const bash = findTool("Bash");
  const res = await bash.run({ command: "echo hello-promote-check", timeout_ms: 30000 });
  assert.ok(res.ok);
  assert.match(res.content, /hello-promote-check/);
  assert.doesNotMatch(res.content, /background task/);
});
