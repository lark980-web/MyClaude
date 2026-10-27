/**
 * Self-audit matrix: run every "mid-task interruption" scenario against the
 * REAL exe. Unit tests passed while the product broke before; this drives the
 * shipped binary the way a user would. Usage: node scripts/self-audit.mjs
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";

const PORT = 7799;
const results = [];
const ok = (name, cond, detail) => { results.push({ name, pass: !!cond, detail: detail || "" }); console.log((cond ? "✓" : "✗") + " " + name + (detail ? " — " + detail : "")); };

// ---- mock OpenAI backend (scripted, with hang + tool-call support) ----
const state = { script: [], hang: false, bodies: [] };
const backend = createServer((req, res) => {
  let data = "";
  req.on("data", (c) => (data += c));
  req.on("end", () => {
    state.bodies.push(JSON.parse(data || "{}"));
    if (state.hang) { res.writeHead(200, { "Content-Type": "text/event-stream" }); return; }
    const next = state.script.shift() || { text: "done" };
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    if (next.toolCalls) {
      next.toolCalls.forEach((tc, i) => res.write("data: " + JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: i, id: tc.id, function: { name: tc.name, arguments: JSON.stringify(tc.arguments) } }] } }] }) + "\n\n"));
      res.write("data: " + JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }) + "\n\n");
    } else {
      res.write("data: " + JSON.stringify({ choices: [{ delta: { content: next.text } }] }) + "\n\n");
      res.write("data: " + JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] }) + "\n\n");
    }
    res.write("data: [DONE]\n\n");
    res.end();
  });
});
await new Promise((r) => backend.listen(0, "127.0.0.1", r));
const backendUrl = `http://127.0.0.1:${backend.address().port}/v1`;

// ---- boot the real exe with a temp home pointing at the mock ----
const home = mkdtempSync(join(tmpdir(), "self-audit-"));
mkdirSync(join(home, ".myclaude"), { recursive: true });
writeFileSync(join(home, "config.json"), JSON.stringify({
  provider: "openai", baseUrl: backendUrl, apiKey: "audit", model: "audit-model",
  permissionMode: "auto", maxTurns: 3, contextWindow: 100000, compactThreshold: 0.8,
  vision: true, autoRun: false,
}));
const exe = process.env.MYCLAUDE_EXE || "E:/WorkSpaces/Test09/MyClaude/dist/myclaude.exe";
const cwd = process.env.MYCLAUDE_CWD || "E:/WorkSpaces/Test09/MyClaude";
const proc = spawn(exe, ["--gui", "--port", String(PORT), "--no-open"], { cwd, stdio: "ignore", detached: false, windowsHide: true, env: { ...process.env, MYCLAUDE_HOME: home } });
let up = false;
for (let i = 0; i < 30 && !up; i++) { await new Promise((r) => setTimeout(r, 800)); try { const r2 = await fetch(`http://127.0.0.1:${PORT}/api/config`, { signal: AbortSignal.timeout(2000) }); up = r2.ok; } catch {} }
if (!up) { console.log("✗ exe 启动失败"); proc.kill(); process.exit(1); }
console.log("exe 启动 ✓ (port " + PORT + ")");

const readSse = async (res) => (await res.text()).split("\n").filter((l) => l.startsWith("data:")).map((l) => { try { return JSON.parse(l.slice(5).trim()); } catch { return null; } }).filter(Boolean);
const chat = (message, sessionKey, extra) => fetch(`http://127.0.0.1:${PORT}/api/chat`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message, sessionKey, ...extra }) });

// ---- S1: two consecutive turns share one session id (fork regression) ----
state.script.push({ text: "答一" }, { text: "答二" });
const e1 = await readSse(await chat("问题一", "audit-s1"));
const id1 = e1.find((e) => e.type === "session")?.id;
const e2 = await readSse(await chat("问题二", id1));
const id2 = e2.find((e) => e.type === "session")?.id;
ok("S1 连续轮次共用一个会话 id", id1 === id2 && !!id1, id1 + " vs " + id2);
const r2msgs = e2.filter((e) => e.type === "stats")[0];
ok("S1b 第二轮历史累计(消息=4)", r2msgs && r2msgs.messages === 4, "实际 " + (r2msgs && r2msgs.messages));

// ---- S2: stats semantics — contextUsed is a token count ----
ok("S2 stats.contextUsed 是 token 数(>1)", r2msgs && r2msgs.contextUsed > 1, "实际 " + (r2msgs && r2msgs.contextUsed));

// ---- S3: abort mid-stream ----
state.hang = true;
const hangReq = chat("慢任务", "audit-s3");
await new Promise((r) => setTimeout(r, 400));
const ab = await (await fetch(`http://127.0.0.1:${PORT}/api/abort`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sessionKey: "audit-s3" }) })).json();
state.hang = false;
const hEvents = await readSse(await hangReq);
ok("S3 abort 流中断", ab.aborted && hEvents.some((e) => e.type === "done"), "");

// ---- S4: busy guard ----
state.hang = true;
const b1 = chat("占位任务", "audit-s4");
await new Promise((r) => setTimeout(r, 400));
const busyResp = await fetch(`http://127.0.0.1:${PORT}/api/chat`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message: "并发第二发", sessionKey: "audit-s4" }) });
ok("S4 忙时第二发被 409 拒绝(前端排队的前提)", busyResp.status === 409, "status=" + busyResp.status);
await fetch(`http://127.0.0.1:${PORT}/api/abort`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sessionKey: "audit-s4" }) });
await readSse(await b1).catch(() => []);
state.hang = false;

// ---- S5: maxTurns → max_turns 事件 ----
await fetch(`http://127.0.0.1:${PORT}/api/config`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ maxTurns: 1 }) });
state.script.push({ toolCalls: [{ id: "t1", name: "Echo", arguments: {} }] });
const e5 = await readSse(await chat("触发上限", "audit-s5"));
ok("S5 到回合上限发 max_turns 事件", e5.some((e) => e.type === "max_turns"), "");
await fetch(`http://127.0.0.1:${PORT}/api/config`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ maxTurns: 3 }) });

// ---- S6: resume mid-run keeps live agent + still abortable ----
state.script.push({ text: "预热回答" });
await readSse(await chat("预热问题", "audit-s6"));
const list0 = await (await fetch(`http://127.0.0.1:${PORT}/api/sessions`)).json();
const liveId = list0.sessions.find((s) => s.title === "预热问题")?.id;
state.hang = true;
const pending6 = chat("进行中任务", "audit-s6");
await new Promise((r) => setTimeout(r, 400));
const resumed = await (await fetch(`http://127.0.0.1:${PORT}/api/session`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "resume", id: liveId }) })).json();
const ab6 = await (await fetch(`http://127.0.0.1:${PORT}/api/abort`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sessionKey: "audit-s6" }) })).json();
ok("S6 运行中 resume 返回内存版本(消息更多)", resumed.ok && resumed.source === "memory", "source=" + resumed.source + " msgs=" + resumed.messages);
ok("S6b 运行中 resume 不抹掉活会话且可中止", ab6.aborted, "aborted=" + ab6.aborted);
await readSse(await pending6).catch(() => []);
state.hang = false;

// ---- S7: changes endpoints ----
const chg = await (await fetch(`http://127.0.0.1:${PORT}/api/changes?scope=branch`)).json();
ok("S7 /api/changes 有响应", chg.ok === true || chg.reason === "non-git", "files=" + (chg.files || []).length + " reason=" + (chg.reason || "-"));

// ---- cleanup ----
proc.kill();
await new Promise((r) => backend.close(r));
const fails = results.filter((r) => !r.pass);
console.log("\n=== 自检矩阵: " + (results.length - fails.length) + "/" + results.length + " 通过 ===");
if (fails.length) { fails.forEach((f) => console.log("✗ " + f.name + " — " + f.detail)); process.exit(1); }
