import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.MYCLAUDE_HOME = mkdtempSync(join(tmpdir(), "myclaude-engine-"));

const { engineStatus, engineEnv, buildEngineArgs, summarizeEngineEvents, runEngineTurn } =
  await import("../src/engines/claude-code.js");

// 真实事件流夹具：2026-11-06 从 claude-re-2.1.302 提取树 + 本地网关的实际回合捕获
// （system/init + assistant + result 三行，见 docs/authentic-claude-code-run.md）。
const fixtureLines = readFileSync(new URL("./fixtures/engine-stream.jsonl", import.meta.url), "utf8")
  .split(/\r?\n/).filter((l) => l.trim().startsWith("{"));

test("summarizeEngineEvents parses the real captured stream", () => {
  const s = summarizeEngineEvents(fixtureLines);
  assert.match(String(s.sessionId), /^[0-9a-f]{8}-/, "session id comes from the init event");
  // 实测 2.1.302 默认注册 24 个工具（全集 ≥92 里其余是云侧/上下文门控，默认不启用）
  assert.ok(s.toolsCount >= 20, "init event carries the default tool list, got " + s.toolsCount);
  assert.equal(s.isError, false);
  assert.equal(s.numTurns, 1);
  assert.ok(s.result && s.result.length > 0, "result text is present");
  assert.ok(s.usage && s.usage.input_tokens > 0, "usage is present");
});

test("engineEnv strips trailing /v1 and sets both credential vars", () => {
  const e = engineEnv({ baseUrl: "http://127.0.0.1:3425/v1/", apiKey: "sk-x" });
  assert.equal(e.ANTHROPIC_BASE_URL, "http://127.0.0.1:3425");
  assert.equal(e.ANTHROPIC_AUTH_TOKEN, "sk-x");
  assert.equal(e.ANTHROPIC_API_KEY, "sk-x");
  assert.equal(e.NO_COLOR, "1");
});

test("buildEngineArgs: stream-json + verbose + permission mode whitelist", () => {
  const a = buildEngineArgs({ model: "m/x", permissionMode: "plan" });
  assert.ok(a.includes("--print") && a.includes("stream-json") && a.includes("--verbose"));
  assert.ok(a.includes("--permission-mode") && a.includes("plan"));
  assert.ok(a.includes("--model") && a.includes("m/x"));
  // 未知模式必须落回安全默认，不能原样透传给引擎
  const b = buildEngineArgs({ model: "m", permissionMode: "no-such-mode" });
  assert.ok(b.includes("acceptEdits"));
});

test("runEngineTurn rejects an empty prompt without spawning", async () => {
  const r = await runEngineTurn({ prompt: "  " });
  assert.equal(r.ok, false);
  assert.equal(r.error, "empty prompt");
});

// ---- 真实引擎 e2e：缺 B:/bun/网关任一条件时自动跳过 ----
let gatewayUp = false;
try {
  const r = await fetch("http://127.0.0.1:3425/v1/models", { signal: AbortSignal.timeout(2000) });
  gatewayUp = r.ok;
} catch { /* 网关不在线就跳过，不判失败 */ }
const realSt = engineStatus();

test("real engine turn through the gateway", { skip: !(realSt.available && gatewayUp) }, async () => {
  const r = await runEngineTurn({
    prompt: "Reply with exactly: ok",
    model: "auto/deepseek-v4.1-flash",
    baseUrl: "http://127.0.0.1:3425",
    apiKey: "sk-local-probe",
    cwd: process.cwd(),
    timeoutMs: 150_000,
  });
  assert.equal(r.ok, true, "engine turn failed: " + JSON.stringify({ error: r.error, tail: String(r.stderrTail || "").slice(-200) }));
  assert.ok(r.numTurns >= 1, "at least one turn");
  assert.ok(r.sessionId, "engine reports its own session id");
});

// ---- 假引擎：不依赖 B: 盘，覆盖 spawn/stdin/行缓冲/解析/退出码全链路 ----
const ORIG = { bun: process.env.MYCLAUDE_ENGINE_BUN, cli: process.env.MYCLAUDE_ENGINE_CLI };
const restore = () => {
  if (ORIG.bun === undefined) delete process.env.MYCLAUDE_ENGINE_BUN; else process.env.MYCLAUDE_ENGINE_BUN = ORIG.bun;
  if (ORIG.cli === undefined) delete process.env.MYCLAUDE_ENGINE_CLI; else process.env.MYCLAUDE_ENGINE_CLI = ORIG.cli;
};

test("runEngineTurn drives a fake engine end to end", async (t) => {
  t.after(restore);
  const fake = join(tmpdir(), "mc-fake-engine.mjs");
  writeFileSync(fake, [
    "let buf = '';",
    "process.stdin.setEncoding('utf8');",
    "process.stdin.on('data', (c) => { buf += c; });",
    "process.stdin.on('end', () => {",
    "  if (!buf.trim()) { process.exit(2); }",
    "  const LINES = " + JSON.stringify(fixtureLines) + ";",
    "  for (const l of LINES) { process.stdout.write(l + '\\n'); }",
    "  process.exit(0);",
    "});",
    "process.stdin.on('error', () => {});",
  ].join("\n"), "utf8");
  process.env.MYCLAUDE_ENGINE_BUN = process.execPath;
  process.env.MYCLAUDE_ENGINE_CLI = fake;
  const r = await runEngineTurn({ prompt: "hello", model: "m", baseUrl: "http://127.0.0.1:9", apiKey: "sk-t", timeoutMs: 30_000 });
  assert.equal(r.ok, true, "fake engine turn ok: " + JSON.stringify({ error: r.error, exit: r.exitCode, tail: r.stderrTail }));
  assert.match(String(r.sessionId), /^[0-9a-f]{8}-/);
  assert.equal(r.numTurns, 1);
  assert.equal(r.exitCode, 0);
});

test("runEngineTurn enforces the deadline and kills the engine", async (t) => {
  t.after(restore);
  const slow = join(tmpdir(), "mc-slow-engine.mjs");
  writeFileSync(slow, "process.stdin.on('data', () => {});\nsetTimeout(() => process.exit(0), 60000);\n", "utf8");
  process.env.MYCLAUDE_ENGINE_BUN = process.execPath;
  process.env.MYCLAUDE_ENGINE_CLI = slow;
  const r = await runEngineTurn({ prompt: "x", model: "m", timeoutMs: 5_000 });
  assert.equal(r.timedOut, true, "must hit the deadline");
  assert.equal(r.ok, false);
});

// ---- 三面注册：TUI / GUI / 服务端命令桥 ----
test("/engine is wired in all three surfaces", () => {
  const main = readFileSync(new URL("../src/main.js", import.meta.url), "utf8");
  const app = readFileSync(new URL("../src/ui/web/js/app.js", import.meta.url), "utf8");
  const gs = readFileSync(new URL("../src/ui/gui-server.js", import.meta.url), "utf8");
  assert.match(main, /case "engine": \{/, "TUI dispatch case");
  assert.match(app, /engine: function \(arg\)/, "GUI EXTRA_COMMANDS handler");
  assert.match(app, /k: "\/engine"/, "GUI slash menu entry");
  assert.match(gs, /if \(name === "engine"\)/, "server bridge branch");
  assert.match(gs, /engines\/claude-code\.js/, "bridge imports the engine module");
});
