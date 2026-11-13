import test, { after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOME = mkdtempSync(join(tmpdir(), "myclaude-upchat-"));
process.env.MYCLAUDE_HOME = HOME;
process.env.MYCLAUDE_ENGINE_BACKEND = "";

const { startGui } = await import("../src/ui/gui-server.js");
const { translateUpstreamLine, newTranslateState } = await import("../src/engines/upstream-chat.js");

// ---- 纯函数：用本轮捕获的真实事件形态做夹具 ----
const EVENTS = [
  { type: "system", subtype: "init", session_id: "sess-abc", tools: ["Read"] },
  { type: "assistant", message: { content: [
    { type: "tool_use", id: "call_1", name: "Read", input: { file_path: "package.json" } } ] } },
  { type: "user", message: { content: [
    { type: "tool_result", tool_use_id: "call_1", content: "1  version: 0.19.0", is_error: false } ] } },
  { type: "assistant", message: { content: [
    { type: "thinking", thinking: "let me check" },
    { type: "text", text: "The version is 0.19.0" } ] } },
  { type: "result", subtype: "success", result: "The version is 0.19.0", session_id: "sess-abc", is_error: false, num_turns: 2 },
];

test("the translator maps upstream NDJSON onto MyClaude SSE events", () => {
  const s = newTranslateState();
  const out = [];
  for (const e of EVENTS) out.push(...translateUpstreamLine(JSON.stringify(e), s).events);
  const types = out.map((e) => e.type);
  assert.deepEqual(types, ["tool_start", "tool_end", "reasoning", "delta", "assistant_end"]);
  assert.equal(out[0].call.name, "Read", "tool_use -> tool_start with the real name");
  assert.equal(out[1].name, "Read", "tool_result resolves back to the tool via its id");
  assert.equal(out[1].ok, true);
  assert.match(out[1].output, /0.19.0/);
  assert.equal(out[3].text, "The version is 0.19.0");
  assert.equal(s.sessionId, "sess-abc");
  assert.deepEqual(s.assistantTexts, ["The version is 0.19.0"]);
});

test("unknown upstream lines are ignored, not guessed", () => {
  const s = newTranslateState();
  const r = translateUpstreamLine(JSON.stringify({ type: "telemetry", foo: 1 }), s);
  assert.deepEqual(r.events, []);
  assert.equal(translateUpstreamLine("not json", s).events.length, 0);
});

test("a failed tool result carries ok=false", () => {
  const s = newTranslateState();
  s.toolNames.set("t9", "Bash");
  const e = translateUpstreamLine(JSON.stringify({ type: "user", message: { content: [
    { type: "tool_result", tool_use_id: "t9", content: "denied", is_error: true } ] } }), s).events;
  assert.equal(e[0].ok, false);
  assert.equal(e[0].name, "Bash");
});

// ---- 端到端：/api/chat 在 upstream 后端下走假引擎 ----
function writeFakeCli() {
  const p = join(tmpdir(), "mc-upstream-fake-" + Math.random().toString(36).slice(2) + ".mjs");
  writeFileSync(p, [
    "const L = [",
    "  { type: \"system\", subtype: \"init\", session_id: \"fake-up-sess\", tools: [\"Read\"] },",
    "  { type: \"assistant\", message: { content: [",
    "    { type: \"text\", text: \"Reply from upstream\" } ] } },",
    "  { type: \"result\", subtype: \"success\", result: \"Reply from upstream\",",
    "    session_id: \"fake-up-sess\", is_error: false, num_turns: 1 },",
    "];",
    "for (const x of L) process.stdout.write(JSON.stringify(x) + \"\\n\");",
    "let b = \"\"; process.stdin.on(\"data\", (c) => { b += c; });",
    "process.stdin.on(\"end\", () => process.exit(0));",
  ].join("\n"), "utf8");
  return p;
}

const ORIG = { bun: process.env.MYCLAUDE_ENGINE_BUN, cli: process.env.MYCLAUDE_ENGINE_CLI, be: process.env.MYCLAUDE_ENGINE_BACKEND };
const restore = () => {
  for (const [k, v] of Object.entries(ORIG)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
};

test("GET /api/config exposes the engine backend; POST can no longer switch it (locked 2026-11-14)", async () => {
  const { server: gui, address } = await startGui({ config: { model: "m", provider: "openai", baseUrl: "http://127.0.0.1:9", apiKey: "x" }, port: 0, open: false });
  try {
    const g = await (await fetch(address + "/api/config")).json();
    assert.equal(g.engineBackend, "self", "default must stay self for explicit test configs");
    await fetch(address + "/api/config", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ engineBackend: "upstream" }) });
    const g2 = await (await fetch(address + "/api/config")).json();
    assert.equal(g2.engineBackend, "self", "POST must NOT switch — engine locked to config/env");
  } finally { await new Promise((r) => gui.close(r)); }
});

test("/api/chat in upstream mode streams SSE and persists the turn", async (t) => {
  t.after(restore);
  const cli = writeFakeCli();
  process.env.MYCLAUDE_ENGINE_BUN = process.execPath;
  process.env.MYCLAUDE_ENGINE_CLI = cli;
  process.env.MYCLAUDE_ENGINE_BACKEND = "upstream";
  const { server: gui, address } = await startGui({ config: { model: "m", provider: "openai", baseUrl: "http://127.0.0.1:9", apiKey: "x" }, port: 0, open: false });
  try {
    const res = await fetch(address + "/api/chat", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "hello", sessionKey: "upchat-1" }) });
    assert.equal(res.status, 200);
    const text = await res.text();
    const events = text.split("\n").filter((l) => l.startsWith("data:")).map((l) => JSON.parse(l.slice(5).trim()));
    const types = events.map((e) => e.type);
    assert.ok(types.includes("session"), "must adopt session id");
    assert.ok(types.includes("delta"), "upstream text must reach the chat stream");
    assert.ok(types.includes("assistant_end")) && assert.ok(types.includes("done"));
    const delta = events.find((e) => e.type === "delta");
    assert.equal(delta.text, "Reply from upstream");
    // 会话落盘
    const f = join(HOME, "sessions", "upchat-1.json");
    assert.ok(existsSync(f), "turn must be written to MyClaude session: " + f);
    const j = JSON.parse(readFileSync(f, "utf8"));
    assert.ok(j.messages.some((m) => m.role === "user" && m.content === "hello"));
    assert.ok(j.messages.some((m) => m.role === "assistant" && m.content === "Reply from upstream"));
    assert.equal(j.engine, "upstream");
    // 上游 session 绑定
    const bind = join(HOME, "engine-sessions.json");
    assert.ok(existsSync(bind), "upstream session must be bound");
  } finally { await new Promise((r) => gui.close(r)); }
});

after(() => { setTimeout(() => process.exit(0), 100).unref?.(); });

test("R7: stream_event 部分增量推 delta，完整消息只补差量防双倍", () => {
  const imports = { translateUpstreamLine, newTranslateState };
  const st = newTranslateState();
  const deltas = [];
  // 流式：三段部分增量
  for (const text of ["你好", "，", "世界"]) {
    const r = translateUpstreamLine(JSON.stringify({
      type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
    }), st);
    deltas.push(...r.events.filter((e) => e.type === "delta").map((e) => e.text));
  }
  assert.deepEqual(deltas, ["你好", "，", "世界"]);
  // 完整消息到达：只补差量（这里无差量 → 无重复 delta）
  const full = translateUpstreamLine(JSON.stringify({
    type: "assistant", message: { content: [{ type: "text", text: "你好，世界" }] },
  }), st);
  const rest = full.events.filter((e) => e.type === "delta").map((e) => e.text);
  assert.deepEqual(rest, [], "已流式的不重发");
  // 新消息开始：streamedText 重置
  translateUpstreamLine(JSON.stringify({
    type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "text" } },
  }), st);
  const r2 = translateUpstreamLine(JSON.stringify({
    type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "新消息" } },
  }), st);
  assert.deepEqual(r2.events.filter((e) => e.type === "delta").map((e) => e.text), ["新消息"]);
});

test("R7: thinking_delta → reasoning 事件", () => {
  const imports = { translateUpstreamLine, newTranslateState };
  const st = newTranslateState();
  const r = translateUpstreamLine(JSON.stringify({
    type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "思考中" } },
  }), st);
  assert.deepEqual(r.events.map((e) => e.type), ["reasoning"]);
  assert.equal(r.events[0].text, "思考中");
});
