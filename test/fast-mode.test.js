/**
 * Fast mode caps what each request carries.
 *
 * Every turn used to re-send the whole history: with a 366-message session that
 * was ~200k tokens per model call, which is the difference between seconds and
 * minutes per turn. Fast mode instead sends the system prompt plus the most
 * recent slice of history - sliced at a user-message boundary, because a turn
 * always starts with a user message, so every tool_call inside the window keeps
 * its tool result. A window that orphaned a tool result would be rejected by
 * the provider outright.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { Agent } from "../src/agent/agent.js";

function makeUi() {
  return {
    streamText() {}, endStream() {}, info() {}, warn() {}, error() {}, success() {},
    toolStart() {}, toolEnd() {}, confirmTool: async () => true,
  };
}

function makeAgent(fastMode, fastModeMessages) {
  const config = {
    provider: "openai", baseUrl: "http://x/v1", apiKey: "k", model: "m",
    maxTokens: 64, temperature: 0, permissionMode: "auto", maxTurns: 4,
    contextWindow: 100000, compactThreshold: 0.8, vision: true,
    fastMode, fastModeMessages,
  };
  return new Agent({ provider: { async streamChat() {} }, config, ui: makeUi(), sessionKey: "t" });
}

/** A realistic history: 8 plain turns, then a turn with tool calls. */
function longHistory() {
  const msgs = [];
  for (let i = 0; i < 8; i++) {
    msgs.push({ role: "user", content: "question " + i });
    msgs.push({ role: "assistant", content: "answer " + i });
  }
  // A tool turn: the call and its result must never be separated.
  msgs.push({ role: "user", content: "run it" });
  msgs.push({ role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "Bash", arguments: "{}" } }] });
  msgs.push({ role: "tool", tool_call_id: "c1", content: "ok" });
  msgs.push({ role: "assistant", content: "done" });
  return msgs;
}

test("fast mode off sends the whole history", () => {
  const agent = makeAgent(false, 8);
  agent.messages = longHistory();
  const req = agent.buildRequestMessages();
  assert.equal(req.length, 1 + agent.messages.length, "system + every message");
});

test("fast mode bounds the request and starts on a user message", () => {
  const agent = makeAgent(true, 6);
  agent.messages = longHistory();
  const req = agent.buildRequestMessages();
  assert.equal(req[0].role, "system");
  assert.ok(req.length - 1 <= 6, "carries " + (req.length - 1) + " history messages, cap is 6");
  assert.equal(req[1].role, "user", "the window begins at a turn boundary");
});

test("no tool result is orphaned inside the window", () => {
  const agent = makeAgent(true, 3);
  agent.messages = longHistory();
  const req = agent.buildRequestMessages().slice(1);
  const callIds = new Set();
  for (const m of req) {
    if (m.role === "assistant" && m.tool_calls) { for (const c of m.tool_calls) { callIds.add(c.id); } }
  }
  for (const m of req) {
    if (m.role === "tool") {
      assert.ok(callIds.has(m.tool_call_id), "tool result for " + m.tool_call_id + " lost its call");
    }
  }
});

test("a short history is sent whole even in fast mode", () => {
  const agent = makeAgent(true, 24);
  agent.messages = longHistory();
  const req = agent.buildRequestMessages();
  assert.equal(req.length, 1 + agent.messages.length);
});

test("the window never begins mid-turn", () => {
  const agent = makeAgent(true, 2);
  agent.messages = longHistory();
  const req = agent.buildRequestMessages().slice(1);
  assert.equal(req[0].role, "user", "even a tiny window starts at a user message");
});
