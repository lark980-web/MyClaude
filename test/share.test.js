/**
 * 分享快照单元测试：createShare/getShare/listShares/撤销/快照渲染。
 *
 * MYCLAUDE_HOME 指向一次性目录，绝不碰真实 ~/.myclaude/。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOME = mkdtempSync(join(tmpdir(), "myclaude-share-home-"));
process.env.MYCLAUDE_HOME = HOME;
// ESM import 提升，share.js 读取的 CONFIG_DIR 依赖环境变量，必须动态加载。
const {
  createShare,
  getShare,
  listShares,
  findShareToken,
  deleteSharesForSession,
  renderSharePage,
  renderTranscriptHtml,
  MAX_SHARE_BYTES,
} = await import("../src/share.js");

const MSGS = [
  { role: "user", content: "帮我写一个番茄钟" },
  { role: "assistant", content: "# 番茄钟\n\n这是**代码**：\n\n```js\nconsole.log(\"tick\");\n```\n" },
];

test("createShare 生成可读取的快照，重复分享复用同一 token", () => {
  const first = createShare("sess-a", { title: "番茄钟对话", messages: MSGS });
  assert.match(first.token, /^[0-9a-f]{16}$/);
  assert.equal(first.updated, false);

  const snap = getShare(first.token);
  assert.ok(snap, "snapshot should round-trip");
  assert.equal(snap.sessionId, "sess-a");
  assert.equal(snap.title, "番茄钟对话");
  assert.equal(snap.messages.length, 2);

  const second = createShare("sess-a", { title: "番茄钟对话", messages: [...MSGS, { role: "user", content: "再加个统计" }] });
  assert.equal(second.token, first.token, "same session reuses its token");
  assert.equal(second.updated, true);
  const updated = getShare(first.token);
  assert.equal(updated.messages.length, 3, "snapshot content is replaced");
});

test("getShare 对未知/非法 token 返回 null", () => {
  assert.equal(getShare("deadbeefdeadbeef"), null);
  assert.equal(getShare("../escape"), null);
  assert.equal(getShare(""), null);
  assert.equal(getShare(null), null);
});

test("findShareToken 与 deleteSharesForSession", () => {
  createShare("sess-b", { title: "B", messages: MSGS });
  assert.equal(findShareToken("sess-b"), findShareToken("sess-b"));
  assert.equal(findShareToken("missing"), null);
  assert.equal(listShares().some((s) => s.sessionId === "sess-b"), true);

  const removed = deleteSharesForSession("sess-b");
  assert.equal(removed, 1);
  assert.equal(findShareToken("sess-b"), null);
});

test("超大快照被截断而不是失败", () => {
  const big = [{ role: "user", content: "x".repeat(MAX_SHARE_BYTES + 1024) }];
  const { token } = createShare("sess-big", { title: "big", messages: big });
  const snap = getShare(token);
  assert.ok(snap.truncated, "marks truncation");
  assert.ok(JSON.stringify(snap).length <= MAX_SHARE_BYTES + 4096, "stored body stays bounded");
});

test("renderTranscriptHtml 跳过工具消息并渲染 markdown", () => {
  const html = renderTranscriptHtml([
    ...MSGS,
    { role: "tool", tool_call_id: "t1", content: "secret tool output" },
  ]);
  assert.ok(html.includes("番茄钟"), "user text present");
  assert.ok(html.includes("<strong>代码</strong>"), "markdown rendered");
  assert.ok(!html.includes("secret tool output"), "tool rows excluded");
});

test("renderSharePage 输出自包含 HTML（无外链、带标题）", () => {
  const page = renderSharePage({ title: "快照标题", messages: MSGS, token: "abcd1234abcd1234", cwd: "E:/x", model: "test" });
  assert.ok(page.includes("<!doctype html>"));
  assert.ok(page.includes("快照标题"));
  assert.ok(page.includes("只读快照"));
  assert.ok(!/<link|<script src=/.test(page), "no external assets");
  assert.ok(existsSync(join(HOME, "shares")));
  assert.ok(readdirSync(join(HOME, "shares")).length >= 1);
});
