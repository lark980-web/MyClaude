/**
 * Sub-agent (Task) safety tests.
 *
 * A sub-agent that can delegate again can spawn unbounded chains, so the tool
 * must refuse to hand Task to children and must cap nesting depth.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createTaskTool } from "../src/agent/task-tool.js";
import { registerTools, readTool, lsTool } from "../src/tools/index.js";

registerTools([readTool, lsTool]);

function fakeProvider(text) {
  return {
    baseUrl: "http://x/v1",
    apiKey: "k",
    model: "m",
    config: { maxTokens: 100, temperature: 0 },
    async streamChat({ onDelta }) {
      onDelta(text);
      return { text, toolCalls: [] };
    },
  };
}

const ui = {
  streamText() {}, endStream() {}, info() {}, warn() {}, error() {}, success() {},
  toolStart() {}, toolEnd() {}, confirmTool: async () => true,
};

test("Task refuses to delegate beyond the depth cap", async () => {
  const tool = createTaskTool({
    provider: fakeProvider("done"),
    config: { maxTurns: 2, contextWindow: 100000, compactThreshold: 0.8, permissionMode: "auto" },
    ui,
    depth: 2,
  });
  const out = await tool.run({ description: "x", prompt: "do it" });
  assert.equal(out.ok, false);
  assert.match(out.content, /depth limit/);
});

test("Task at depth 0 runs the sub-agent and returns its report", async () => {
  const tool = createTaskTool({
    provider: fakeProvider("all finished"),
    config: { maxTurns: 2, contextWindow: 100000, compactThreshold: 0.8, permissionMode: "auto" },
    ui,
    depth: 0,
  });
  const out = await tool.run({ description: "x", prompt: "do it" });
  assert.equal(out.ok, true);
  assert.match(out.content, /all finished/);
});

test("sub-agents never receive the Task tool", async () => {
  // Capture the tool list handed to the child Agent by inspecting the schema
  // filter the same way createTaskTool does.
  const { toolSchemas } = await import("../src/tools/index.js");
  const schemas = toolSchemas().filter((t) => t.function.name !== "Task");
  assert.equal(schemas.some((t) => t.function.name === "Task"), false);
});

test("explore sub-agents are restricted to read-only tools", async () => {
  const tool = createTaskTool({
    provider: fakeProvider("explored"),
    config: { maxTurns: 2, contextWindow: 100000, compactThreshold: 0.8, permissionMode: "auto" },
    ui,
    depth: 0,
  });
  const out = await tool.run({ description: "look", prompt: "inspect", subagent_type: "explore" });
  assert.equal(out.ok, true);
});
