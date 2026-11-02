/**
 * Tests for the full-text search endpoint added in 0.19: /api/search scans the
 * saved sessions and returns matching message excerpts.
 *
 * MYCLAUDE_HOME points at a throw-away directory so these tests never touch
 * the user's real ~/.myclaude/ session history.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOME = mkdtempSync(join(tmpdir(), "myclaude-home-"));
process.env.MYCLAUDE_HOME = HOME;
// ESM imports hoist, so the module is loaded dynamically *after* MYCLAUDE_HOME
// is in place; otherwise the config path would already be resolved.
const { startGui } = await import("../src/ui/gui-server.js");

const SESSIONS_DIR = join(HOME, "sessions");

/** Write one session file straight to disk so the search has something to read. */
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

const search = (address, q) =>
  fetch(address + "/api/search?q=" + encodeURIComponent(q)).then((r) => r.json());

test("search returns the matching message with its session and role", async () => {
  const ctx = await start();
  try {
    writeSession("s-one", [
      { role: "user", content: "帮我把 A股 分析脚本跑起来" },
      { role: "assistant", content: "好的，我先读取 package.json" },
    ], { title: "股票分析" });

    const j = await search(ctx.address, "A股");
    assert.equal(j.query, "A股");
    assert.ok(j.results.length >= 1, "expected at least one hit");
    const hit = j.results.find((r) => r.sessionId === "s-one");
    assert.ok(hit, "hit should point at the session that matched");
    assert.equal(hit.role, "user");
    assert.equal(hit.title, "股票分析");
    assert.ok(hit.snippet.includes("A股"), "snippet keeps the matched text: " + hit.snippet);
  } finally {
    await stop(ctx);
  }
});

test("search matches assistant messages and keeps the surrounding context", async () => {
  const ctx = await start();
  try {
    writeSession("s-two", [
      { role: "user", content: "你好" },
      { role: "assistant", content: "前面是铺垫文字，然后是关键词 火箭发射，再是后续内容" },
    ]);

    const j = await search(ctx.address, "火箭发射");
    const hit = j.results.find((r) => r.sessionId === "s-two");
    assert.ok(hit, "expected a hit in s-two");
    assert.equal(hit.role, "assistant");
    assert.ok(hit.snippet.includes("火箭发射"));
    // The snippet should keep text around the hit, not just the bare match.
    assert.ok(hit.snippet.includes("铺垫文字"), "keeps leading context");
  } finally {
    await stop(ctx);
  }
});

test("search is case insensitive and ignores the query when it is blank", async () => {
  const ctx = await start();
  try {
    writeSession("s-three", [{ role: "user", content: "Deploy the Service Now" }]);

    const j = await search(ctx.address, "deploy the service");
    assert.ok(j.results.some((r) => r.sessionId === "s-three"), "case-insensitive match");

    const blank = await search(ctx.address, "");
    assert.deepEqual(blank.results, []);
    assert.equal(blank.query, "");
  } finally {
    await stop(ctx);
  }
});

test("search returns nothing for a term that appears in no session", async () => {
  const ctx = await start();
  try {
    writeSession("s-four", [{ role: "user", content: "无关内容" }]);
    const j = await search(ctx.address, "zzz-not-present-zzz");
    assert.equal(j.results.length, 0);
  } finally {
    await stop(ctx);
  }
});

test("search handles structured (array) message content", async () => {
  const ctx = await start();
  try {
    writeSession("s-five", [
      { role: "assistant", content: [{ type: "text", text: "结构化内容里的关键词 索引测试" }] },
    ]);

    const j = await search(ctx.address, "索引测试");
    const hit = j.results.find((r) => r.sessionId === "s-five");
    assert.ok(hit, "array content should be searched too");
    assert.ok(hit.snippet.includes("索引测试"));
  } finally {
    await stop(ctx);
  }
});
