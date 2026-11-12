/**
 * CDP 后端：MyClaude 的 computer 工具族（上游 Claude-in-Chrome 的执行宿主是
 * Chrome 扩展桥；本机可达的等价执行层是 Chrome DevTools Protocol —— 直接驱动
 * 本机 Chrome/Edge，动作面与上游 schema 逐字对齐）。
 *
 *   ensureBrowser()  定位/拉起浏览器（--remote-debugging-port=0），单例复用
 *   CdpSession       单 WebSocket flat session：Target.attachToTarget 后按
 *                    sessionId 收发；事件等待用 once 语义（navigate 等 load）
 *   tabId            上游是扩展侧数字 id；这里用进程内稳定自增注册表映射
 *                    数字 → targetId，schema 保持上游逐字（tabId: number）
 *
 * 浏览器定位：config.computerUse.browserPath 优先，否则扫常见安装路径
 * （chrome / msedge / brave）。找不到时工具返回可操作的错误而不是抛异常。
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** 常见浏览器安装位置（Windows 优先 —— 本机是 win32）。 */
const CANDIDATE_PATHS = [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "Google/Chrome/Application/chrome.exe") : null,
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/BraveSoftware/Brave-Browser/Application/brave.exe",
].filter(Boolean);

export function findBrowserExecutable(config = {}) {
  const configured = config.computerUse && config.computerUse.browserPath;
  if (configured) { return existsSync(configured) ? configured : null; }
  for (const p of CANDIDATE_PATHS) {
    if (existsSync(p)) { return p; }
  }
  // PATH 兜底（where 是 cmd 内建，走 shell）
  try {
    const r = spawnSync("where", ["chrome"], { shell: true, timeout: 3000 });
    if (r.status === 0) {
      const first = String(r.stdout || "").split(/\r?\n/).find(Boolean);
      if (first && existsSync(first.trim())) { return first.trim(); }
    }
  } catch { /* 没有 PATH 也没有常见路径 —— 返回 null */ }
  return null;
}

/** 把上游 "ctrl+a" / "cmd+shift+t" 风格拆成 CDP modifiers + 主键。 */
export function parseKeyCombo(text) {
  const FLAG = { ctrl: 2, alt: 1, shift: 8, meta: 4, cmd: 4 };
  const parts = String(text || "").split("+").map((p) => p.trim()).filter(Boolean);
  let flags = 0;
  let key = "";
  for (const p of parts) {
    const low = p.toLowerCase();
    if (low === "win" || low === "windows") { flags |= 4; continue; }
    if (FLAG[low]) { flags |= FLAG[low]; continue; }
    key = p; // 最后一个非修饰键是主键
  }
  return { key, flags };
}

const KEY_DEFS = {
  enter: { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 },
  return: { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 },
  tab: { key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 },
  escape: { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 },
  esc: { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 },
  backspace: { key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 },
  delete: { key: "Delete", code: "Delete", windowsVirtualKeyCode: 46 },
  space: { key: " ", code: "Space", windowsVirtualKeyCode: 32 },
  arrowup: { key: "ArrowUp", code: "ArrowUp", windowsVirtualKeyCode: 38 },
  arrowdown: { key: "ArrowDown", code: "ArrowDown", windowsVirtualKeyCode: 40 },
  arrowleft: { key: "ArrowLeft", code: "ArrowLeft", windowsVirtualKeyCode: 37 },
  arrowright: { key: "ArrowRight", code: "ArrowRight", windowsVirtualKeyCode: 39 },
  home: { key: "Home", code: "Home", windowsVirtualKeyCode: 36 },
  end: { key: "End", code: "End", windowsVirtualKeyCode: 35 },
  pageup: { key: "PageUp", code: "PageUp", windowsVirtualKeyCode: 33 },
  pagedown: { key: "PageDown", code: "PageDown", windowsVirtualKeyCode: 34 },
};

/** 单个键名 → CDP key 定义；单字符原样透传。 */
export function keyDef(name) {
  const low = String(name || "").toLowerCase();
  if (KEY_DEFS[low]) { return { ...KEY_DEFS[low] }; }
  if (low === "ctrl" || low === "alt" || low === "shift" || low === "meta" || low === "cmd" || low === "win" || low === "windows") { return null; }
  if (low.startsWith("f") && /^f\d{1,2}$/.test(low)) {
    const n = Number(low.slice(1));
    if (n >= 1 && n <= 12) { return { key: low.toUpperCase(), code: low.toUpperCase(), windowsVirtualKeyCode: 111 + n }; }
  }
  if (name && name.length === 1) { return { key: name, code: "", text: name, windowsVirtualKeyCode: name.toUpperCase().charCodeAt(0) }; }
  return null;
}

const SCROLL_TICK_PX = 120;

let browser = null; // { proc, ws, port, tmpDir, tabs: Map(num → targetId), nextTabId }

async function httpJson(url) {
  const res = await fetch(url);
  if (!res.ok) { throw new Error(`devtools http ${res.status}`); }
  return res.json();
}

/**
 * 定位并拉起浏览器；已拉起则复用。返回 { port }。
 * --remote-debugging-port=0 → 实际端口从 stderr 的 DevTools listening 行解析。
 */
export async function ensureBrowser(config = {}) {
  if (browser && browser.ws && browser.ws.readyState === 1) { return browser; }
  const exe = findBrowserExecutable(config);
  if (!exe) {
    throw new Error("no browser executable found — set config.computerUse.browserPath to your chrome/msedge path");
  }
  const tmpDir = mkdtempSync(join(tmpdir(), "myclaude-browser-"));
  const args = [
    "--remote-debugging-port=0",
    `--user-data-dir=${tmpDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-features=Translate",
    "--window-size=1280,800",
    "about:blank",
  ];
  if (config.computerUse && config.computerUse.headless === false) {
    // 显式有头：用户要看画面
  } else {
    args.unshift("--headless=new");
  }
  const proc = spawn(exe, args, { stdio: ["ignore", "ignore", "pipe"] });
  const wsUrl = await new Promise((resolve, reject) => {
    let acc = "";
    const timer = setTimeout(() => reject(new Error("browser did not expose a DevTools endpoint within 15s")), 15000);
    proc.stderr.on("data", (d) => {
      acc += String(d);
      const m = /DevTools listening on (ws:\/\/\S+)/.exec(acc);
      if (m) { clearTimeout(timer); resolve(m[1]); }
    });
    proc.on("exit", (code) => { clearTimeout(timer); reject(new Error(`browser exited immediately (code ${code})`)); });
  });
  const port = Number(/:(\d+)\//.exec(wsUrl)?.[1] || 0);
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", () => reject(new Error("browser devtools websocket failed")), { once: true });
  });
  browser = { proc, ws, port, tmpDir, tabs: new Map(), nextTabId: 1, listeners: new Set(), msgId: 0, pending: new Map() };
  ws.addEventListener("message", (ev) => {
    let data;
    try { data = JSON.parse(String(ev.data)); } catch { return; }
    if (data.id && browser.pending.has(data.id)) {
      const { resolve, reject } = browser.pending.get(data.id);
      browser.pending.delete(data.id);
      if (data.error) { reject(new Error(data.error.message || JSON.stringify(data.error))); }
      else { resolve(data.result); }
    } else if (data.method) {
      for (const fn of browser.listeners) { try { fn(data); } catch { /* 监听器异常不扩大 */ } }
    }
  });
  const cleanup = () => { try { browser && killBrowser(); } catch { /* 退出期容错 */ } };
  proc.on("exit", cleanup);
  process.once("exit", cleanup);
  return browser;
}

export function killBrowser() {
  if (!browser) { return; }
  const b = browser;
  browser = null;
  try { b.ws && b.ws.close(); } catch { /* 已断开 */ }
  if (b.proc && b.proc.pid) {
    try {
      if (process.platform === "win32") {
        spawnSync("taskkill", ["/pid", String(b.proc.pid), "/T", "/F"], { shell: false, timeout: 5000 });
      } else {
        b.proc.kill("SIGKILL");
      }
    } catch { /* 进程可能已退出 */ }
  }
}

/** 浏览器级 CDP 命令（无 sessionId）。 */
export function cdpSend(method, params = {}, sessionId = undefined) {
  if (!browser || !browser.ws || browser.ws.readyState !== 1) {
    return Promise.reject(new Error("browser not running"));
  }
  const id = ++browser.msgId;
  const msg = { id, method, params };
  if (sessionId) { msg.sessionId = sessionId; }
  return new Promise((resolve, reject) => {
    browser.pending.set(id, { resolve, reject });
    try { browser.ws.send(JSON.stringify(msg)); } catch (e) { browser.pending.delete(id); reject(e); }
  });
}

/** 页面级事件一次性等待（按 sessionId 过滤）。 */
function onceEvent(method, sessionId, timeoutMs, predicate = null) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      browser && browser.listeners.delete(fn);
      reject(new Error(`timed out waiting for ${method}`));
    }, timeoutMs);
    const fn = (data) => {
      if (data.method !== method) { return; }
      if (sessionId && data.sessionId !== sessionId) { return; }
      if (predicate && !predicate(data.params)) { return; }
      clearTimeout(timer);
      browser && browser.listeners.delete(fn);
      resolve(data.params);
    };
    browser.listeners.add(fn);
  });
}

/** tabId 数字 → targetId；未知 tabId 报错（上游语义：必须是当前组里的 tab）。 */
export function targetOf(tabId) {
  if (!browser) { throw new Error("browser not running"); }
  const tid = browser.tabs.get(Number(tabId));
  if (!tid) {
    const known = [...browser.tabs.keys()].join(", ");
    throw new Error(`unknown tabId ${tabId}${known ? ` — known: ${known}` : ""} (use tabs_context_mcp first)`);
  }
  return tid;
}

/** 列出当前标签页（tab 上下文）。 */
export async function listTabs() {
  const b = await ensureBrowser();
  const { targetInfos } = await cdpSend("Target.getTargets");
  const pages = targetInfos.filter((t) => t.type === "page");
  // 注册表补齐：把还没编号的 page 发号
  for (const t of pages) {
    if (![...b.tabs.values()].includes(t.targetId)) {
      b.tabs.set(b.nextTabId++, t.targetId);
    }
  }
  return pages.map((t) => {
    const id = [...b.tabs.entries()].find(([, tid]) => tid === t.targetId)?.[0];
    return { tabId: id, title: t.title, url: t.url };
  }).filter((t) => t.tabId !== undefined);
}

export async function resolveTab(input) {
  const b = await ensureBrowser();
  if (input.tabId !== undefined && input.tabId !== null && input.tabId !== "") {
    return { tabId: Number(input.tabId), targetId: targetOf(Number(input.tabId)) };
  }
  // 上游 navigate 语义：无 tabId 时取组内第一个 tab（createIfEmpty 已由
  // ensureBrowser 的 about:blank 起始页满足）
  const tabs = await listTabs();
  if (!tabs.length) { throw new Error("no browser tabs"); }
  const first = tabs[0];
  return { tabId: first.tabId, targetId: browser.tabs.get(first.tabId) };
}

/** attach 一个 flat session；返回 sessionId。 */
async function attach(targetId) {
  const { sessionId } = await cdpSend("Target.attachToTarget", { targetId, flatten: true });
  await cdpSend("Page.enable", {}, sessionId).catch(() => {});
  await cdpSend("Runtime.enable", {}, sessionId).catch(() => {});
  return sessionId;
}

/** 在页面上执行表达式（返回 JSON 值）。 */
export async function evaluateOn(targetId, expression) {
  const sessionId = await attach(targetId);
  const r = await cdpSend("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, sessionId);
  if (r.exceptionDetails) {
    throw new Error(r.exceptionDetails.exception?.description || "page evaluation failed");
  }
  return r.result && r.result.value;
}

/** 一次鼠标按键 = moved → pressed → released（clickCount 语义见动作）。 */
async function clickAt(sessionId, x, y, { button = "left", clickCount = 1, modifiers = 0 } = {}) {
  if (clickCount === 1) {
    await cdpSend("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none", pointers: [], modifiers }, sessionId).catch(() => {});
  }
  const base = { x, y, button, clickCount, modifiers };
  await cdpSend("Input.dispatchMouseEvent", { type: "mousePressed", ...base }, sessionId);
  await cdpSend("Input.dispatchMouseEvent", { type: "mouseReleased", ...base }, sessionId);
}

/** 截图（PNG base64）。region 传 [x0,y0,x1,y1] 时走 clip。 */
export async function capturePage(targetId, region = null) {
  const sessionId = await attach(targetId);
  const params = { format: "png" };
  if (region) {
    const [x0, y0, x1, y1] = region;
    params.clip = { x: Math.min(x0, x1), y: Math.min(y0, y1), width: Math.abs(x1 - x0), height: Math.abs(y1 - y0), scale: 1 };
  }
  const { data } = await cdpSend("Page.captureScreenshot", params, sessionId);
  return data;
}

/** 等待页面加载完成（导航后调用）。 */
async function waitLoad(targetId, sessionId, timeoutMs = 30000) {
  await onceEvent("Page.loadEventFired", sessionId, timeoutMs).catch(() => {
    // 超时不致命：很多 SPA 永远不会再发 load —— 返回当前状态即可
  });
}

/** computer 动作执行：单个动作 → 结果（content + attachments）。 */
export async function runComputerAction(input) {
  const action = String(input.action || "");
  const { targetId } = await resolveTab(input);
  const sessionId = await attach(targetId);

  const needCoord = ["left_click", "right_click", "double_click", "triple_click", "scroll", "hover", "left_click_drag"].includes(action);
  if (needCoord && !Array.isArray(input.coordinate)) {
    throw new Error(`action ${action} requires coordinate: [x, y]`);
  }

  switch (action) {
    case "screenshot": {
      const data = await capturePage(targetId, null);
      return { content: "screenshot captured (PNG)", attachments: [{ type: "image", source: { type: "base64", media_type: "image/png", data } }] };
    }
    case "zoom": {
      if (!Array.isArray(input.region) || input.region.length !== 4) {
        throw new Error("zoom requires region: [x0, y0, x1, y1]");
      }
      const data = await capturePage(targetId, input.region);
      return { content: `zoomed screenshot of region [${input.region.join(", ")}]`, attachments: [{ type: "image", source: { type: "base64", media_type: "image/png", data } }] };
    }
    case "left_click":
    case "right_click":
    case "double_click":
    case "triple_click": {
      const [x, y] = input.coordinate;
      const clickCount = action === "double_click" ? 2 : action === "triple_click" ? 3 : 1;
      const button = action === "right_click" ? "right" : "left";
      const modifiers = parseKeyCombo(input.modifiers || "").flags;
      await clickAt(sessionId, x, y, { button, clickCount, modifiers });
      return { content: `${action} at (${x}, ${y})` };
    }
    case "left_click_drag": {
      if (!Array.isArray(input.start_coordinate)) {
        throw new Error("left_click_drag requires start_coordinate: [x, y]");
      }
      const [x0, y0] = input.start_coordinate;
      const [x1, y1] = input.coordinate;
      await cdpSend("Input.dispatchMouseEvent", { type: "mouseMoved", x: x0, y: y0, button: "none" }, sessionId);
      await cdpSend("Input.dispatchMouseEvent", { type: "mousePressed", x: x0, y: y0, button: "left", clickCount: 1 }, sessionId);
      await cdpSend("Input.dispatchMouseEvent", { type: "mouseMoved", x: x1, y: y1, button: "left", clickCount: 1 }, sessionId);
      await cdpSend("Input.dispatchMouseEvent", { type: "mouseReleased", x: x1, y: y1, button: "left", clickCount: 1 }, sessionId);
      return { content: `dragged (${x0}, ${y0}) → (${x1}, ${y1})` };
    }
    case "hover": {
      const [x, y] = input.coordinate;
      await cdpSend("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none" }, sessionId);
      return { content: `hover at (${x}, ${y})` };
    }
    case "type": {
      if (typeof input.text !== "string") { throw new Error("type requires text"); }
      await cdpSend("Input.insertText", { text: input.text }, sessionId);
      return { content: `typed ${input.text.length} chars` };
    }
    case "key": {
      const text = String(input.text || "");
      if (!text) { throw new Error("key requires text (e.g. \"Enter\", \"ctrl+a\")"); }
      const repeat = Math.min(100, Math.max(1, Number(input.repeat) || 1));
      for (const seq of text.split(/\s+/).filter(Boolean)) {
        const { key, flags } = parseKeyCombo(seq);
        if (!key) { throw new Error(`cannot parse key sequence "${seq}"`); }
        const def = keyDef(key);
        if (!def) { throw new Error(`unknown key "${key}"`); }
        for (let i = 0; i < repeat; i++) {
          const common = { modifiers: flags, ...def, code: def.code || def.key, windowsVirtualKeyCode: def.windowsVirtualKeyCode };
          await cdpSend("Input.dispatchKeyEvent", { type: "keyDown", ...common }, sessionId);
          if (def.text !== undefined) {
            await cdpSend("Input.dispatchKeyEvent", { type: "keyDown", ...common }, sessionId).catch(() => {});
          }
          await cdpSend("Input.dispatchKeyEvent", { type: "keyUp", ...common }, sessionId);
        }
      }
      return { content: `pressed ${text}${repeat > 1 ? ` x${repeat}` : ""}` };
    }
    case "scroll": {
      const dir = String(input.scroll_direction || "down");
      if (!["up", "down", "left", "right"].includes(dir)) {
        throw new Error(`invalid scroll_direction "${dir}" (up|down|left|right)`);
      }
      const ticks = Math.min(10, Math.max(1, Number(input.scroll_amount) || 3));
      const [x, y] = input.coordinate;
      const dx = dir === "left" ? -1 : dir === "right" ? 1 : 0;
      const dy = dir === "up" ? -1 : dir === "down" ? 1 : 0;
      await cdpSend("Input.dispatchMouseEvent", {
        type: "mouseWheel", x, y,
        deltaX: dx * ticks * SCROLL_TICK_PX,
        deltaY: dy * ticks * SCROLL_TICK_PX,
      }, sessionId);
      return { content: `scrolled ${dir} ${ticks} tick(s) at (${x}, ${y})` };
    }
    case "scroll_to": {
      throw new Error("scroll_to needs an element ref from read_page/find — not available in this backend; use scroll with coordinates instead");
    }
    case "wait": {
      const seconds = Number(input.duration);
      if (!Number.isFinite(seconds) || seconds < 0) { throw new Error("wait requires duration (seconds)"); }
      const capped = Math.min(10, seconds); // 上游上限 10 秒
      await new Promise((r) => setTimeout(r, capped * 1000));
      return { content: `waited ${capped}s` };
    }
    default:
      throw new Error(`unknown action "${action}"`);
  }
}

/** navigate：url / back / forward。 */
export async function runNavigate(input) {
  const { targetId } = await resolveTab(input);
  const sessionId = await attach(targetId);
  const url = String(input.url || "");
  if (url === "back" || url === "forward") {
    const { currentIndex, entries } = await cdpSend("Page.getNavigationHistory", {}, sessionId);
    const idx = url === "back" ? currentIndex - 1 : currentIndex + 1;
    const entry = entries[idx];
    if (!entry) { return { content: `no ${url} history entry` }; }
    await cdpSend("Page.navigateToHistoryEntry", { entryId: entry.id }, sessionId);
    await waitLoad(targetId, sessionId);
    return { content: `navigated ${url} → ${entry.url}` };
  }
  let target = url;
  if (target && !/^[a-z][a-z0-9+.-]*:/i.test(target)) { target = "https://" + target; }
  if (!target) { throw new Error("navigate requires url (or \"back\"/\"forward\")"); }
  await cdpSend("Page.navigate", { url: target }, sessionId);
  await waitLoad(targetId, sessionId);
  const info = await cdpSend("Target.getTargetInfo", { targetId }, sessionId).catch(() => null);
  const t = info && info.targetInfo;
  return { content: `navigated → ${t ? t.url : target}${t && t.title ? ` (${t.title})` : ""}` };
}

/** get_page_text：页面正文文本（近似上游 article 提取）。 */
export async function runGetPageText(input) {
  const { targetId } = await resolveTab(input);
  const text = await evaluateOn(targetId,
    "(() => { const el = document.querySelector('article, main, [role=main]') || document.body; return (el.innerText || '').slice(0, 50000); })()");
  return { content: String(text ?? "").slice(0, 50000) || "(empty page)" };
}

/** resize_window：视口尺寸（headless 下即窗口尺寸）。 */
export async function runResizeWindow(input) {
  const { targetId } = await resolveTab(input);
  const sessionId = await attach(targetId);
  const width = Math.max(200, Number(input.width) || 1280);
  const height = Math.max(200, Number(input.height) || 800);
  await cdpSend("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false }, sessionId);
  return { content: `window resized to ${width}x${height}` };
}

/** tabs_context_mcp / tabs_create_mcp / tabs_close_mcp 的后端。 */
export async function runTabsList() {
  const tabs = await listTabs();
  return { content: tabs.map((t) => `- tabId ${t.tabId}: ${t.title || "(untitled)"} — ${t.url}`).join("\n") || "(no tabs)" };
}

export async function runTabsCreate(input) {
  await ensureBrowser();
  const url = String(input && input.url || "about:blank");
  const { targetId } = await cdpSend("Target.createTarget", { url: /^[a-z][a-z0-9+.-]*:/i.test(url) ? url : "https://" + url });
  const b = browser;
  const tabId = b.nextTabId++;
  b.tabs.set(tabId, targetId);
  return { content: `created tabId ${tabId} → ${url}` };
}

export async function runTabsClose(input) {
  const { targetId, tabId } = await resolveTab(input);
  await cdpSend("Target.closeTarget", { targetId });
  browser && browser.tabs.delete(tabId);
  return { content: `closed tabId ${tabId}` };
}

/** 截图落盘（save_to_disk 语义）：返回可附给用户的路径。 */
export function persistScreenshot(dataUrlBase64, dir) {
  const outDir = dir || join(process.cwd(), ".myclaude", "screenshots");
  mkdirSync(outDir, { recursive: true });
  const file = join(outDir, `screenshot-${Date.now()}.png`);
  writeFileSync(file, Buffer.from(dataUrlBase64, "base64"));
  return file;
}
