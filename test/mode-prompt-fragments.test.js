/**
 * Mode-specific system prompt fragments.
 *
 * Plan mode has always injected its instructions into the system prompt; full
 * access mode does the same for autonomy. These tests lock the behaviour so a
 * future prompt edit cannot silently drop it.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { Agent } from "../src/agent/agent.js";

const provider = { baseUrl: "http://x/v1", apiKey: "k", model: "m", config: {}, async streamChat() { return { text: "ok", toolCalls: [] }; } };

function promptFor(permissionMode) {
  const ui = {
    streamText() {}, endStream() {}, info() {}, warn() {}, error() {}, success() {},
    toolStart() {}, toolEnd() {}, confirmTool: async () => false,
  };
  const config = { provider: "openai", baseUrl: "http://x/v1", apiKey: "k", model: "m",
    maxTokens: 100, temperature: 0, permissionMode, maxTurns: 4, contextWindow: 100000, compactThreshold: 0.8, vision: true };
  const agent = new Agent({ provider, config, ui, tools: [] });
  return agent.buildSystemPrompt();
}

test("full access mode injects the autonomy fragment", () => {
  const p = promptFor("fullAccess");
  assert.match(p, /# Full access mode/);
  assert.match(p, /pre-approved/);
  assert.match(p, /do not ask for permission/);
});

test("ordinary modes do not carry the full-access fragment", () => {
  for (const mode of ["ask", "acceptEdits", "auto", "dontAsk", "bypassPermissions"]) {
    assert.ok(!promptFor(mode).includes("# Full access mode"), mode + " must not claim full access");
  }
});

test("plan mode still injects its own instructions", () => {
  const p = promptFor("plan");
  assert.match(p, /# Plan mode/);
  assert.ok(!p.includes("# Full access mode"));
});

test("switching to fullAccess at runtime rebuilds the prompt", () => {
  const ui = { streamText() {}, endStream() {}, info() {}, warn() {}, error() {}, success() {}, toolStart() {}, toolEnd() {}, confirmTool: async () => false };
  const config = { provider: "openai", baseUrl: "http://x/v1", apiKey: "k", model: "m",
    maxTokens: 100, temperature: 0, permissionMode: "ask", maxTurns: 4, contextWindow: 100000, compactThreshold: 0.8, vision: true };
  const agent = new Agent({ provider, config, ui, tools: [] });
  assert.ok(!agent.buildSystemPrompt().includes("# Full access mode"));
  agent.setMode("fullAccess");
  assert.match(agent.buildSystemPrompt(), /# Full access mode/);
});
