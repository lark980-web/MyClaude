import test from "node:test";
import assert from "node:assert/strict";

import { Agent } from "../src/agent/agent.js";
import { createTaskTool } from "../src/agent/task-tool.js";

/** Minimal UI stub: the agent only calls these for side effects. */
function makeUi() {
  return {
    streamText() {}, endStream() {}, info() {}, warn() {}, error() {}, success() {},
    toolStart() {}, toolEnd() {}, confirmTool: async () => true,
  };
}

function makeConfig(overrides = {}) {
  return {
    provider: "openai", baseUrl: "http://x/v1", apiKey: "k", model: "qoder-cn/gfmodel",
    maxTokens: 100, temperature: 0, permissionMode: "auto", maxTurns: 8,
    contextWindow: 100000, compactThreshold: 0.8, vision: true,
    ...overrides,
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("Task calls issued in one turn run concurrently, not one by one", async () => {
  // Each sub-agent call sleeps 300ms. Three of them sequentially would need
  // 900ms; concurrent execution finishes in a little over 300ms.
  const SLOW = 300;
  let calls = 0;
  // Execution windows of the three sub-agents: [start, end] pairs.
  // Overlapping windows prove concurrency regardless of machine load.
  const windows = [];

  const provider = {
    async streamChat({ messages, system }) {
      calls++;
      // The parent asks for three Task calls in a single assistant turn.
      if (calls === 1) {
        return {
          text: "",
          toolCalls: [
            { id: "t1", name: "Task", arguments: { description: "one", prompt: "alpha", subagent_type: "explore" } },
            { id: "t2", name: "Task", arguments: { description: "two", prompt: "beta", subagent_type: "explore" } },
            { id: "t3", name: "Task", arguments: { description: "three", prompt: "gamma", subagent_type: "explore" } },
          ],
        };
      }
      // Sub-agent turns: delay, then answer with the prompt echoed back so the
      // test can prove results were not mixed up.
      // Only the sub-agents delay. The parent agent's follow-up turn has to
      // answer at once, otherwise it would add another SLOW to the total and
      // hide whether the three Task calls really ran at the same time.
      // The system prompt travels inside messages (role: "system"), not as a
      // separate system argument — the OpenAI provider's streamChat destructures
      // { messages, tools, ... } with no system field. Match on the message list.
      const isSubAgent = (messages || []).some(
        (m) => m && m.role === "system" && /Sub-agent mode/.test(String(m.content || ""))
      );
      if (isSubAgent) {
        const t0 = Date.now();
        await sleep(SLOW);
        windows.push([t0, Date.now()]);
      }
      const last = messages[messages.length - 1];
      const content = typeof last.content === "string" ? last.content : "?";
      const tag = /alpha/.test(content) ? "ALPHA" : /beta/.test(content) ? "BETA" : "GAMMA";
      return { text: tag, toolCalls: [] };
    },
  };

  const config = makeConfig();
  const ui = makeUi();

  // Build the Task tool the same way runtime.js does.
  const taskTool = createTaskTool({ provider, config, ui, maxTurns: 3, depth: 0 });
  const tools = [
    {
      type: "function",
      function: {
        name: "Task",
        description: taskTool.description,
        parameters: taskTool.input_schema,
      },
    },
  ];

  const agent = new Agent({ provider, config, ui, tools });
  // The agent resolves tools through the registry, so register this instance.
  const { registerTools } = await import("../src/tools/index.js");
  registerTools([taskTool]);

  const started = Date.now();
  await agent.run("split the work");
  const elapsed = Date.now() - started;

  // Concurrency proof, load-independent: the three sub-agent execution
  // windows must share a common overlap. Sequential dispatch would leave
  // them disjoint (each ends before the next starts).
  assert.equal(windows.length, 3, "three sub-agent executions recorded");
  const starts = windows.map((w) => w[0]);
  const ends = windows.map((w) => w[1]);
  assert.ok(
    Math.max(...starts) < Math.min(...ends),
    `sub-agent execution windows do not overlap (serial dispatch?): ` +
      JSON.stringify(windows.map((w) => [w[0] - started, w[1] - started]))
  );
  // Sanity upper bound only (guards against a hang, not a concurrency proof).
  assert.ok(elapsed < 30_000, `test took ${elapsed}ms; something hung`);

  // Every sub-agent result must be present and distinct.
  const toolMessages = agent.messages.filter((m) => m.role === "tool").map((m) => String(m.content));
  assert.equal(toolMessages.length, 3, "one tool result per Task call");
  assert.ok(toolMessages.some((t) => /ALPHA/.test(t)), "first sub-agent result present");
  assert.ok(toolMessages.some((t) => /BETA/.test(t)), "second sub-agent result present");
  assert.ok(toolMessages.some((t) => /GAMMA/.test(t)), "third sub-agent result present");
});

test("Task refuses to recurse past the depth limit", async () => {
  const provider = { async streamChat() { return { text: "", toolCalls: [] }; } };
  const tool = createTaskTool({ provider, config: makeConfig(), ui: makeUi(), depth: 2 });
  const r = await tool.run({ description: "deep", prompt: "go deeper" });
  assert.equal(r.ok, false);
  assert.match(r.content, /depth limit/i);
});
