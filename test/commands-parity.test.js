/**
 * 上游 2.1.302 内置命令面补齐（阶段 1-A）回归。
 *
 * 与 scripts/parity-metrics.mjs 同口径，从源码文本提取「三面注册」：
 *   TUI  -> main.js 的 case "name":
 *   GUI  -> app.js 的 COMMANDS 菜单项 { k: "/name"
 *   GUI  -> app.js 的分发（EXTRA_COMMANDS 处理器或 runCommand 的 case）
 * 另外钉住：别名归一、配置持久化、云侧命令的降级提示、GUI 后端开关契约。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const main = readFileSync(join(ROOT, "src", "main.js"), "utf8");
const app = readFileSync(join(ROOT, "src", "ui", "web", "js", "app.js"), "utf8");
const css = readFileSync(join(ROOT, "src", "ui", "web", "css", "styles.css"), "utf8");

// node scripts/parity-metrics.mjs --json 的 upstream.tuiMissing / guiMissing 去重。
const NEW_TUI = [
  "advisor", "auto-mode-setup", "autocompact", "subtask", "cd", "color", "vim",
  "diff", "background", "stop", "focus", "heapdump", "keybindings", "import",
  "pause-memory", "reload-plugins", "reload-skills", "rename", "statusline", "tui",
  "ultrareview", "security-review", "terminal-setup", "scroll-speed", "upgrade",
  "usage", "insights", "recap", "goal", "sandbox", "list-agents", "artifacts",
  "team-onboarding"
];
// GUI 额外缺的五个：TUI 已有 case，GUI 补齐菜单 + 分发。
const NEW_GUI = NEW_TUI.concat(["output-style", "exit", "resume", "session", "plan"]);

const tuiSet = new Set([...main.matchAll(/case "([a-z][a-z0-9-]*)":/g)].map((m) => m[1]));
const guiMenu = new Set([...app.matchAll(/\{ k: "\/([a-z][a-z0-9-]*)"/g)].map((m) => m[1]));
const eStart = app.indexOf("var EXTRA_COMMANDS");
const eEnd = app.indexOf("function runServerCommand");
assert.ok(eStart > 0 && eEnd > eStart, "EXTRA_COMMANDS 注册表仍存在");
const extraSrc = app.slice(eStart, eEnd);
const guiExtra = new Set([...extraSrc.matchAll(/^\s{4}"?([a-z][a-z0-9-]*)"?\s*:\s*function/gm)].map((m) => m[1]));
const appCases = new Set([...app.matchAll(/\bcase "([a-z][a-z0-9-]*)":/g)].map((m) => m[1]));

/** 取 main.js 里某个 case 的完整块，直到下一个 case。 */
function mainCaseBlock(name) {
  const start = main.search(new RegExp('^ {4}case "' + name + '":', "m"));
  assert.ok(start >= 0, 'TUI 缺少 case "' + name + '"');
  const rest = main.slice(start);
  const next = rest.slice(1).search(/^ {4}case "/m);
  return next > 0 ? rest.slice(0, next + 1) : rest;
}

test("TUI registers every local upstream command from the gap list", () => {
  for (const c of NEW_TUI) {
    assert.ok(tuiSet.has(c), "TUI 缺少 /" + c);
  }
});

test("GUI slash menu lists every gap command", () => {
  for (const c of NEW_GUI) {
    assert.ok(guiMenu.has(c), "GUI 菜单缺少 /" + c);
  }
});

test("every new GUI command is dispatchable (EXTRA handler or switch case)", () => {
  for (const c of NEW_GUI) {
    assert.ok(guiExtra.has(c) || appCases.has(c), "GUI 分发缺少 /" + c);
  }
});

test("the authoritative gap list is closed in both faces", () => {
  assert.deepEqual(NEW_TUI.filter((c) => !tuiSet.has(c)), []);
  assert.deepEqual(NEW_GUI.filter((c) => !guiMenu.has(c)), []);
});

const ALIASES = [
  ["subtask", "tasks"], ["background", "tasks"], ["usage", "cost"],
  ["rename", "title"], ["list-agents", "agents"]
];

test("aliases resolve to one implementation in the TUI", () => {
  for (const [alias, target] of ALIASES) {
    assert.match(mainCaseBlock(alias), new RegExp('handleCommand\\("/' + target + '"'),
      "/" + alias + " 应归一到 /" + target);
  }
  // 既有别名不能被本轮补齐破坏。
  assert.match(main, /case "todo":\s*\r?\n\s*case "todos":/);
  assert.match(main, /case "bashes":/);
});

test("aliases resolve to one implementation in the GUI", () => {
  assert.match(extraSrc, /background: function \(\) \{ showTasks\(\); \}/);
  assert.match(extraSrc, /subtask: function \(\) \{[^}]*showTasks\(\)/);
  assert.match(extraSrc, /usage: function \(\) \{ return EXTRA_COMMANDS\.cost\(\); \}/);
  assert.match(extraSrc, /rename: function \(arg\) \{ return EXTRA_COMMANDS\.title\(arg\); \}/);
  assert.match(extraSrc, /"list-agents": function \(\) \{ runServerCommand\("agents"\); \}/);
});

const CLOUD = ["import", "ultrareview", "upgrade", "insights", "artifacts", "team-onboarding"];

test("cloud-only commands degrade with an explicit 本机无对应服务 notice (TUI)", () => {
  assert.match(main, /function unsupportedLocal\([\s\S]*?本机无对应服务/);
  assert.match(main, /本机可用替代/);
  for (const c of CLOUD) {
    assert.match(mainCaseBlock(c), new RegExp('unsupportedLocal\\("' + c + '"'),
      "/" + c + " 应走统一降级而不是假实现");
  }
});

test("cloud-only and browser-impossible commands degrade in the GUI too", () => {
  assert.match(app, /本机无对应服务/);
  for (const c of CLOUD.concat(["cd", "heapdump"])) {
    const key = c.indexOf("-") >= 0 ? '"' + c + '"' : c;
    assert.ok(new RegExp(key + ': function \\([^)]*\\) \\{ addNotice\\(guiUnsupported\\("' + c + '"').test(extraSrc),
      "GUI /" + c + " 应走统一降级");
  }
  assert.match(extraSrc, /plan: function \(\) \{\s*addNotice\("本机无对应服务/);
});

const CONFIG_CMDS = [
  "advisor", "auto-mode-setup", "autocompact", "color", "vim", "focus",
  "pause-memory", "statusline", "scroll-speed", "goal", "sandbox"
];

test("configuration commands persist instead of only printing", () => {
  assert.match(main, /function boolSetting\([\s\S]*?saveConfig\(\{ \[key\]: on \}\)/);
  assert.match(main, /function valueSetting\([\s\S]*?saveConfig\(\{ \[key\]: value \}\)/);
  for (const c of CONFIG_CMDS) {
    assert.match(mainCaseBlock(c), /boolSetting\(|valueSetting\(|saveConfig\(/,
      "/" + c + " 未持久化");
  }
  // GUI 侧用 localStorage 真正落盘，不是只弹一个 toast。
  assert.match(app, /function guiSetPref\([\s\S]*?localStorage\.setItem\(GUI_PREFS_KEY/);
});

test("GUI engine switch is removed — backend locked, no switching entry (2026-11-14)", () => {
  // 用户要求「始终保持原生 Claude」：切换 UI 与 POST 回写全部撤除，
  // 后端只由配置文件/环境变量/main.js 生产默认决定。
  assert.match(app, /引擎后端切换 UI 已按用户要求移除/);
  assert.doesNotMatch(app, /function initEngineBackendSwitch\(\)/, "初始化函数已撤");
  assert.doesNotMatch(app, /postJSON\("\/api\/config", \{ engineBackend: next \}\)/, "POST 回写入口已撤");
  assert.doesNotMatch(app, /\[\["self", "自研"\], \["upstream", "原生 Claude"\]\]/, "切换文案已撤");
  assert.doesNotMatch(app, /setEngineBackendUI\(j\.engineBackend \|\| "self"\);/, "配置同步调用已撤");
});

/* ---- live: /api/config 的 engineBackend 契约（服务端由 Lead 实现） ---- */
const HOME = mkdtempSync(join(tmpdir(), "myclaude-parity-home-"));
process.env.MYCLAUDE_HOME = HOME;
const { startGui } = await import("../src/ui/gui-server.js");

test("GET /api/config exposes engineBackend; POST can no longer switch it (locked)", async () => {
  const config = {
    provider: "openai", baseUrl: "http://127.0.0.1:1/v1", apiKey: "t", model: "t",
    permissionMode: "fullAccess", vision: true, maxTurns: 1000,
    contextWindow: 100000, compactThreshold: 0.8
  };
  const { server, address } = await startGui({ config, port: 0, open: false, cwd: process.cwd() });
  try {
    const got = await (await fetch(address + "/api/config")).json();
    assert.ok(got.engineBackend === "self" || got.engineBackend === "upstream",
      "GET 应返回 engineBackend: self|upstream");
    const before = got.engineBackend;
    await fetch(address + "/api/config", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ engineBackend: before === "self" ? "upstream" : "self" })
    });
    const after = await (await fetch(address + "/api/config")).json();
    assert.equal(after.engineBackend, before, "POST 不再接受 engineBackend —— 后端已锁定");
  } finally {
    await new Promise((r) => server.close(r));
  }
});
