import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.MYCLAUDE_HOME = mkdtempSync(join(tmpdir(), "myclaude-anth-"));
const { createProvider } = await import("../src/providers/index.js");
const { toAnthropicMessages, toAnthropicTools, AnthropicProvider } = await import("../src/providers/anthropic.js");

test("createProvider dispatches anthropic to the Messages API adapter", () => {
  const p = createProvider({ provider: "anthropic", baseUrl: "https://api.anthropic.com/v1", apiKey: "sk-ant-test", model: "claude-3-7-sonnet" });
  assert.ok(p instanceof AnthropicProvider, "anthropic config yields AnthropicProvider");
});

test("messages convert: system hoisted, tool_use/tool_result round-trip, consecutive user merged", () => {
  const { system, messages } = toAnthropicMessages([
    { role: "system", content: "You are MyClaude." },
    { role: "user", content: "read package.json" },
    { role: "assistant", content: null, tool_calls: [{ id: "tu_1", type: "function", function: { name: "Read", arguments: '{"file_path":"package.json"}' } }] },
    { role: "tool", tool_call_id: "tu_1", content: '{"name":"myclaude"}' },
    { role: "user", content: "[system] nudge" },
  ]);
  assert.equal(system, "You are MyClaude.", "system is a top-level field");
  assert.equal(messages[1].role, "assistant");
  assert.deepEqual(messages[1].content.map(b => b.type), ["tool_use"], "null content yields no empty text block");
  assert.equal(messages[1].content[0].input.file_path, "package.json");
  assert.equal(messages[2].role, "user", "tool results land in a user turn");
  assert.equal(messages[2].content[0].type, "tool_result");
  assert.equal(messages[2].content[0].tool_use_id, "tu_1");
  assert.equal(messages[2].content[1].type, "text", "the nudge merges into the same user turn");
});

test("tool schemas convert to Anthropic input_schema", () => {
  const t = toAnthropicTools([{ type: "function", function: { name: "Read", description: "read file", parameters: { type: "object", properties: {} } } }]);
  assert.equal(t[0].name, "Read");
  assert.equal(t[0].input_schema.type, "object");
});

test("multimodal image parts convert to Anthropic base64 sources", () => {
  const { messages } = toAnthropicMessages([{ role: "user", content: [
    { type: "text", text: "look" },
    { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
  ] }]);
  assert.deepEqual(messages[0].content.map(b => b.type), ["text", "image"]);
  assert.equal(messages[0].content[1].source.media_type, "image/png");
  assert.equal(messages[0].content[1].source.data, "AAAA");
});
