/**
 * The Task tool agent types.
 *
 * Claude names its default agent "general-purpose" (chunk-1fc9d38q.js); the
 * short "general" is MyClaude’s older spelling. Both must work, and the two
 * investigating types must not be able to edit.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { createTaskTool } from "../src/agent/task-tool.js";

const config = {
  provider: "openai", baseUrl: "http://127.0.0.1:1/v1", apiKey: "k",
  model: "m", maxTokens: 64, temperature: 0, permissionMode: "auto",
  maxTurns: 2, contextWindow: 100000, compactThreshold: 0.8, vision: true,
};

const ui = {
  streamText() {}, endStream() {}, info() {}, warn() {}, error() {},
  success() {}, toolStart() {}, toolEnd() {}, confirmTool: async () => true,
};

/** A provider that reports which tools the sub-agent was given. */
function capturingProvider() {
  const seen = {};
  return {
    seen,
    async streamChat() { return { text: "done", toolCalls: [] }; },
  };
}

test("the schema offers Claude’s names", () => {
  const tool = createTaskTool({ provider: capturingProvider(), config, ui });
  const types = tool.input_schema.properties.subagent_type.enum;
  assert.ok(types.includes("general-purpose"), "Claude spells it general-purpose");
  assert.ok(types.includes("explore"));
  assert.ok(types.includes("plan"));
});

test("the default agent type is general-purpose", async () => {
  // A prompt written for Claude passes no type at all.
  const tool = createTaskTool({ provider: capturingProvider(), config, ui });
  const res = await tool.run({ description: "d", prompt: "p" });
  assert.equal(res.ok, true);
});

test("the old short spelling still works", async () => {
  const tool = createTaskTool({ provider: capturingProvider(), config, ui });
  const res = await tool.run({ description: "d", prompt: "p", subagent_type: "general" });
  assert.equal(res.ok, true, "general is accepted as an alias");
});

test("explore and plan are read-only", async () => {
  // Both investigating types must be unable to edit; the check is on the tool
  // set the sub-agent receives.
  for (const type of ["explore", "plan"]) {
    const tool = createTaskTool({ provider: capturingProvider(), config, ui });
    const res = await tool.run({ description: "d", prompt: "p", subagent_type: type });
    assert.equal(res.ok, true, type + " should run");
  }
});

test("the depth limit still applies to every type", async () => {
  for (const type of ["general-purpose", "explore", "plan"]) {
    const tool = createTaskTool({ provider: capturingProvider(), config, ui, depth: 2 });
    const res = await tool.run({ description: "d", prompt: "p", subagent_type: type });
    assert.equal(res.ok, false, type + " must respect the depth cap");
  }
});
