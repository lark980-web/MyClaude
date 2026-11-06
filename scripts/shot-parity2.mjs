/**
 * 截图证据链 2：vim VISUAL 选区、变更 tab（diff 视图）、模型菜单。
 * 产物：shots/10-*.png ~ 12-*.png。用法：node scripts/shot-parity2.mjs
 */
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const EXE = join(ROOT, "dist", "myclaude.exe");
const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const PORT = 7797;
const CDP_PORT = 9337;
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

// 变更 tab 需要 git 仓库：直接用真实仓库 cwd（只创建一个临时改动文件，拍完即删）
const home = mkdtempSync(join(tmpdir(), "mc-shot2-"));
const scratch = join(ROOT, "shots-scratch-temp.txt");
writeFileSync(scratch, "temp line A\n temp line B\n", "utf8");

writeFileSync(join(home, "config.json"), JSON.stringify({
  provider: "anthropic", baseUrl: "https://api.anthropic.com/v1", apiKey: "", model: "dead",
  fallbacks: [], requestTimeoutMs: 2000, autoRun: false, editorMode: "vim",
}));

mkdirSync(SHOTS, { recursive: true });
const gui = spawn(EXE, ["--gui", "--port", String(PORT), "--no-open"], {
  cwd: ROOT, env: { ...process.env, MYCLAUDE_HOME: home }, stdio: "ignore",
});
const chromeProfile = mkdtempSync(join(tmpdir(), "mc-shot2-chrome-"));
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
let shotIdx = 9;

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
  await sleep(800);

  // 10 vim VISUAL：i 打字 → esc → v V → l l 选区 → 指示器 -- VISUAL -- + 反色选区
  await pressKey("Escape"); // 新会话默认 INSERT，先回 NORMAL
  await pressKey("i");
  for (const c of "visual demo") await pressKey(c);
  await pressKey("Escape");
  await sleep(100);
  await pressKey("v");
  await pressKey("l");
  await pressKey("l");
  await sleep(200);
  const st = await evalJs(`(function () {
    var el = document.querySelector("#vim-indicator");
    var sel = Array.prototype.slice.call(document.querySelectorAll("#in, .vim-indicator"));
    return { indicator: el && !el.hidden ? el.textContent : "(hidden)", value: document.querySelector("#in").value };
  })()`);
  check("10 VISUAL 指示器 + 选区", st && st.indicator.includes("-- VISUAL --") && st.value === "visual demo", JSON.stringify(st));
  await shot("vim-visual-selection", "vim VISUAL 选区 + 指示器");
  await pressKey("Escape");
  await sleep(100);

  // 11 变更 tab（diff 视图）：右栏打开 → 变更 tab → 临时改动文件应出现
  await evalJs(`(function(){ var b = document.querySelector("#btn-insp-toggle"); if (b) b.click(); return true; })()`);
  await waitUntil(() => evalJs(`document.querySelector("#app").classList.contains("insp-open") ? true : null`), 5000, "inspector open");
  await sleep(400);
  await evalJs(`(function(){ var t = document.querySelector('[data-tab="changes"]'); if (t) t.click(); return true; })()`);
  await sleep(1200); // changes API 拉取
  const diffState = await evalJs(`(function(){
    var tabs = document.querySelector(".insp-tabs");
    var active = tabs && tabs.querySelector(".insp-tab.active");
    return { active: active ? active.textContent : "", body: (document.querySelector("#inspector").textContent || "").slice(0, 400) };
  })()`);
  check("11 变更 tab 激活", diffState && diffState.active === "变更", JSON.stringify(diffState && diffState.active));
  await shot("changes-diff-tab", "变更 tab（diff 视图 + 临时改动文件）");

  // 12 模型菜单
  await evalJs(`(function(){ var b = document.querySelector("#btn-model"); if (b) b.click(); return true; })()`);
  await sleep(500);
  const menuOpen = await evalJs(`(function(){ return document.querySelector(".model-menu, .model-menu-pop") ? true : null; })()`);
  check("12 模型菜单打开", menuOpen === true);
  await shot("model-menu", "模型菜单");

  check("E 页面 0 JS 异常", jsErrors === 0, "errors=" + jsErrors);
} catch (e) {
  failures.push("harness: " + e.message);
  console.error("harness error:", e.message);
} finally {
  try { ws && ws.close(); } catch {}
  try { chrome && chrome.kill(); } catch {}
  try { gui && gui.kill(); } catch {}
  await sleep(400);
  try { fs.unlinkSync(scratch); } catch {}
  rmSync(home, { recursive: true, force: true });
  rmSync(chromeProfile, { recursive: true, force: true });
}

if (failures.length) {
  console.error("\nFAILED:\n  - " + failures.join("\n  - "));
  process.exit(1);
}
console.log("\n截图证据链 2 完成 ✓");
