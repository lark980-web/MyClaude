import test from "node:test";
import { after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.MYCLAUDE_HOME = mkdtempSync(join(tmpdir(), "myclaude-anth-e2e-"));
const { startGui } = await import("../src/ui/gui-server.js");

// 按 Anthropic 线协议回放：message_start -> text -> tool_use -> message_delta -> stop
const seen = { bodies: [] };
async function anthropicMock() {
  const server = createServer((req, res) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      seen.bodies.push(JSON.parse(data || "{}"));
      res.writeHead(200, { "Content-Type": "text/event-stream", "anthropic-version": "2023-06-01" });
      const sse = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
      sse({ type: "message_start", message: { usage: { input_tokens: 120, output_tokens: 0 } } });
      sse({ type: "content_block_start", index: 0, content_block: { type: "thinking" } });
      sse({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "需要先读文件。" } });
      sse({ type: "content_block_stop", index: 0 });
      sse({ type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_1", name: "Read" } });
      sse({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"file_path":"package.js' } });
      sse({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: 'on"}' } });
      sse({ type: "content_block_stop", index: 1 });
      sse({ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 42 } });
      sse({ type: "message_stop" });
      res.end();
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { server, url: `http://127.0.0.1:${server.address().port}/v1` };
}

test("anthropic wire format: request shape, stream parsing, tool round-trip", async () => {
  const backend = await anthropicMock();
  const config = { provider: "anthropic", baseUrl: backend.url, apiKey: "sk-ant-test", model: "claude-3-7-sonnet",
    permissionMode: "auto", vision: true, maxTurns: 6, contextWindow: 100000, compactThreshold: 0.8, effort: "high" };
  const { server: gui, address } = await startGui({ config, port: 0, open: false });
  try {
    const res = await fetch(address + "/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "read package.json", sessionKey: "anth-e2e" }),
    });
    assert.equal(res.status, 200);
    const events = (await res.text()).split("\n").filter(l => l.startsWith("data:")).map(l => JSON.parse(l.slice(5).trim()));
    // 请求体必须是 Messages API 形状
    const body = seen.bodies[seen.bodies.length - 1];
    assert.equal(body.model, "claude-3-7-sonnet");
    // 打开 prompt caching 后 system 是块数组：[{type:"text",text,cache_control}]
    const sysText = Array.isArray(body.system) ? body.system.map((b) => b.text).join("\n") : body.system;
    assert.ok(sysText && sysText.includes("MyClaude"), "system is top-level");
    assert.ok(Array.isArray(body.system) && body.system[0].cache_control, "system block carries a cache breakpoint");
    assert.ok(Array.isArray(body.messages) && body.messages[0].role === "user");
    assert.ok(body.max_tokens >= 1024, "max_tokens is required by Anthropic (catalogue supplies the ceiling)");
    assert.ok(body.thinking && body.thinking.type === "enabled", "effort=high enables thinking");
    assert.equal(body.temperature, 1, "thinking forces temperature 1");
    assert.ok(body.tools.some(t => t.name === "Read" && t.input_schema), "tools use input_schema");
    // 流解析：thinking 进 reasoning 通道，tool_use 还原成结构化调用
    const reasoning = events.filter(e => e.type === "reasoning");
    assert.ok(reasoning.length >= 1, "thinking reached the reasoning channel");
    const toolEnd = events.filter(e => e.type === "tool_end");
    assert.ok(toolEnd.length >= 1, "tool_use blocks executed as real tool calls");
    assert.equal(toolEnd[0].ok, true, "Read executed with parsed input");
    assert.ok(events.some(e => e.type === "done"), "turn completes");
  } finally {
    await new Promise((r) => gui.close(r));
    await new Promise((r) => backend.server.close(r));
  }
});

after(() => { setTimeout(() => process.exit(0), 100).unref?.(); });
