/**
 * 非流式 complete() 契约。
 *
 * 这里躺过一个真实事故：complete() 解构里没有 maxTokens 参数，函数体却引用
 * 它，任何调用（自动会话标题等）都直接 ReferenceError。用本地 HTTP 网关
 * 锁定「maxTokens 透传 + 文本/finish_reason/usage 返回」三个行为。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";

import { OpenAIProvider } from "../src/providers/openai.js";

function gateway() {
  const seen = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const parsed = JSON.parse(body || "{}");
      seen.push({ url: req.url, body: parsed });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        choices: [{
          message: { role: "assistant", content: "快速排序入门" },
          finish_reason: "stop",
        }],
        usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
      }));
    });
  });
  return { server, seen };
}

async function listen(server) {
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return "http://127.0.0.1:" + server.address().port + "/v1";
}

test("complete 透传 maxTokens 并返回文本与用量", async () => {
  const { server, seen } = gateway();
  const base = await listen(server);
  try {
    const p = new OpenAIProvider({
      provider: "openai",
      baseUrl: base,
      apiKey: "k",
      model: "m1",
      maxTokens: 999,
      temperature: 0.2,
    });
    const out = await p.complete({
      messages: [{ role: "user", content: "起个标题" }],
      maxTokens: 64,
    });
    assert.equal(out.text, "快速排序入门");
    assert.equal(out.finishReason, "stop");
    assert.equal(out.usage.completionTokens, 3);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].body.max_tokens, 64, "caller maxTokens wins");
    assert.equal(seen[0].body.model, "m1");
  } finally {
    server.closeAllConnections?.();
    server.close();
  }
});

test("complete 不传 maxTokens 时回落到 config", async () => {
  const { server, seen } = gateway();
  const base = await listen(server);
  try {
    const p = new OpenAIProvider({
      provider: "openai",
      baseUrl: base,
      apiKey: "k",
      model: "m1",
      maxTokens: 777,
    });
    await p.complete({ messages: [{ role: "user", content: "hi" }] });
    assert.equal(seen[0].body.max_tokens, 777);
  } finally {
    server.closeAllConnections?.();
    server.close();
  }
});
