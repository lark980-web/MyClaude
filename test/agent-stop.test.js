/**
 * Stop must win, wherever the run currently is.
 *
 * Two gaps let the stop button do nothing:
 *   - the provider dropped the abort once headers arrived (provider-stream tests),
 *   - the agent built a fresh AbortController every turn, so an abort that
 *     landed during a tool run was silently discarded and the task carried on.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { Agent } from "../src/agent/agent.js";
import { registerTools } from "../src/tools/index.js";

function makeUi() {
  return {
    streamText() {}, endStream() {}, info() {}, warn() {}, error() {}, success() {},
    toolStart() {}, toolEnd() {}, confirmTool: async () => true,
  };
}

function makeConfig() {
  return {
    provider: "openai", baseUrl: "http://x/v1", apiKey: "k", model: "m",
    maxTokens: 64, temperature: 0, permissionMode: "auto", maxTurns: 6,
    contextWindow: 100000, compactThreshold: 0.8, vision: true,
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The agent resolves tools from the global registry, not from its constructor
// argument, so the slow tool has to be registered the way runtime.js does it.
const slowTool = {
  name: "Slow",
  description: "a tool that takes a while",
  input_schema: { type: "object", properties: {} },
  run: async () => { await sleep(500); return { ok: true, content: "slow done" }; },
};
registerTools([slowTool]);

test("abort during a tool run stops the run at the next turn boundary", async () => {
  const calls = [];
  const provider = {
    async streamChat() {
      calls.push(Date.now());
      if (calls.length === 1) {
        return { text: "", toolCalls: [{ id: "t1", name: "Slow", arguments: {} }] };
      }
      return { text: "second turn ran", toolCalls: [] };
    },
  };
  const agent = new Agent({ provider, config: makeConfig(), ui: makeUi(), sessionKey: "t" });
  const p = agent.run("go");
  await sleep(120); // the tool is in flight
  agent.abort();
  const res = await p;
  assert.equal(res.interrupted, true, "the run reports an interruption");
  assert.equal(calls.length, 1, "the second model call never happened");
});

test("abort during the model stream interrupts immediately", async () => {
  const provider = {
    async streamChat({ signal }) {
      await new Promise((resolve, reject) => {
        const t = setTimeout(() => resolve({ text: "late", toolCalls: [] }), 8000);
        signal.addEventListener("abort", () => {
          clearTimeout(t);
          const e = new Error("aborted");
          e.name = "AbortError";
          reject(e);
        }, { once: true });
      });
    },
  };
  const agent = new Agent({ provider, config: makeConfig(), ui: makeUi(), sessionKey: "t" });
  const p = agent.run("go");
  await sleep(120);
  const t0 = Date.now();
  agent.abort();
  const res = await p;
  assert.equal(res.interrupted, true);
  assert.ok(Date.now() - t0 < 2000, "stop took effect immediately, not after the fake generation");
});
