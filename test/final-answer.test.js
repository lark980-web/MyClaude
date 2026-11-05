/**
 * A run must always end with a readable conclusion.
 *
 * Regression for the two ways the loop used to finish with a blank bubble:
 *  - reasoning-only responses (no `content`) look like a normal done turn;
 *  - a stream error leaves the last visible message as a tool call.
 * Both are repaired by one tool-less closing request from ensureFinalAnswer().
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { Agent } from "../src/agent/agent.js";

function makeUi() {
  return { streamText(){}, endStream(){}, info(){}, warn(){}, error(){}, success(){}, toolStart(){}, toolEnd(){}, confirmTool: async () => true };
}

function makeAgent(script, maxTurns = 10) {
  const calls = [];
  const tools = [{ name: "Echo", description: "e", input_schema: { type: "object", properties: {} }, run: async () => ({ ok: true, content: "echo" }) }];
  const provider = {
    async streamChat() {
      const step = script[calls.length] || { text: "fallback", toolCalls: [] };
      calls.push(calls.length + 1);
      return typeof step === "function" ? step() : step;
    },
    async complete() { return { text: "s" }; },
  };
  const config = { provider: "openai", baseUrl: "http://x/v1", apiKey: "k", model: "m",
    maxTokens: 64, temperature: 0, permissionMode: "auto", maxTurns,
    contextWindow: 100000, compactThreshold: 0.8, vision: true, autoRun: false };
  const agent = new Agent({ provider, config, ui: makeUi(), tools, sessionKey: "t" });
  return { agent, calls };
}

test("a reasoning-only turn (empty body) is followed by a written conclusion", async () => {
  const { agent, calls } = makeAgent([
    { text: "", toolCalls: [] },
    { text: "最终结论：文件已改好，测试通过。", toolCalls: [] },
  ]);
  await agent.run("干活");
  const last = agent.messages[agent.messages.length - 1];
  assert.equal(last.role, "assistant");
  assert.match(last.content, /最终结论/);
  assert.equal(calls.length, 2, "one extra tool-less request was made");
});

test("a run that already ended with text makes no extra request", async () => {
  const { agent, calls } = makeAgent([
    { text: "这就是结论", toolCalls: [] },
    { text: "不该被调用", toolCalls: [] },
  ]);
  await agent.run("干活");
  assert.equal(agent.messages[agent.messages.length - 1].content, "这就是结论");
  assert.equal(calls.length, 1, "no redundant closing request");
});

test("a stream error still produces a conclusion instead of a silent stop", async () => {
  const { agent, calls } = makeAgent([
    () => { throw new Error("stream broken"); },
    { text: "错误后补上的结论：已完成前三步。", toolCalls: [] },
  ]);
  const res = await agent.run("干活");
  assert.ok(res.error, "the original error is still reported");
  assert.match(agent.messages[agent.messages.length - 1].content, /错误后补上的结论/);
});
test("repeated reasoning-only turns end with the reasoning tail, never an empty bubble", async () => {
  const reasoning = "先分析一遍改动范围。\n\n最终结论：两处校验都通过，可以提交。";
  const { agent, calls } = makeAgent([
    { text: "", reasoning, toolCalls: [] },
    { text: "", reasoning, toolCalls: [] },
    { text: "", reasoning, toolCalls: [] },
  ]);
  await agent.run("干活");
  const last = agent.messages[agent.messages.length - 1];
  assert.equal(last.role, "assistant");
  assert.match(last.content, /最终结论/);
  assert.equal(calls.length, 3, "two nudges then the reasoning fallback");
  assert.ok(!agent.messages.some((m) => m.role === "assistant" && !Array.isArray(m.tool_calls) && !String(m.content ?? "").trim()),
    "no empty assistant message is left in history");
});

test("a failed closing request produces a real tool summary, not a placeholder", async () => {
  const { agent, calls } = makeAgent([
    { text: "", toolCalls: [{ id: "t1", name: "Echo", arguments: {} }] },
    { text: "", toolCalls: [] },
    { text: "", toolCalls: [] },
    { text: "", toolCalls: [] },
    () => { throw new Error("stream interrupted: aborted"); },
    () => { throw new Error("stream interrupted: aborted"); },
  ]);
  await agent.run("干活");
  const last = agent.messages[agent.messages.length - 1];
  assert.equal(last.role, "assistant");
  assert.ok(!/再发一句/.test(last.content), "the useless placeholder is gone");
  assert.match(last.content, /1 个工具操作/, "summary counts the executed tools");
  assert.match(last.content, /echo/i, "summary includes the last tool output");
  assert.equal(calls.length, 6, "closing request was retried once");
});

test("source no longer contains the useless placeholder or the 15s self-abort", () => {
  const src = readFileSync(new URL("../src/agent/agent.js", import.meta.url), "utf8");
  assert.ok(!src.includes("再发一句即可让它补上"), "placeholder text removed");
  assert.match(src, /const visible = stripReasoning\(text\)\.trim\(\)/, "loop checks for an empty visible body");
  assert.match(src, /const localAbort = new AbortController\(\)/, "closing request owns its AbortController");
  assert.match(src, /}, 30000\)/, "closing timeout raised to 30s");
});

test("the closing request uses its own AbortController, not the agent's shared one", async () => {
  const { agent } = makeAgent([
    { text: "", toolCalls: [] },
    { text: "", toolCalls: [] },
    { text: "", toolCalls: [] },
    { text: "收尾成功", toolCalls: [] },
  ]);
  // 模拟浏览器刷新触发的 res.close -> agent.abort()：不得打死收尾请求。
  const shared = agent.abortController;
  await agent.run("干活");
  assert.match(agent.messages[agent.messages.length - 1].content, /收尾成功/);
  assert.notEqual(agent.abortController, shared, "shared controller untouched by the closing request");
});
