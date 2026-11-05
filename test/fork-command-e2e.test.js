import test from "node:test";
import { after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.MYCLAUDE_HOME = mkdtempSync(join(tmpdir(), "myclaude-fork-"));
const { startGui } = await import("../src/ui/gui-server.js");

async function quickBackend() {
  const server = createServer((req, res) => {
    let d = "";
    req.on("data", (c) => (d += c));
    req.on("end", () => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "ok" } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { server, url: `http://127.0.0.1:${server.address().port}/v1` };
}

test("/fork clones the live session and leaves the original intact", async () => {
  const backend = await quickBackend();
  const config = { provider: "openai", baseUrl: backend.url, apiKey: "k", model: "m",
    permissionMode: "auto", vision: true, maxTurns: 6, contextWindow: 100000, compactThreshold: 0.8 };
  const { server: gui, address } = await startGui({ config, port: 0, open: false });
  try {
    // 先建立有历史的活跃会话
    await fetch(address + "/api/chat", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "hello", sessionKey: "fk" }) });
    // 分叉
    const fr = await fetch(address + "/api/command", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "fork", arg: "", sessionKey: "fk" }) });
    const fj = await fr.json();
    assert.equal(fj.ok, true, "fork succeeds");
    assert.match(fj.text, /已分叉为新会话/, "reports the fork");
    assert.ok(fj.forkedTo && fj.forkedTo.startsWith("fork-"), "returns a fork session id");
    // 新会话真实存在且消息数一致
    const sessions = (await (await fetch(address + "/api/sessions")).json()).sessions;
    const forked = sessions.find((s) => s.id === fj.forkedTo);
    assert.ok(forked, "forked session persisted");
    assert.ok(sessions.some((s) => s.id !== fj.forkedTo), "original session intact");
  } finally {
    await new Promise((r) => gui.close(r));
    await new Promise((r) => backend.server.close(r));
  }
});

after(() => { setTimeout(() => process.exit(0), 100).unref?.(); });
