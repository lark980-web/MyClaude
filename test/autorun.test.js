/**
 * Autonomous runs: keep going past the turn cap instead of stopping dead.
 *
 * A 100-turn cap is a fuel gauge, not a finish line - but without a
 * continuation mechanism the run just stops and waits for a human nudge,
 * which is the interruption this feature removes. The guardrails matter as
 * much as the loop: a round cap, a time budget, and an explicit stop must all
 * be able to end it, or this becomes the "looks stuck forever" hazard again.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { Agent } from "../src/agent/agent.js";
import { runWithAutoContinue } from "../src/agent/autorun.js";
import { setAutonomous, askUserQuestionTool } from "../src/tools/extended.js";

function makeUi() {
  return { streamText(){}, endStream(){}, info(){}, warn(){}, error(){}, success(){}, toolStart(){}, toolEnd(){}, confirmTool: async () => true };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeAgent(autoRun, maxTurns, script) {
  const calls = [];
  const tools = [{ name: "Echo", description: "e", input_schema: { type: "object", properties: {} }, run: async () => ({ ok: true, content: "echo" }) }];
  const provider = {
    async streamChat() {
      calls.push(calls.length + 1);
      const step = script[calls.length - 1] || { text: "finished", toolCalls: [] };
      return typeof step === "function" ? step() : step;
    },
    async complete() { return { text: "s" }; },
  };
  const config = { provider: "openai", baseUrl: "http://x/v1", apiKey: "k", model: "m",
    maxTokens: 64, temperature: 0, permissionMode: "auto", maxTurns,
    contextWindow: 100000, compactThreshold: 0.8, vision: true, autoRun };
  const agent = new Agent({ provider, config, ui: makeUi(), tools, sessionKey: "t" });
  return { agent, calls };
}

test("a turn-cap stop is continued until the model finishes", async () => {
  // maxTurns 1: the first run burns its only turn on a tool call and stops.
  const { agent, calls } = makeAgent(true, 1, [
    { text: "", toolCalls: [{ id: "t1", name: "Echo", arguments: {} }] },
    { text: "finished now", toolCalls: [] },
  ]);
  const res = await runWithAutoContinue(agent, { message: "go" }, { ui: makeUi() });
  assert.equal(res.maxTurnsReached, undefined, "the cap stop was replaced by a finish");
  assert.equal(calls.length, 2, "exactly one continuation");
});

test("the checkpoint continues in-loop even without autoRun (upstream has no turn cap)", async () => {
  // 上游主循环没有回合上限：maxTurns 是检查点（压缩后继续），不是终点。
  const { agent, calls } = makeAgent(false, 1, [
    { text: "", toolCalls: [{ id: "t1", name: "Echo", arguments: {} }] },
    { text: "second", toolCalls: [] },
  ]);
  const res = await agent.run("go");
  assert.equal(res.maxTurnsReached, undefined, "the cap checkpoint continued in-loop");
  assert.equal(calls.length, 2, "finished on the turn after the checkpoint");
});

test("the absolute cap (maxTurns * 4) bounds a runaway loop", async () => {
  // 模型永远在调用工具：检查点每轮压缩后继续，直到绝对上限才如实上报
  const agent2calls = [];
  const provider2 = { async streamChat() { agent2calls.push(1); return { text: "", toolCalls: [{ id: "t" + agent2calls.length, name: "Echo", arguments: {} }] }; }, async complete() { return { text: "s" }; } };
  const config = { provider: "openai", baseUrl: "http://x/v1", apiKey: "k", model: "m",
    maxTokens: 64, temperature: 0, permissionMode: "auto", maxTurns: 1,
    contextWindow: 100000, compactThreshold: 0.8, vision: true };
  const agent2 = new Agent({ provider: provider2, config, ui: makeUi(), tools: [{ name: "Echo", description: "e", input_schema: { type: "object", properties: {} }, run: async () => ({ ok: true, content: "x" }) }], sessionKey: "t2" });
  const res = await agent2.run("go");
  assert.equal(agent2calls.length, 4, "hardCap = maxTurns (1) * 4");
  assert.equal(res.maxTurnsReached, true, "honestly reported at the absolute cap");
});

test("the autorun round cap bounds the walk even if the model never finishes", async () => {
  const agent2calls = [];
  const provider2 = { async streamChat() { agent2calls.push(1); return { text: "", toolCalls: [{ id: "t" + agent2calls.length, name: "Echo", arguments: {} }] }; }, async complete() { return { text: "s" }; } };
  const config = { provider: "openai", baseUrl: "http://x/v1", apiKey: "k", model: "m",
    maxTokens: 64, temperature: 0, permissionMode: "auto", maxTurns: 1,
    contextWindow: 100000, compactThreshold: 0.8, vision: true, autoRun: true };
  const agent2 = new Agent({ provider: provider2, config, ui: makeUi(), tools: [{ name: "Echo", description: "e", input_schema: { type: "object", properties: {} }, run: async () => ({ ok: true, content: "x" }) }], sessionKey: "t2" });
  const res = await runWithAutoContinue(agent2, { message: "go" }, { ui: makeUi(), maxRounds: 2 });
  // 每轮 run 内部跑到绝对上限（maxTurns 1 * 4 = 4 次调用），autorun 再续跑 maxRounds 2 轮
  assert.equal(agent2calls.length, 12, "3 runs x hardCap 4 (initial + 2 continuations)");
  assert.equal(res.maxTurnsReached, true, "and then it honestly reports the cap");
});

test("a user stop interrupts a hung continuation", async () => {
  const agent2calls = [];
  const provider = { async streamChat({ signal }) {
    agent2calls.push(1);
    if (agent2calls.length === 1) { return { text: "", toolCalls: [{ id: "t1", name: "Echo", arguments: {} }] }; }
    // The continuation hangs mid-stream until aborted: the exact shape of a
    // real stall that the stop button must be able to break.
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => resolve({ text: "late", toolCalls: [] }), 8000);
      signal.addEventListener("abort", () => { clearTimeout(t); const e = new Error("aborted"); e.name = "AbortError"; reject(e); }, { once: true });
    });
  }, async complete() { return { text: "s" }; } };
  const config = { provider: "openai", baseUrl: "http://x/v1", apiKey: "k", model: "m",
    maxTokens: 1, temperature: 0, permissionMode: "auto", maxTurns: 1,
    contextWindow: 100000, compactThreshold: 0.8, vision: true, autoRun: true };
  const Agent = (await import("../src/agent/agent.js")).Agent;
  const agent = new Agent({ provider, config, ui: makeUi(), tools: [{ name: "Echo", description: "e", input_schema: { type: "object", properties: {} }, run: async () => ({ ok: true, content: "x" }) }], sessionKey: "t" });
  const pr = runWithAutoContinue(agent, { message: "go" }, { ui: makeUi() });
  await sleep(120); // inside the hung continuation
  agent.abort();
  const res = await pr;
  assert.equal(agent2calls.length, 2, "no run beyond the interrupted one");
  assert.equal(res.interrupted, true, "the stop reported an interruption");
});
test("autonomous mode blocks AskUserQuestion instead of stalling", async () => {
  setAutonomous(true);
  try {
    const res = await askUserQuestionTool.run({ questions: [{ question: "which?", header: "Q" }] });
    assert.equal(res.ok, false);
    assert.match(res.content, /自主模式/);
  } finally { setAutonomous(false); }
});
