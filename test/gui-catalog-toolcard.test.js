import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const app = readFileSync(join(ROOT, "src", "ui", "web", "js", "app.js"), "utf8");
const css = readFileSync(join(ROOT, "src", "ui", "web", "css", "styles.css"), "utf8");

test("newChat 重置重放状态：目录不残留旧会话，点击不再把旧消息注入新对话", () => {
  // 残留的 _replayMsgs 会让数据分支一直命中旧数组；loadUntilRendered 还会
  // 把旧区间 prepend 进清空后的 DOM。
  const nc = app.slice(app.indexOf("function newChat"));
  assert.match(nc, /S\._replayMsgs = \[\];/);
  assert.match(nc, /S\._replayStart = 0;/);
});

test("addUserMessage 在 live 路径写入目录数据源并打 srcIdx", () => {
  assert.match(app, /if \(!S\.replayingHistory\) \{/);
  assert.match(app, /S\._replayMsgs\.push\(\{ role: "user", content: text \}\)/);
  assert.match(app, /wrap\.dataset\.srcIdx = String\(S\._replayMsgs\.length - 1\)/);
});

test("renderReplayRange 全程置位 replayingHistory（loadEarlier 不产生重复 push）", () => {
  assert.match(app, /function renderReplayRangeInner/);
  assert.match(app, /S\.replayingHistory = prevReplaying/);
});

test("目录跳转的数据锚点在重放路径仍有赋值（dataset.srcIdx）", () => {
  assert.match(app, /madeNode\.dataset\.srcIdx = String\(j\)/);
});

test("目录跳过无文本提问（无可渲染气泡的死行）", () => {
  assert.match(app, /if \(!raw\.trim\(\)\) \{ return; \}/);
});

test("工具卡折叠预览：3 行 + 省略行，展开后隐藏预览", () => {
  assert.match(app, /function toolPreviewLines/);
  assert.match(app, /lines\.length <= 3/);
  assert.match(app, /tool-preview-line is-more/);
  assert.match(app, /renderToolPreview\(card, text\)/);
  assert.match(app, /var preview = el\("div", "tool-preview"\)/);
  assert.match(app, /box\.appendChild\(preview\)/);
  assert.match(css, /\.tool\.open \.tool-preview \{ display: none; \}/);
});

test("工具卡展开态输出上限 = 上游 BASH_MAX_OUTPUT_LENGTH 默认 30000", () => {
  // 上游 chunk-1wyh415r.js：DCr=30000（默认）、Uwo=150000（上限）
  assert.match(app, /TOOL_OUT_CAP = 30000/);
  assert.match(app, /已截断显示前/);
});
