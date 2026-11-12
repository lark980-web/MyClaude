/**
 * Computer Use（浏览器动作面）行为测试：
 *  - schema 与上游 chunk-1h2r50md.js 逐字对齐（动作枚举/必填/参数语义）
 *  - 纯逻辑层：键组合解析、键定义、批次执行器
 *  - 真浏览器 e2e（本机 Chrome/Edge，headless）：没有可执行文件时诚实跳过
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.MYCLAUDE_HOME = mkdtempSync(join(tmpdir(), "myclaude-computer-"));
const { computerTool, browserBatchTool, COMPUTER_TOOLS } = await import("../src/tools/extended.js");
const { parseKeyCombo, keyDef, findBrowserExecutable } = await import("../src/tools/browser-cdp.js");

test("schema：动作枚举与上游逐字一致（13 个动作）", () => {
  const upstream = ["left_click", "right_click", "type", "screenshot", "wait", "scroll", "key", "left_click_drag", "double_click", "triple_click", "zoom", "scroll_to", "hover"];
  assert.deepEqual(computerTool.input_schema.properties.action.enum, upstream);
  assert.deepEqual(computerTool.input_schema.required, ["action", "tabId"], "上游 tabId 必填");
  assert.equal(computerTool.input_schema.properties.scroll_amount.maximum, 10, "上游 scroll_amount 上限 10");
  assert.equal(computerTool.input_schema.properties.duration.maximum, 10, "上游 wait 上限 10 秒");
  assert.ok(computerTool.description.includes("Use a mouse and keyboard to interact with a web browser"), "描述用上游原文");
});

test("computer 工具族共 8 个工具，名称与上游一致", () => {
  assert.deepEqual(COMPUTER_TOOLS.map((t) => t.name),
    ["tabs_context_mcp", "tabs_create_mcp", "tabs_close_mcp", "computer", "navigate", "get_page_text", "resize_window", "browser_batch"]);
});

test("键组合解析：ctrl+a / cmd+shift+t / win 键", () => {
  assert.deepEqual(parseKeyCombo("ctrl+a"), { key: "a", flags: 2 });
  assert.deepEqual(parseKeyCombo("cmd+shift+t"), { key: "t", flags: 4 | 8 });
  assert.deepEqual(parseKeyCombo("alt+F4"), { key: "F4", flags: 1 });
  assert.equal(parseKeyCombo("win+r").flags, 4, "win 等价 meta");
  assert.deepEqual(parseKeyCombo("Enter"), { key: "Enter", flags: 0 });
});

test("键定义：命名键/功能键/单字符", () => {
  assert.equal(keyDef("Enter").windowsVirtualKeyCode, 13);
  assert.equal(keyDef("arrowdown").windowsVirtualKeyCode, 40);
  assert.equal(keyDef("F5").windowsVirtualKeyCode, 116, "F5 = 111+5");
  assert.equal(keyDef("x").key, "x", "单字符透传");
  assert.equal(keyDef("ctrl"), null, "修饰键不是主键");
});

test("browser_batch：顺序执行、遇错即停、不允许嵌套", async () => {
  // 无浏览器时 registry 内 computer 会抛错 —— 用 tabs_context_mcp 也一样。
  // 这里只测「结构性」分支：嵌套拒绝与未知工具。
  const nested = await browserBatchTool.run({ actions: [{ name: "browser_batch", input: { actions: [] } }] });
  assert.equal(nested.ok, false);
  assert.match(nested.content, /cannot be nested/);
  const unknown = await browserBatchTool.run({ actions: [{ name: "not_a_tool", input: {} }] });
  assert.equal(unknown.ok, false);
  assert.match(unknown.content, /unknown browser tool/);
  const empty = await browserBatchTool.run({ actions: [] });
  assert.equal(empty.ok, true, "空批次无操作即成功");
});

test("浏览器定位：找不到时返回 null（工具层报可操作错误）", () => {
  const r = findBrowserExecutable({ computerUse: { browserPath: "Z:/no/such/browser.exe" } });
  assert.equal(r, null, "配置了不存在的路径 → null");
  // 本机真实探测只验证不抛异常
  const real = findBrowserExecutable({});
  assert.ok(real === null || typeof real === "string");
});

test("真浏览器 e2e：启动 → 导航 data: URL → 截图 → 点击生效", async (t) => {
  const exe = findBrowserExecutable({});
  if (!exe) { t.skip("本机没有 Chrome/Edge — 诚实跳过"); return; }
  const { ensureBrowser, killBrowser, listTabs, runNavigate, runComputerAction, evaluateOn } = await import("../src/tools/browser-cdp.js");
  t.after(() => killBrowser());
  try {
    await ensureBrowser({});
  } catch (e) {
    t.skip(`浏览器拉不起来（${e.message}）— 诚实跳过`);
    return;
  }
  const page = `data:text/html,<html><body style="margin:0"><button id="b" style="position:absolute;left:20px;top:20px;width:120px;height:40px" onclick="document.title='CLICKED'">press me</button><div id="out" style="position:absolute;top:100px">hello world</div></body></html>`;
  const nav = await runNavigate({ url: page });
  assert.match(nav.content, /navigated/);

  const tabs = await listTabs();
  assert.ok(tabs.length >= 1);
  const tabId = tabs[0].tabId;

  // 截图：PNG magic bytes
  const shot = await runComputerAction({ action: "screenshot", tabId });
  assert.equal(shot.attachments[0].source.media_type, "image/png");
  const buf = Buffer.from(shot.attachments[0].source.data, "base64");
  assert.ok(buf.length > 1000, `截图非空（${buf.length} bytes）`);
  assert.equal(buf[0], 0x89, "PNG magic");

  // zoom：区域截图
  const zoom = await runComputerAction({ action: "zoom", region: [0, 0, 200, 200], tabId });
  assert.ok(Buffer.from(zoom.attachments[0].source.data, "base64").length > 100);

  // 点击：坐标 (80, 40) 在按钮内 → onclick 改 document.title
  await runComputerAction({ action: "left_click", coordinate: [80, 40], tabId });
  const { targetOf } = await import("../src/tools/browser-cdp.js");
  const title = await evaluateOn(targetOf(tabId), "document.title");
  assert.equal(title, "CLICKED", "CDP 鼠标事件真正点到了按钮");

  // 打字 + 滚动 + 悬停 + 等待：全部返回成功
  const typed = await runComputerAction({ action: "type", text: "abc", tabId });
  assert.match(typed.content, /typed 3 chars/);
  const scrolled = await runComputerAction({ action: "scroll", coordinate: [400, 300], scroll_direction: "down", tabId });
  assert.match(scrolled.content, /scrolled down/);
  const hover = await runComputerAction({ action: "hover", coordinate: [400, 300], tabId });
  assert.match(hover.content, /hover/);
  const waited = await runComputerAction({ action: "wait", duration: 0.1, tabId });
  assert.match(waited.content, /waited/);

  // get_page_text：正文提取
  const { runGetPageText } = await import("../src/tools/browser-cdp.js");
  const pageText = await runGetPageText({ tabId });
  assert.match(pageText.content, /hello world/);
}, { timeout: 90000 });
