/**
 * 分享与反馈的 HTTP 端点测试（对齐 claude.ai 的 share chat + message feedback）：
 *   POST /api/share → { token, url }
 *   GET  /share/<token> → 只读 HTML
 *   DELETE /api/share → 撤销
 *   POST/GET /api/feedback → 👍/👎 sidecar
 *   GET /api/session/export?format=html → 自包含 HTML 下载
 *
 * MYCLAUDE_HOME 指向一次性目录，端口用 0（内核分配）避免冲突。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOME = mkdtempSync(join(tmpdir(), "myclaude-guishare-home-"));
process.env.MYCLAUDE_HOME = HOME;
const { startGui } = await import("../src/ui/gui-server.js");

const SESSIONS_DIR = join(HOME, "sessions");

function writeSession(id, messages, extra = {}) {
  mkdirSync(SESSIONS_DIR, { recursive: true });
  const payload = {
    id,
    savedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...extra,
    messages,
  };
  writeFileSync(join(SESSIONS_DIR, id + ".json"), JSON.stringify(payload, null, 2), "utf8");
  return payload;
}

async function start() {
  const config = {
    provider: "openai",
    baseUrl: "http://127.0.0.1:1/v1",
    apiKey: "test",
    model: "test-model",
    permissionMode: "ask",
    vision: true,
    maxTurns: 6,
    contextWindow: 100000,
    compactThreshold: 0.8,
  };
  const { server, address } = await startGui({ config, port: 0, open: false, cwd: process.cwd() });
  return { gui: server, address };
}

async function stop(ctx) {
  await new Promise((r) => ctx.gui.close(r));
}

test("分享全链路：创建 → 只读页可访问 → 撤销后 404", async () => {
  const ctx = await start();
  try {
    writeSession("sh-1", [
      { role: "user", content: "分享测试问题" },
      { role: "assistant", content: "分享测试**回答**" },
    ], { title: "分享测试会话" });

    const cr = await fetch(ctx.address + "/api/share", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "sh-1" }),
    }).then((r) => r.json());
    assert.equal(cr.ok, true);
    assert.match(cr.token, /^[0-9a-f]{16}$/);
    assert.equal(cr.url, "/share/" + cr.token);

    const page = await fetch(ctx.address + cr.url).then((r) => {
      assert.equal(r.status, 200);
      return r.text();
    });
    assert.ok(page.includes("分享测试会话"));
    assert.ok(page.includes("<strong>回答</strong>"), "markdown rendered in share page");
    assert.ok(page.includes("只读快照"));

    // 再次分享：同 token（一个会话一个链接）
    const again = await fetch(ctx.address + "/api/share", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "sh-1" }),
    }).then((r) => r.json());
    assert.equal(again.token, cr.token);
    assert.equal(again.updated, true);

    const revoke = await fetch(ctx.address + "/api/share", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "sh-1" }),
    }).then((r) => r.json());
    assert.equal(revoke.removed, 1);

    const after = await fetch(ctx.address + cr.url);
    assert.equal(after.status, 404, "revoked share must stop resolving");
  } finally {
    await stop(ctx);
  }
});

test("消息反馈：写入→读回→取消", async () => {
  const ctx = await start();
  try {
    const digest = "abc123";
    const up = await fetch(ctx.address + "/api/feedback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: "fb-1", digest, fb: "up" }),
    }).then((r) => r.json());
    assert.equal(up.ok, true);
    assert.equal(up.fb, "up");

    const got = await fetch(ctx.address + "/api/feedback?sessionId=fb-1").then((r) => r.json());
    assert.equal(got.feedback[digest], "up");

    const clear = await fetch(ctx.address + "/api/feedback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: "fb-1", digest, fb: null }),
    }).then((r) => r.json());
    assert.equal(clear.fb, null);
    const got2 = await fetch(ctx.address + "/api/feedback?sessionId=fb-1").then((r) => r.json());
    assert.deepEqual(got2.feedback, {});
  } finally {
    await stop(ctx);
  }
});

test("导出 HTML：Content-Disposition 附件 + 自包含正文", async () => {
  const ctx = await start();
  try {
    writeSession("exp-1", [
      { role: "user", content: "导出测试" },
      { role: "assistant", content: "```js\nvar a = 1;\n```" },
    ], { title: "导出测试会话" });

    const res = await fetch(ctx.address + "/api/session/export?format=html&id=exp-1");
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-disposition") || "", /attachment/);
    assert.match(res.headers.get("content-disposition") || "", /myclaude-exp-1\.html/);
    const html = await res.text();
    assert.ok(html.includes("导出测试会话"));
    assert.ok(html.includes("tok-k"), "syntax-highlighted code present");
  } finally {
    await stop(ctx);
  }
});

test("未知会话分享返回 404，未知 token 页面 404", async () => {
  const ctx = await start();
  try {
    const nf = await fetch(ctx.address + "/api/share", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "nope" }),
    });
    assert.equal(nf.status, 404);
    const bad = await fetch(ctx.address + "/share/0000000000000000");
    assert.equal(bad.status, 404);
  } finally {
    await stop(ctx);
  }
});
