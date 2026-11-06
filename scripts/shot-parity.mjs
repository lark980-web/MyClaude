/**
 * 截图证据链：GUI 复刻功能全景（每张先断言 DOM 标记，再落 PNG）。
 *
 * 覆盖：vim 指示器（INSERT/NORMAL 隐藏）、工具卡折叠预览与展开、消息目录、
 * 备用模型空池态、Projects 模态框、提示词库模态框。
 * 产物：shots/*.png（入库留证）。用法：node scripts/shot-parity.mjs
 */
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const EXE = join(ROOT, "dist", "myclaude.exe");
const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const PORT = 7795;
const CDP_PORT = 9336;
const SHOTS = join(ROOT, "shots");

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

// 会话夹具：70 条消息（目录用）+ 500 行输出的工具对（工具卡用）
const home = mkdtempSync(join(tmpdir(), "mc-shot-"));
mkdirSync(join(home, "sessions"), { recursive: true });
const msgs = [];
for (let i = 0; i < 34; i++) {
  msgs.push({ role: "user", content: `第 ${i + 1} 问：检查模块 ${i + 1} 的边界情况` });
  msgs.push({ role: "assistant", content: `第 ${i + 1} 个模块检查完成：一切正常。` });
}
const bigLines = [];
for (let i = 0; i < 900; i++) bigLines.push(`line-${String(i).padStart(3, "0")} output padding padding padding`);
msgs.push({ role: "user", content: "第 35 问：跑一个长输出的命令" });
msgs.push({
  role: "assistant", content: "",
  tool_calls: [{ id: "call_1", type: "function", function: { name: "Bash", arguments: JSON.stringify({ command: "long-output" }) } }],
});
msgs.push({ role: "tool", tool_call_id: "call_1", content: bigLines.join("\n") });
msgs.push({ role: "assistant", content: "命令跑完了，输出共 900 行。" });
const SESSION_ID = "shot-" + Date.now().toString(36);
writeFileSync(join(home, "sessions", SESSION_ID + ".json"), JSON.stringify({
  id: SESSION_ID, savedAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  title: "截图证据链", messages: msgs,
}));
writeFileSync(join(home, "config.json"), JSON.stringify({
  provider: "anthropic", baseUrl: "https://api.anthropic.com/v1", apiKey: "", model: "dead",
  fallbacks: [], requestTimeoutMs: 2000, autoRun: false, editorMode: "vim",
}));

mkdirSync(SHOTS, { recursive: true });
const gui = spawn(EXE, ["--gui", "--port", String(PORT), "--no-open"], {
  cwd: ROOT, env: { ...process.env, MYCLAUDE_HOME: home }, stdio: "ignore",
});
const chromeProfile = mkdtempSync(join(tmpdir(), "mc-shot-chrome-"));
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
  if (r.result?.exceptionDetails) {
    throw new Error("page eval error: " + JSON.stringify(r.result.exceptionDetails.exception?.description || "").slice(0, 300));
  }
  return r.result?.result?.value;
};
let jsErrors = 0;
let shotIdx = 0;

async function shot(name, markerDesc) {
  shotIdx += 1;
  const file = join(SHOTS, `${String(shotIdx).padStart(2, "0")}-${name}.png`);
  const cap = await send("Page.captureScreenshot", { format: "png" });
  if (cap.result?.data) {
    writeFileSync(file, Buffer.from(cap.result.data, "base64"));
    console.log(`  shot ${file}  [${markerDesc}]`);
    return file;
  }
  failures.push("screenshot failed: " + name);
  return null;
}
const pressKey = (key) =>
  evalJs(`(function () {
    var ta = document.querySelector("#in");
    var e = new KeyboardEvent("keydown", { key: ${JSON.stringify(key)}, bubbles: true, cancelable: true });
    ta.dispatchEvent(e);
    var el = document.querySelector("#vim-indicator");
    return { value: ta.value, indicator: el && !el.hidden ? el.textContent : "(hidden)" };
  })()`);

try {
  await waitUntil(async () => { try { return (await fetch(`http://127.0.0.1:${PORT}/api/config`)).ok; } catch { return null; } }, 15000, "gui up");
  await waitUntil(async () => { try { return (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).ok; } catch { return null; } }, 15000, "chrome up");
  const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
  ws = new WebSocket(targets.find((t) => t.type === "page")?.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.on("open", r); ws.on("error", j); });
  ws.on("message", (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
    if (m.method === "Runtime.exceptionThrown") { jsErrors++; }
  });
  await send("Runtime.enable");
  await send("Page.enable");
  await send("Emulation.setDeviceMetricsOverride", { width: 1360, height: 900, deviceScaleFactor: 2, mobile: false });
  await send("Page.navigate", { url: `http://127.0.0.1:${PORT}` });
  await waitUntil(() => evalJs(`(typeof window.__MCVim === "object" && document.querySelector("#in")) ? true : null`), 15000, "boot");
  // 恢复夹具会话
  await evalJs(`localStorage.setItem("myclaude.session", ${JSON.stringify(SESSION_ID)})`);
  await send("Page.navigate", { url: `http://127.0.0.1:${PORT}` });
  await waitUntil(() => evalJs(`document.querySelectorAll(".toc-row").length >= 35 ? true : null`), 20000, "catalog rows");
  await sleep(600);
  // 右栏默认关闭（width:0）——点开才看得到消息目录与备用模型区
  await evalJs(`(function(){ var b = document.querySelector("#btn-insp-toggle"); if (b) b.click(); return true; })()`);
  await waitUntil(() => evalJs(`document.querySelector("#app").classList.contains("insp-open") ? true : null`), 5000, "inspector open");
  await sleep(500);

  // 01 会话全景 + 消息目录（右栏）
  await evalJs(`(function(){ var rail = document.querySelector(".rail") || document.querySelector(".inspector"); if (rail) rail.scrollTop = 0; return true; })()`);
  await sleep(300);
  const tocCount = await evalJs(`document.querySelectorAll(".toc-row").length`);
  check("01 目录行数 ≥35", tocCount >= 35, "got " + tocCount);
  await shot("catalog-and-transcript", "消息目录 + 渐进渲染");

  // 02 工具卡折叠预览（滚动到卡片）
  await evalJs(`(function(){ var t = document.querySelector(".tool"); if (t) t.scrollIntoView({ block: "center" }); return true; })()`);
  await sleep(300);
  const prev = await evalJs(`(function(){
    var pv = document.querySelector(".tool-preview");
    return { lines: pv ? pv.querySelectorAll(".tool-preview-line").length : 0, more: pv && pv.querySelector(".is-more") ? pv.querySelector(".is-more").textContent : "" };
  })()`);
  check("02 工具卡预览 4 行", prev && prev.lines === 4, JSON.stringify(prev));
  await shot("toolcard-collapsed", "折叠态 ⎿ 3 行预览 + (+N lines)");

  // 03 工具卡展开（正文截断 + 预览隐藏）
  await evalJs(`(function(){ document.querySelector(".tool .tool-head").click(); return true; })()`);
  await sleep(300);
  const cap3 = await evalJs(`(function(){
    var box = document.querySelector(".tool");
    var pre = box.querySelectorAll(".tool-body pre")[1];
    return { open: box.classList.contains("open"), capped: pre.textContent.indexOf("已截断显示前 30000") >= 0 };
  })()`);
  check("03 展开态截断标注", cap3 && cap3.open && cap3.capped, JSON.stringify(cap3));
  await shot("toolcard-expanded", "展开态正文接管（30000 截断）");

  // 04 vim 指示器（INSERT）
  const st1 = await pressKey("i");
  await sleep(200);
  check("04 vim INSERT 指示器", st1 && st1.indicator.includes("-- INSERT --"), JSON.stringify(st1));
  await shot("vim-insert", "vim 指示器 -- INSERT --");
  await pressKey("Escape");
  await sleep(200);

  // 05 vim NORMAL（指示器隐藏 = 上游 hideVimModeIndicator 语义）
  const st2 = await pressKey("Escape");
  check("05 vim NORMAL 指示器隐藏", st2 && st2.indicator === "(hidden)", JSON.stringify(st2));
  await shot("vim-normal-hidden", "NORMAL 无指示器（上游语义）");

  // 06 备用模型空池态（右栏滚动到路由区）
  await evalJs(`(function(){
    var sec = Array.prototype.find.call(document.querySelectorAll(".insp-sec"), function (x) { return (x.textContent || "").includes("备用模型"); });
    if (sec) sec.scrollIntoView({ block: "start" });
    return true;
  })()`);
  await sleep(300);
  const dbgN = await evalJs(`document.querySelectorAll(".insp-sec").length + " | " + Array.prototype.map.call(document.querySelectorAll(".insp-sec"), function (x) { return (x.textContent || "").slice(0, 12); }).join(" || ")`);
  console.log("DBG insp-secs:", dbgN);
  const fb = await evalJs(`(function(){
    var sec = Array.prototype.find.call(document.querySelectorAll(".insp-sec"), function (x) { return (x.textContent || "").includes("备用模型"); });
    if (!sec) return null;
    var btn = Array.prototype.find.call(sec.querySelectorAll("button"), function (b) { return b.textContent.includes("一键测活"); });
    return { emptyNote: (sec.textContent || "").includes("暂无备用模型"), probeDisabled: btn ? btn.disabled : null };
  })()`);
  check("06 备用池空态（禁用测活 + 指引）", fb && fb.emptyNote && fb.probeDisabled === true, JSON.stringify(fb));
  await shot("fallback-empty", "备用模型空池态");

  // 07 Projects 模态框
  await evalJs(`(function(){ var b = document.querySelector("#btn-project"); if (b) b.click(); return true; })()`);
  await waitUntil(() => evalJs(`(function(){ var m = document.querySelector("#projects-modal"); return m && !m.hidden ? true : null; })()`), 5000, "projects modal");
  await sleep(500);
  await shot("projects-modal", "Projects 模态框");
  await evalJs(`(function(){ var b = document.querySelector("#btn-proj-modal-close"); if (b) b.click(); return true; })()`);
  await sleep(300);

  // 08 提示词库模态框
  await evalJs(`(function(){ var b = document.querySelector("#btn-prompt-library"); if (b) b.click(); return true; })()`);
  await waitUntil(() => evalJs(`(function(){ return document.querySelector(".prompt-library-modal, .modal:not([hidden])") ? true : null; })()`), 5000, "prompt library modal");
  await sleep(500);
  await shot("prompt-library-modal", "提示词库模态框");

  check("E 页面 0 JS 异常", jsErrors === 0, "errors=" + jsErrors);
} catch (e) {
  failures.push("harness: " + e.message);
  console.error("harness error:", e.message);
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
console.log("\n截图证据链完成 ✓（shots/ 下 " + shotIdx + " 张）");
