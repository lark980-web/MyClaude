/**
 * 端到端验证（无头 CDP）：消息目录与工具卡渲染。
 *
 * 伪造一个 70+ 条消息的会话文件（> REPLAY_CHUNK=60，首屏只渲染尾部），
 * 验证四件事：
 *   A. 目录按数据列出全部提问（不止已渲染的那一截）
 *   B. 未加载条目点击后补齐渲染并闪烁定位（此前静默无动作）
 *   C. 工具卡折叠预览 3 行 + "(+N lines)"，展开态 ≤30000 字符（上游 DCr）
 *   D. 恢复会话后新发的消息进目录、带 srcIdx（此前目录冻结在恢复时刻）
 *
 * 用法：node scripts/verify-catalog-toolcard.mjs
 * 依赖：dist/myclaude.exe + 本机 Chrome（--headless=new + 临时 profile）。
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const EXE = join(ROOT, "dist", "myclaude.exe");
const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const PORT = 7793;
const CDP_PORT = 9334;
const SESSION_ID = "verify-catalog-" + Date.now().toString(36);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitUntil(fn, ms, what) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const v = await fn().catch(() => null);
    if (v) return v;
    await sleep(200);
  }
  throw new Error("timeout: " + what);
}

// ---------- 1. 伪造会话（70 条消息，首条提问在 idx 0；工具对在尾部渲染区内） ----------
const home = mkdtempSync(join(tmpdir(), "mc-catalog-verify-"));
mkdirSync(join(home, "sessions"), { recursive: true });
const msgs = [];
for (let i = 0; i < 34; i++) {
  msgs.push({ role: "user", content: `第 ${i + 1} 问：帮我检查模块 ${i + 1} 的边界情况` });
  msgs.push({ role: "assistant", content: `好的，第 ${i + 1} 个模块的检查结果：一切正常。` });
}
const bigLines = [];
for (let i = 0; i < 900; i++) bigLines.push(`line-${String(i).padStart(3, "0")} output padding padding padding`);
msgs.push({ role: "user", content: "第 35 问：跑一个长输出的命令" });
msgs.push({
  role: "assistant",
  content: "",
  tool_calls: [{ id: "call_1", type: "function", function: { name: "Bash", arguments: JSON.stringify({ command: "long-output" }) } }],
});
msgs.push({ role: "tool", tool_call_id: "call_1", content: bigLines.join("\n") });
msgs.push({ role: "assistant", content: "命令跑完了，输出共 900 行。" });
writeFileSync(join(home, "sessions", SESSION_ID + ".json"), JSON.stringify({
  id: SESSION_ID, savedAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  title: "目录与工具卡验证", messages: msgs,
}));

// ---------- 2. 起 GUI（隔离 MYCLAUDE_HOME）与无头 Chrome ----------
const gui = spawn(EXE, ["--gui", "--port", String(PORT), "--no-open"], {
  cwd: ROOT, env: { ...process.env, MYCLAUDE_HOME: home }, stdio: "ignore",
});
const chromeProfile = mkdtempSync(join(tmpdir(), "mc-catalog-chrome-"));
const chrome = spawn(CHROME, [
  "--headless=new", `--remote-debugging-port=${CDP_PORT}`, "--disable-gpu",
  "--no-first-run", `--user-data-dir=${chromeProfile}`, "about:blank",
], { stdio: "ignore" });

const failures = [];
const check = (name, cond, extra) => {
  if (cond) { console.log("  ok  " + name); }
  else { failures.push(name + (extra ? " :: " + extra : "")); console.log("  FAIL " + name + (extra ? " :: " + extra : "")); }
};

let ws = null;
const pending = new Map();
let id = 0;
const send = (method, params = {}) => new Promise((res) => {
  const i = ++id;
  pending.set(i, res);
  ws.send(JSON.stringify({ id: i, method, params }));
});
const evalJs = async (expr) => {
  const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
  return r.result?.result?.value;
};
let jsErrors = 0;

try {
  await waitUntil(async () => {
    try { const r = await fetch(`http://127.0.0.1:${PORT}/api/config`); return r.ok; } catch { return null; }
  }, 15000, "gui up");
  await waitUntil(async () => {
    try { const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`); return r.ok; } catch { return null; }
  }, 15000, "chrome cdp up");

  const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
  ws = new WebSocket(targets.find((t) => t.type === "page")?.webSocketDebuggerUrl || `http://127.0.0.1:${CDP_PORT}/json/new?about:blank`);
  await new Promise((r, j) => { ws.on("open", r); ws.on("error", j); });
  ws.on("message", (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
    if (m.method === "Runtime.exceptionThrown") { jsErrors++; console.error("PAGE-EXC:", JSON.stringify(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text || "?").slice(0, 400)); }
  });
  await send("Runtime.enable");
  await send("Page.enable");

  // 预置 localStorage（boot 自动恢复该会话）后进入页面
  await send("Page.navigate", { url: `http://127.0.0.1:${PORT}` });
  await sleep(1500);
  await evalJs(`localStorage.setItem("myclaude.session", ${JSON.stringify(SESSION_ID)})`);
  await send("Page.navigate", { url: `http://127.0.0.1:${PORT}` });
  await waitUntil(() => evalJs(`document.querySelectorAll(".toc-row").length`), 20000, "toc rows");

  // A. 目录按数据列出全部提问
  const rows = await evalJs(`document.querySelectorAll(".toc-row").length`);
  check("A1 目录列出全部 35 条提问", rows === 35, "got " + rows);
  const renderedUsers = await evalJs(`document.querySelectorAll(".msg-user").length`);
  check("A2 首屏只渲染尾部（渐进重放未破坏）", renderedUsers < 35, "got " + renderedUsers);

  // B. 未加载条目点击 → 补齐渲染 + 闪烁
  const unloaded = await evalJs(`!!document.querySelector(".toc-row.is-unloaded")`);
  check("B1 未加载条目带 is-unloaded 标记", unloaded === true);
  await evalJs(`document.querySelector(".toc-row").click()`);
  const jumped = await waitUntil(() => evalJs(`(function(){
    var n = document.querySelector('[data-src-idx="0"]');
    return n && n.classList.contains("msg-flash") ? "flash" : null;
  })()`), 10000, "jump+flash");
  check("B2 点击未加载条目：补齐渲染 + 闪烁定位", jumped === "flash");

  // C. 工具卡预览与上限
  const prevLines = await evalJs(`(function(){
    var pv = document.querySelector(".tool-preview");
    if (!pv) return null;
    return {
      total: pv.querySelectorAll(".tool-preview-line").length,
      more: (pv.querySelector(".is-more") || {}).textContent || "",
      first: pv.querySelector(".tool-preview-line").textContent,
    };
  })()`);
  check("C1 预览共 4 行（3 输出 + 1 省略）", prevLines && prevLines.total === 4, JSON.stringify(prevLines));
  check("C2 省略行 = +897 lines", prevLines && prevLines.more.includes("+897 lines"), prevLines && prevLines.more);
  check("C3 预览行带 ⎿ 前缀", prevLines && prevLines.first.startsWith("⎿ "), prevLines && prevLines.first.slice(0, 8));
  const cap = await evalJs(`(function(){
    var box = document.querySelector(".tool");
    box.querySelector(".tool-head").click();
    var pres = box.querySelectorAll(".tool-body pre");
    var pre = pres[1]; // [0]=参数，[1]=输出
    var t = pre ? pre.textContent : "";
    return { open: box.classList.contains("open"), len: t.length, capped: t.indexOf("已截断显示前 30000") >= 0, previewHidden: getComputedStyle(document.querySelector(".tool-preview")).display === "none" };
  })()`);
  check("C4 展开后预览隐藏、正文接管", cap && cap.open && cap.previewHidden, JSON.stringify(cap));
  check("C5 正文截断到 30000 字符并标注", cap && cap.len <= 30100 && cap.capped, JSON.stringify(cap));

  // D. 恢复会话后新发消息进目录
  await evalJs(`(function(){
    var ta = document.querySelector("#in");
    ta.value = "目录边缘验证提问";
    ta.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  })()`);
  // 节点是同步出现的；目录重渲染等 SSE 事件，窗口放宽
  await waitUntil(() => evalJs(`document.querySelectorAll(".msg-user").length`), 8000, "live user node");
  const userCount = await evalJs(`document.querySelectorAll(".msg-user").length`);
  try {
    await waitUntil(() => evalJs(`document.querySelectorAll(".toc-row").length`), 25000, "new message in toc");
  } catch (e) {
    const diag = await evalJs(`(function(){
      return {
        rows: document.querySelectorAll(".toc-row").length,
        users: document.querySelectorAll(".msg-user").length,
        replayMsgs: (window.__mcDebug && window.__mcDebug.replayLen) || null,
      };
    })()`);
    throw new Error("new message in toc (diag: " + JSON.stringify(diag) + ")");
  }
  const live = await evalJs(`(function(){
    var nodes = document.querySelectorAll(".msg-user");
    var last = nodes[nodes.length - 1];
    var rows = document.querySelectorAll(".toc-row");
    return { srcIdx: last.dataset.srcIdx, lastRowUnloaded: rows[rows.length - 1].classList.contains("is-unloaded"), users: nodes.length };
  })()`);
  check("D0 live 用户节点出现（同步）", userCount === 36, "got " + userCount);
  check("D1 新消息带 srcIdx=72（无重放重复 push）", live && live.srcIdx === "72", JSON.stringify(live));
  check("D2 目录新增一行且非未加载态", live && live.lastRowUnloaded === false);

  check("E 页面 0 JS 异常", jsErrors === 0, "errors=" + jsErrors);
} catch (e) {
  failures.push("harness: " + e.message);
  console.error("harness error:", e.message);
  try {
    const diag = await evalJs('(function(){ return { url: location.href, ls: localStorage.getItem("myclaude.session"), msgs: document.querySelectorAll(".msg").length, tools: document.querySelectorAll(".tool").length, users: document.querySelectorAll(".msg-user").length, rail: document.querySelectorAll(".rail-section, section").length, tocRows: document.querySelectorAll(".toc-row").length, bodyLen: document.body.innerHTML.length, resumeDbg: window.__resumeDbg || null, notices: (function(){ var n = document.querySelectorAll(".notice"); return Array.prototype.map.call(n, function (x) { return (x.textContent || "").slice(0, 80); }); })() }; })()');
    console.error("DIAG:", JSON.stringify(diag));
  } catch (e2) { console.error("diag failed:", e2.message); }
} finally {
  try { ws && ws.close(); } catch {}
  try { chrome && chrome.kill(); } catch {}
  try { gui && gui.kill(); } catch {}
  await sleep(400);
  rmSync(home, { recursive: true, force: true });
  rmSync(chromeProfile, { recursive: true, force: true });
}

if (failures.length) {
  console.error("\nFAILED:\n  - " + failures.join("\n  - "));
  process.exit(1);
}
console.log("\n目录与工具卡端到端验证 ✓（全部通过）");
