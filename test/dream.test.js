/**
 * The dream task: a quiet pass that tidies project memory.
 *
 * In Claude a dream is not a command — it runs on its own to merge duplicates
 * and prune stale notes (95_chunk-rcj0vzxn.js). The fields that matter are the
 * ones that keep it out of the transcript and let it report progress.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { TASK_TYPES, TASK_TYPE_LIST, TASK_STATUS, registry } from "../src/tasks/registry.js";
import { startDream, setDreamPhase } from "../src/tasks/kinds.js";

test("dream is a known task type", () => {
  assert.ok(TASK_TYPE_LIST.includes("dream"));
  assert.equal(TASK_TYPES.DREAM, "dream");
});

test("a new dream is running and stays out of the transcript", () => {
  const task = startDream({ sessionsReviewing: 3 });
  assert.equal(task.type, TASK_TYPES.DREAM);
  assert.equal(task.status, TASK_STATUS.RUNNING);
  // skipTranscript is what keeps quiet work from polluting the conversation.
  assert.equal(task.meta.skipTranscript, true);
  assert.equal(task.meta.phase, "starting");
  assert.equal(task.meta.sessionsReviewing, 3);
  assert.deepEqual(task.meta.filesTouched, []);
});

test("a phase change is recorded on the task and in its output", () => {
  const task = startDream();
  setDreamPhase(task, "consolidating", ["MYCLAUDE.md"]);
  assert.equal(task.meta.phase, "consolidating");
  assert.deepEqual(task.meta.filesTouched, ["MYCLAUDE.md"]);
  assert.match(task.output, /consolidating/);
});

test("a file is not counted twice", () => {
  // Phases overlap: the same memory file may be touched by more than one.
  const task = startDream();
  setDreamPhase(task, "reading", ["MYCLAUDE.md"]);
  setDreamPhase(task, "consolidating", ["MYCLAUDE.md"]);
  assert.deepEqual(task.meta.filesTouched, ["MYCLAUDE.md"]);
});

test("a dream can be cancelled like any other task", () => {
  let cancelled = 0;
  const task = startDream({ cancel: () => { cancelled++; } });
  registry.cancel(task);
  assert.equal(cancelled, 1);
  assert.equal(task.status, TASK_STATUS.CANCELLED);
});
