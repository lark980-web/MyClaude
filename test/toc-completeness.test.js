import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const app = readFileSync(new URL("../src/ui/web/js/app.js", import.meta.url), "utf8");
const css = readFileSync(new URL("../src/ui/web/css/styles.css", import.meta.url), "utf8");

// 会话恢复只渐进渲染最后 REPLAY_CHUNK 条；目录若按 DOM 取列表就只剩那一小截。
// 回归：目录必须按 S._replayMsgs 的数据构建，并为未渲染条目提供加载路径。
// （live 会话的数据源由 addUserMessage 追加 —— 见 gui-catalog-toolcard.test.js）
test("the message TOC is built from the full message data, not the rendered DOM", () => {
  // 锚点用目录构建处的完整注释 ——「消息目录」四字也出现在 addUserMessage 的
  // live-push 注释里，裸 indexOf 会锚错位置。
  const i = app.indexOf("消息目录：长对话");
  assert.ok(i > 0, "TOC block present");
  const block = app.slice(i, i + 2400);
  assert.ok(block.includes("S._replayMsgs"), "TOC reads the full message array");
  assert.ok(block.includes(".msg-user"), "still falls back to DOM when no data yet");
});

test("rendered user nodes carry their source index so the TOC can find them", () => {
  assert.match(app, /madeNode\.dataset\.srcIdx = String\(j\)/, "nodes tagged with srcIdx");
  assert.ok(app.includes("data-src-idx"), "TOC looks nodes up by that index");
});

test("clicking an unrendered TOC entry loads it in batches instead of freezing", () => {
  assert.ok(app.includes("function loadUntilRendered"), "helper present");
  const i = app.indexOf("function loadUntilRendered");
  const fn = app.slice(i, i + 700);
  assert.ok(fn.includes("loadEarlierReplay()"), "reuses the batch loader");
  assert.ok(fn.includes("setTimeout(step"), "yields between batches, never one huge sync render");
  assert.ok(fn.includes("tries++ > 40"), "bounded, no infinite loop");
});

test("jumping after a batch load scrolls explicitly, not with smooth scroll", () => {
  const i = app.indexOf("function flashToNode");
  const fn = app.slice(i, i + 900);
  assert.ok(fn.includes("stream.scrollTop +="), "computes scrollTop itself");
  assert.ok(fn.includes("instant"), "has an instant path");
  assert.match(app, /flashToNode\(node2, true\)/, "batch-load path uses instant");
});

test("unloaded TOC entries are visually distinguishable", () => {
  assert.match(css, /\.toc-row\.is-unloaded \{ opacity: \.55; \}/, "dimmed style present");
});
