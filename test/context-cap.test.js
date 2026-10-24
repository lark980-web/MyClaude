/**
 * The context window is min(catalogue, config).
 *
 * The gateway advertises 1M for the model the user runs, and the agent used to
 * take the catalogue value unconditionally - so config.contextWindow was dead
 * text, compaction never fired, and every turn re-sent a 200k-token history.
 * The config value is now a cap the user can tighten.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { Agent } from "../src/agent/agent.js";
import { contextWindowOf } from "../src/models.js";

function makeUi() {
  return {
    streamText() {}, endStream() {}, info() {}, warn() {}, error() {}, success() {},
    toolStart() {}, toolEnd() {}, confirmTool: async () => true,
  };
}

function agentWith(contextWindow) {
  const config = {
    provider: "openai", baseUrl: "http://x/v1", apiKey: "k", model: "m",
    maxTokens: 64, temperature: 0, permissionMode: "auto", maxTurns: 4,
    compactThreshold: 0.8, vision: true,
  };
  if (contextWindow !== undefined) { config.contextWindow = contextWindow; }
  return new Agent({ provider: { async streamChat() {} }, config, ui: makeUi(), sessionKey: "t" });
}

test("a configured cap below the catalogue wins", () => {
  assert.equal(agentWith(50000).contextWindow, 50000);
});

test("the catalogue stays the ceiling for a wide cap", () => {
  const catalogue = contextWindowOf("m");
  const agent = agentWith(99_000_000);
  assert.equal(agent.contextWindow, catalogue, "a huge config value cannot exceed the model");
});

test("no config value falls back to the catalogue", () => {
  assert.equal(agentWith(undefined).contextWindow, contextWindowOf("m"));
});
