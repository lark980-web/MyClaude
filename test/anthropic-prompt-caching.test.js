import test from "node:test";
import assert from "node:assert/strict";
import { AnthropicProvider } from "../src/providers/anthropic.js";

function makeProvider(extra = {}) {
  return new AnthropicProvider({ provider: "anthropic", baseUrl: "https://api.anthropic.com/v1", apiKey: "k", model: "m", maxTokens: 4096, ...extra });
}
const messages = [
  { role: "system", content: "SYS" },
  { role: "user", content: "hello" },
  { role: "assistant", content: "hi" },
  { role: "user", content: "again" },
];

test("system block carries one cache breakpoint (caches tools+system together)", () => {
  const body = makeProvider().buildBody({ messages, tools: [{ type: "function", function: { name: "Read" } }] });
  assert.ok(Array.isArray(body.system), "system becomes a block array to hold cache_control");
  assert.equal(body.system[0].cache_control.type, "ephemeral");
  assert.equal(body.system[0].text, "SYS");
  // tools 不打点：渲染顺序 tools->system，最后一个 system 断点已覆盖 tools
  assert.equal(body.tools[0].cache_control, undefined);
});

test("the last content block of the last message is marked for incremental hits", () => {
  const body = makeProvider().buildBody({ messages });
  const last = body.messages[body.messages.length - 1];
  const tail = last.content[last.content.length - 1];
  assert.equal(tail.cache_control.type, "ephemeral");
});

test("at most 2 breakpoints are used, under the API limit of 4", () => {
  const body = makeProvider().buildBody({ messages });
  const json = JSON.stringify(body);
  const count = (json.match(/cache_control/g) || []).length;
  assert.ok(count <= 4, "breakpoints within the API cap: " + count);
  assert.equal(count, 2, "exactly two: system + message tail");
});

test("promptCaching: false turns both breakpoints off", () => {
  const body = makeProvider({ promptCaching: false }).buildBody({ messages });
  assert.equal(typeof body.system, "string", "system stays a plain string");
  assert.equal((JSON.stringify(body).match(/cache_control/g) || []).length, 0);
});

test("marking breakpoints never mutates the agent's own history", () => {
  const before = JSON.stringify(messages);
  makeProvider().buildBody({ messages });
  assert.equal(JSON.stringify(messages), before, "caller messages untouched");
});
