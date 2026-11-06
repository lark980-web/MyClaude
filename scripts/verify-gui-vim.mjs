/**
 * 端到端验证（无头 CDP）：GUI vim 输入模式 + statusline vim.mode 契约。
 *
 * A0. 配置 editorMode:"vim" 随 S.config 异步加载生效（预热轮询）
 * A1-A6. INSERT 打字 / esc→NORMAL（指示器隐藏 = 上游 hideVimModeIndicator 语义）/
 *        NORMAL x 删除 / i 回 INSERT / 双 esc 清空
 * B. 中文 IME（keyCode 229）直通不接管
 * C. /api/statusline?vimMode=… → stdin 契约带 vim.mode（仅枚举值放行）
 * 用法：node scripts/verify-gui-vim.mjs
 */
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const EXE = join(ROOT, "dist", "myclaude.exe");
const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const PORT = 7794;
const CDP_PORT = 9335;

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

const home = mkdtempSync(join(tmpdir(), "mc-guivim-"));
const fakeCmd = join(home, "fake-statusline.mjs");
writeFileSync(fakeCmd, `let b="";process.stdin.on("data",(c)=>b+=c);process.stdin.on("end",()=>{const j=JSON.parse(b);console.log("VIM="+(j.vim?j.vim.mode:"absent"));});`, "utf8");
writeFileSync(join(home, "config.json"), JSON.stringify({
  provider: "anthropic", baseUrl: "https://api.anthropic.com/v1", apiKey: "", model: "dead",
  fallbacks: [], requestTimeoutMs: 2000, autoRun: false,
  editorMode: "vim",
  statusLineCommand: "node " + fakeCmd,
}));

const gui = spawn(EXE, ["--gui", "--port", String(PORT), "--no-open"], {
  cwd: ROOT, env: { ...process.env, MYCLAUDE_HOME: home }, stdio: "ignore",
});
const chromeProfile = mkdtempSync(join(tmpdir(), "mc-guivim-chrome-"));
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
  await send("Page.navigate", { url: `http://127.0.0.1:${PORT}` });
  await waitUntil(() => evalJs(`(typeof window.__MCVim === "object" && document.querySelector("#in")) ? true : null`), 15000, "page boot (engine+dom)");

  // 深度探针：输入源逐项检查
  const dbg = await evalJs(`(async function () {
    var V = window.__MCVim;
    var prefs = {};
    try { prefs = JSON.parse(localStorage.getItem("myclaude.gui.prefs.v1") || "{}"); } catch (e) {}
    var cfg = null;
    try { cfg = await (await fetch("/api/config")).json(); } catch (e) {}
    return {
      engineProbe: V.vimEnabled({ editorMode: "vim" }),
      serverEditorMode: cfg ? cfg.editorMode : "no-cfg",
      serverVimMode: cfg ? cfg.vimMode : null,
      prefsVimMode: prefs.vimMode != null ? prefs.vimMode : "unset",
    };
  })()`);
  console.log("DBG:", JSON.stringify(dbg));
  check("D1 引擎启用判定与配置注入", dbg && dbg.engineProbe === true && dbg.serverEditorMode === "vim", JSON.stringify(dbg));

  const pressKey = (key, opts = "") =>
    evalJs(`(function () {
      var ta = document.querySelector("#in");
      var e = new KeyboardEvent("keydown", { key: ${JSON.stringify(key)}, bubbles: true, cancelable: true ${opts} });
      ta.dispatchEvent(e);
      var el = document.querySelector("#vim-indicator");
      return { value: ta.value, indicator: el && !el.hidden ? el.textContent : "(hidden)" };
    })()`);

  // A0. 预热：S.config 异步加载，轮询直到 vim 生效（指示器亮起）
  let st = null;
  let warmed = false;
  for (let i = 0; i < 40 && !warmed; i++) {
    st = await pressKey("i");
    warmed = st && st.indicator.includes("-- INSERT --");
    if (!warmed) await sleep(250);
  }
  check("A0 vim 模式随配置加载而生效", warmed, st && st.indicator);
  // 预热结束于 INSERT：3 连 esc = 退 INSERT → arm → 双击清空，回到干净 NORMAL
  st = await pressKey("Escape"); await sleep(80);
  st = await pressKey("Escape"); await sleep(80);
  st = await pressKey("Escape"); await sleep(100);
  check("A0b 预热残字已清", st && st.value === "", JSON.stringify(st));

  // A1. i 进 INSERT 再打字（NORMAL 下直接打字会执行 vim 命令 —— 引擎正确性的另一证明）
  st = await pressKey("i");
  for (const c of "hello") { st = await pressKey(c); }
  check("A1 INSERT 打字进缓冲", st && st.value === "hello", JSON.stringify(st));
  check("A2 指示器 -- INSERT --", st && st.indicator.includes("-- INSERT --"), st && st.indicator);

  st = await pressKey("Escape");
  check("A3 esc → NORMAL 指示器隐藏", st && st.indicator === "(hidden)", st && st.indicator);

  st = await pressKey("x");
  check("A4 NORMAL x 删除字符", st && st.value === "hell", JSON.stringify(st));

  st = await pressKey("i");
  st = await pressKey("!");
  check("A5 INSERT 追加", st && st.value === "hell!", JSON.stringify(st));

  // A6. 双击 esc 清空（上游页脚语义）：当前在 INSERT —— 3 连 = 退 INSERT → arm → 清空
  await pressKey("Escape"); await sleep(80);
  await pressKey("Escape"); await sleep(80);
  st = await pressKey("Escape"); await sleep(100);
  check("A6 双击 esc 清空输入", st && st.value === "", JSON.stringify(st));

  // B. IME 直通
  st = await evalJs(`(function () {
    var ta = document.querySelector("#in");
    var e = new KeyboardEvent("keydown", { key: "Process", bubbles: true, cancelable: true });
    Object.defineProperty(e, "keyCode", { get: function () { return 229; } });
    var prevented = false;
    ta.dispatchEvent(e);
    return { value: ta.value, indicator: (function () { var el = document.querySelector("#vim-indicator"); return el && !el.hidden ? el.textContent : "(hidden)"; })() };
  })()`);
  check("B1 IME（keyCode 229）不接管", st && st.value === "" && st.indicator === "(hidden)", JSON.stringify(st));

  // A7. i 进 INSERT，打字，Enter 提交
  st = await pressKey("i");
  for (const c of "hi") { st = await pressKey(c); }
  await pressKey("Enter");
  await waitUntil(async () => {
    const n = await evalJs(`document.querySelectorAll(".msg-user").length`);
    return n >= 1 ? n : null;
  }, 8000, "message echoed");
  const userText = await evalJs(`(function () {
    var n = document.querySelectorAll(".msg-user .bubble");
    return n.length ? n[n.length - 1].textContent : "";
  })()`);
  check("A7 Enter 提交消息进 transcript", userText === "hi", userText);

  // C. statusline vim.mode 契约
  const r1 = await (await fetch(`http://127.0.0.1:${PORT}/api/statusline?sessionKey=default&vimMode=INSERT`)).json();
  check("C1 statusline stdin 带 vim.mode=INSERT", r1.ok && r1.text === "VIM=INSERT", JSON.stringify(r1));
  const r2 = await (await fetch(`http://127.0.0.1:${PORT}/api/statusline?sessionKey=default&vimMode=VISUAL%20LINE`)).json();
  check("C2 枚举值放行 VISUAL LINE", r2.ok && r2.text === "VIM=VISUAL LINE", JSON.stringify(r2));
  const r3 = await (await fetch(`http://127.0.0.1:${PORT}/api/statusline?sessionKey=default&vimMode=DROP%20TABLE`)).json();
  check("C3 非枚举值拒绝（stdin 不带 vim 字段）", r3.ok && r3.text === "VIM=absent", JSON.stringify(r3));

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
console.log("\nGUI vim 端到端验证 ✓（全部通过）");
