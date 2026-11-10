/**
 * 行为差分实测：自研 agent 在真实任务上的行为验证（文件创建/读改链/结构理解/错误恢复）。
 * 走真实网关 + 真工具链，产物落盘并断言。用法：node scripts/shot-differential.mjs
 */
const { spawn } = require("node:child_process");
const os = require("node:os"), path = require("node:path"), fs = require("node:fs");

const home = fs.mkdtempSync(path.join(os.tmpdir(), "mc-diff-"));
const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "mc-diff-work-"));
fs.writeFileSync(path.join(workdir, "greeting.txt"), "hello world\n");
fs.writeFileSync(path.join(workdir, "config.json"), JSON.stringify({
  version: "1.0", mode: "basic", features: ["a", "b"], nested: { enabled: true },
}, null, 2));

const real = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".myclaude", "config.json"), "utf8"));
fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({
  provider: real.provider, baseUrl: real.baseUrl, apiKey: real.apiKey,
  model: real.model, fallbacks: real.fallbacks || [], autoRun: true, permissionMode: "auto",
}));

const entry = path.resolve("bin/myclaude.js");
const p = spawn(process.execPath, [entry, "--gui", "--port", "7788", "--no-open"], {
  env: { ...process.env, MYCLAUDE_HOME: home }, cwd: workdir, stdio: "pipe",
});
let serr = "";
p.stderr.on("data", (d) => { serr += d; });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function runTurn(prompt, key) {
  const body = JSON.stringify({ message: prompt, sessionKey: key });
  const res = await fetch("http://127.0.0.1:7788/api/chat", {
    method: "POST", headers: { "content-type": "application/json" }, body,
  });
  const dec = new TextDecoder();
  let raw = "";
  const reader = res.body.getReader();
  const t0 = Date.now();
  while (Date.now() - t0 < 120000) {
    const { done, value } = await reader.read();
    if (done) break;
    raw += dec.decode(value, { stream: true });
    if (raw.includes('"type":"done"')) break;
  }
  const events = raw.split("\n").filter((l) => l.startsWith("data: "))
    .map((l) => { try { return JSON.parse(l.slice(6)); } catch { return null; } }).filter(Boolean);
  return {
    text: events.filter((e) => e.type === "delta").map((e) => e.text).join(""),
    tools: events.filter((e) => e.type === "tool_start").map((e) => e.call?.name),
    errors: events.filter((e) => e.type === "error").map((e) => e.text?.slice(0, 120)),
    done: events.some((e) => e.type === "done"),
  };
}

async function main() {
  await sleep(8000); // 等 GUI 服务启动

  const results = {};

  // S1 文件创建
  const r1 = await runTurn("创建一个文件 output.txt，内容写入 differential ok（用 Write 工具直接写）", "diff1");
  const f1 = path.join(workdir, "output.txt");
  results.fileCreated = fs.existsSync(f1) && fs.readFileSync(f1, "utf8").includes("differential ok");
  console.log("S1 文件创建:", JSON.stringify({ ok: results.fileCreated, tools: r1.tools, done: r1.done }));
  await sleep(2000);

  // S2 读取+修改（多轮工具链 Read → Edit）
  const r2 = await runTurn('把 greeting.txt 的 "hello" 改成 "goodbye"（用 Edit 工具）', "diff1");
  const f2 = fs.readFileSync(path.join(workdir, "greeting.txt"), "utf8");
  results.fileEdited = f2.includes("goodbye") && !f2.includes("hello world");
  console.log("S2 读改链:", JSON.stringify({ ok: results.fileEdited, tools: r2.tools, done: r2.done, content: f2.trim() }));
  await sleep(2000);

  // S3 JSON 解析
  const r3 = await runTurn("config.json 里的 features 数组有几个元素？只回答数字。", "diff1");
  results.jsonParsed = /\b2\b/.test(r3.text);
  console.log("S3 JSON 解析:", JSON.stringify({ ok: results.jsonParsed, reply: r3.text.slice(0, 80) }));
  await sleep(2000);

  // S4 错误恢复
  const r4 = await runTurn("读取 nonexistent-file-xyz.txt 的内容", "diff1");
  results.errorRecovered = r4.done && !r4.text.includes("FATAL") && !r4.text.includes("unhandled");
  console.log("S4 错误恢复:", JSON.stringify({ ok: results.errorRecovered, done: r4.done, tools: r4.tools }));

  const pass = Object.entries(results).filter(([k]) => !k.startsWith("r"));
  const passCount = pass.filter(([, v]) => v).length;
  console.log(`\n${passCount}/${pass.length} 行为差分场景通过`);
  if (passCount < pass.length) process.exit(1);
  console.log("行为差分实测 ✓");
}

main().then(() => {
  try { p.kill(); } catch {}
  setTimeout(() => {
    try { fs.rmSync(home, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(workdir, { recursive: true, force: true }); } catch {}
    process.exit(0);
  }, 500);
}).catch((e) => {
  console.error("harness:", e.message);
  try { p.kill(); } catch {}
  process.exit(1);
});
