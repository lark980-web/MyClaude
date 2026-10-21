/**
 * Background sub-agents and the task registry that carries them.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { createTaskTool } from "../src/agent/task-tool.js";
import { taskOutputTool } from "../src/tools/task-output.js";
import { registry, TASK_TYPES, TASK_STATUS } from "../src/tasks/registry.js";

/** A provider that answers with a fixed text and no tool calls. */
function stubProvider(text = "sub-agent report") {
  return {
    async streamChat() {
      return { text, toolCalls: [] };
    },
  };
}

const baseConfig = {
  provider: "openai", baseUrl: "http://127.0.0.1:1/v1", apiKey: "k",
  model: "qoder-cn/gfmodel", maxTokens: 100, temperature: 0,
  permissionMode: "auto", maxTurns: 3, contextWindow: 100000,
  compactThreshold: 0.8, vision: true,
};

const noopUi = {
  streamText() {}, endStream() {}, info() {}, warn() {}, error() {},
  success() {}, toolStart() {}, toolEnd() {}, confirmTool: async () => true,
};

test("a background sub-agent returns a task id right away", async () => {
  const tool = createTaskTool({ provider: stubProvider(), config: baseConfig, ui: noopUi, maxTurns: 2 });
  const res = await tool.run({ description: "research", prompt: "look around", run_in_background: true });
  assert.equal(res.ok, true);
  assert.match(res.content, /task_id|local_agent_/, res.content);
  const id = res.content.match(/local_agent_\d+/)?.[0];
  assert.ok(id, "the task id was handed back");

  // The registry knows about it right away, even though the work is still going.
  const task = registry.get(id);
  assert.ok(task, "the task is registered");
  assert.equal(task.type, TASK_TYPES.LOCAL_AGENT);
  assert.equal(task.label, "research");
});

test("TaskOutput reports the result once the sub-agent is done", async () => {
  const tool = createTaskTool({ provider: stubProvider("the report"), config: baseConfig, ui: noopUi, maxTurns: 2 });
  const started = await tool.run({ description: "research", prompt: "look around", run_in_background: true });
  const id = started.content.match(/local_agent_\d+/)?.[0];

  const out = await taskOutputTool.run({ task_id: id, wait: true, timeout_ms: 5000 });
  assert.equal(out.ok, true);
  assert.match(out.content, /status: completed/, out.content);
  assert.match(out.content, /the report/, out.content);
});

test("TaskOutput says so when a task is still running", async () => {
  const task = registry.create({ type: TASK_TYPES.LOCAL_BASH, label: "sleepy" });
  registry.start(task);
  const out = await taskOutputTool.run({ task_id: task.id });
  assert.match(out.content, /status: running/);
  assert.match(out.content, /still running/);
});

test("TaskOutput reports an unknown task", async () => {
  const out = await taskOutputTool.run({ task_id: "nope_123" });
  assert.equal(out.ok, false);
  assert.match(out.content, /unknown task/);
});

test("a foreground sub-agent still returns its report directly", async () => {
  const tool = createTaskTool({ provider: stubProvider("foreground report"), config: baseConfig, ui: noopUi, maxTurns: 2 });
  const res = await tool.run({ description: "quick", prompt: "answer" });
  assert.equal(res.ok, true);
  assert.match(res.content, /foreground report/);
  assert.ok(!/local_agent_/.test(res.content), "no task id in the foreground path");
});

test("a failing sub-agent is recorded as a failed task", async () => {
  const provider = {
    async streamChat() { throw new Error("provider exploded"); },
  };
  const tool = createTaskTool({ provider, config: baseConfig, ui: noopUi, maxTurns: 2 });
  const started = await tool.run({ description: "doomed", prompt: "x", run_in_background: true });
  const id = started.content.match(/local_agent_\d+/)?.[0];
  await registry.wait(id, { timeout: 5000, pollMs: 20 });
  const task = registry.get(id);
  assert.equal(task.status, TASK_STATUS.FAILED);
  assert.ok(task.error, "the reason was kept");
});
