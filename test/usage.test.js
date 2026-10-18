/**
 * Token usage accounting.
 *
 * The counters must reflect what the endpoint reports and must stay at zero
 * when it reports nothing — guessing usage and presenting it as real would be
 * worse than showing nothing.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { OpenAIProvider } from "../src/providers/openai.js";
import { Agent } from "../src/agent/agent.js";

/** Minimal OpenAI-compatible SSE backend. */
function backend({ usage }) {
  const state = { bodies: [] };
  const server = createServer((req, res) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      state.bodies.push(JSON.parse(data || "{}"));
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write("data: " + JSON.stringify({ choices: [{ delta: { content: "hello" } }] }) + "\n\n");
      if (usage) {
        res.write("data: " + JSON.stringify({ choices: [], usage }) + "\n\n");
      }
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  return { server, state };
}

async function listen(server) {
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return "http://127.0.0.1:" + server.address().port + "/v1";
}

const ui = {
  streamText() {}, endStream() {}, info() {}, warn() {}, error() {}, success() {},
  toolStart() {}, toolEnd() {}, confirmTool: async () => true,
};

const baseConfig = {
  provider: "openai", apiKey: "k", model: "m",
  maxTokens: 100, temperature: 0, permissionMode: "auto",
  maxTurns: 4, contextWindow: 100000, compactThreshold: 0.8, vision: true,
};

test("streamChat reports usage when the endpoint sends it", async () => {
  const b = backend({ usage: { prompt_tokens: 120, completion_tokens: 34, total_tokens: 154 } });
  const baseUrl = await listen(b.server);
  try {
    const provider = new OpenAIProvider({ ...baseConfig, baseUrl });
    const out = await provider.streamChat({ messages: [{ role: "user", content: "hi" }], tools: [] });
    assert.equal(out.text, "hello");
    assert.equal(out.usage.promptTokens, 120);
    assert.equal(out.usage.completionTokens, 34);
    // The request must opt into the usage chunk.
    assert.equal(b.state.bodies[0].stream_options.include_usage, true);
  } finally {
    await new Promise((r) => b.server.close(r));
  }
});

test("usage stays null when the endpoint never reports it", async () => {
  const b = backend({});
  const baseUrl = await listen(b.server);
  try {
    const provider = new OpenAIProvider({ ...baseConfig, baseUrl });
    const out = await provider.streamChat({ messages: [{ role: "user", content: "hi" }], tools: [] });
    assert.equal(out.usage, null);
  } finally {
    await new Promise((r) => b.server.close(r));
  }
});

test("Agent accumulates reported tokens across turns", async () => {
  const b = backend({ usage: { prompt_tokens: 50, completion_tokens: 7, total_tokens: 57 } });
  const baseUrl = await listen(b.server);
  try {
    const provider = new OpenAIProvider({ ...baseConfig, baseUrl });
    const agent = new Agent({ provider, config: { ...baseConfig, baseUrl }, ui, tools: [] });
    await agent.run("first");
    await agent.run("second");
    assert.equal(agent.totalInputTokens, 100, "two turns of 50 prompt tokens");
    assert.equal(agent.totalOutputTokens, 14);
  } finally {
    await new Promise((r) => b.server.close(r));
  }
});

test("counters remain zero rather than being guessed", async () => {
  const b = backend({});
  const baseUrl = await listen(b.server);
  try {
    const provider = new OpenAIProvider({ ...baseConfig, baseUrl });
    const agent = new Agent({ provider, config: { ...baseConfig, baseUrl }, ui, tools: [] });
    await agent.run("hi");
    assert.equal(agent.totalInputTokens, 0);
    assert.equal(agent.totalOutputTokens, 0);
  } finally {
    await new Promise((r) => b.server.close(r));
  }
});
