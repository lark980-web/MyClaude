/**
 * 截图证据链 3：/output-style 五态清单与切换、设置中心。
 * 产物：shots/13-*.png ~ 14-*.png。用法：node scripts/shot-parity3.mjs
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
const PORT = 7798;
const CDP_PORT = 9338;
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

const home = mkdtempSync(join(tmpdir(), "mc-shot3-"));
const gui = spawn(EXE, ["--gui", "--port", String(PORT), "--no-open"], {
  cwd: ROOT, env: { ...process.env, MYCLAUDE_HOME: home }, stdio: "ignore",
});
const chromeProfile = mkdtempSync(join(tmpdir(), "mc-shot3-chrome-"));
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
let shotIdx = 12;

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
const sendCommand = (cmd) =>
  evalJs(`(function () {
    var ta = document.querySelector("#in");
    ta.value = ${JSON.stringify(cmd)};
    var e = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    ta.dispatchEvent(e);
    return true;
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
  await waitUntil(() => evalJs(`document.querySelector("#in") ? true : null`), 15000, "boot");
  await sleep(800);

  // 13 /output-style 无参列出五态
  await sendCommand("/output-style");
  await waitUntil(() => evalJs(`(function(){
    var n = Array.prototype.find.call(document.querySelectorAll(".notice, .msg-asst"), function (x) { return (x.textContent || "").includes("输出风格："); });
    return n ? true : null;
  })()`), 8000, "style list notice");
  await sleep(400);
  const styles5 = await evalJs(`(function(){
    var n = Array.prototype.find.call(document.querySelectorAll(".notice, .msg-asst"), function (x) { return (x.textContent || "").includes("输出风格："); });
    var t = n ? n.textContent : "";
    return { has5: ["proactive", "concise", "explanatory", "learning"].every(function (k) { return t.indexOf(k) >= 0; }), text: t.slice(0, 300) };
  })()`);
  check("13 五态清单（含 4 个上游新样式）", styles5 && styles5.has5, JSON.stringify(styles5 && styles5.text));
  await shot("output-style-list", "/output-style 五态清单");

  // 14 设置中心（齿轮按钮）
  await evalJs(`(function(){ var b = document.querySelector("#btn-settings, .settings-btn, [title*=设置]"); if (b) b.click(); return true; })()`);
  await sleep(700);
  const settingsOpen = await evalJs(`(function(){
    var m = document.querySelector(".settings-modal, .modal:not([hidden])");
    return m ? true : null;
  })()`);
  check("14 设置中心打开", settingsOpen === true);
  await shot("settings-center", "设置中心");
  await evalJs(`(function(){ var b = document.querySelector("[data-modal-close], .modal-close, #btn-modal-close"); if (b) b.click(); return true; })()`);
  await sleep(300);

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
console.log("\n截图证据链 3 完成 ✓");
