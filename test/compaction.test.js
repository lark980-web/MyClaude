/**
 * The compaction guarantee behind the slowness fix.
 *
 * The user ran a 1M-token window where the compact threshold was never
 * reachable, so every turn re-sent the whole 200k-token history. The window
 * is now capped by config (128000 in their config.json), which only helps if
 * compaction actually fires when the cap is crossed - that is what these
 * tests pin. estimateTokens is CJK-aware, so filler text is ASCII to keep the
 * arithmetic predictable (~4 chars per token).
 */
import test from "node:test";
import assert from "node:assert/strict";

import { Agent } from "../src/agent/agent.js";

function makeUi() {
  return { streamText(){}, endStream(){}, info(){}, warn(){}, error(){}, success(){}, toolStart(){}, toolEnd(){}, confirmTool: async () => true };
}

function makeConfig(contextWindow) {
  return { provider: "openai", baseUrl: "http://x/v1", apiKey: "k", model: "m",
    maxTokens: 64, temperature: 0, permissionMode: "auto", maxTurns: 4,
    contextWindow, compactThreshold: 0.8, vision: true };
}

const filler = "lorem ipsum dolor sit amet ".repeat(40); // ~1100 chars
function fatHistory() {
  const msgs = [];
  for (let i = 0; i < 6; i++) {
    msgs.push({ role: "user", content: "q" + i + " " + filler });
    msgs.push({ role: "assistant", content: "a" + i + " " + filler });
  }
  return msgs;
}

test("history past the cap is compacted with a model summary", async () => {
  let completeCalls = 0;
  const provider = {
    async streamChat() { return { text: "", toolCalls: [] }; },
    async complete() { completeCalls++; return { text: "the brief of earlier work: the user asked to read three files, decisions were recorded, key paths noted, nothing is pending" }; },
  };
  const agent = new Agent({ provider, config: makeConfig(1000), ui: makeUi(), sessionKey: "t" });
  agent.messages = fatHistory();
  const before = agent.messages.length;
  const res = await agent.maybeCompact();
  assert.ok(res, "compaction ran");
  assert.equal(res.summarised, true, "the summary path was used");
  assert.ok(res.dropped > 0, "earlier messages were dropped");
  assert.ok(agent.messages.length < before, "history shrank");
  assert.match(agent.messages[0].content, /\[earlier conversation summarised/);
  assert.match(agent.messages[0].content, /the brief of earlier work/);
  assert.equal(completeCalls, 1, "the summary came from one completion");
});

test("history under the cap is left alone", async () => {
  let completeCalls = 0;
  const provider = {
    async streamChat() { return { text: "", toolCalls: [] }; },
    async complete() { completeCalls++; return { text: "s" }; },
  };
  const agent = new Agent({ provider, config: makeConfig(100000), ui: makeUi(), sessionKey: "t" });
  agent.messages = fatHistory();
  const res = await agent.maybeCompact();
  assert.equal(res, null, "no compaction under the threshold");
  assert.equal(completeCalls, 0);
  assert.equal(agent.messages.length, fatHistory().length);
});

test("a failed summary falls back to truncation, not an error", async () => {
  const provider = {
    async streamChat() { return { text: "", toolCalls: [] }; },
    async complete() { throw new Error("summary backend down"); },
  };
  const agent = new Agent({ provider, config: makeConfig(1000), ui: makeUi(), sessionKey: "t" });
  agent.messages = fatHistory();
  const res = await agent.maybeCompact();
  assert.ok(res, "truncation still compacts");
  assert.equal(res.summarised, false);
  assert.match(agent.messages[0].content, /\[context compacted: \d+ earlier messages removed\]/);
});
