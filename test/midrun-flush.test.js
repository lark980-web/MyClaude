/**
 * A force-closed process must not lose the whole in-flight turn.
 *
 * The saver used to run only at turn end, so a 30-minute task killed at
 * minute 29 lost everything. The chat handler now flushes every 2.5s; this
 * test hangs a run, waits past two flush windows, and asserts the user
 * message reached the disk while the run was still in flight.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("mid-run flush persists the turn while it is still running", async () => {
  const home = mkdtempSync(join(tmpdir(), "myclaude-flush-"));
  process.env.MYCLAUDE_HOME = home;
  const { startGui } = await import("../src/ui/gui-server.js");
  const state = { hang: true };
  const backend = createServer((req, res) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      if (state.hang) { res.writeHead(200, { "Content-Type": "text/event-stream" }); return; }
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write("data: " + JSON.stringify({ choices: [{ delta: { content: "done" } }] }) + "\n\n");
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  await new Promise((r) => backend.listen(0, "127.0.0.1", r));
  const config = { provider: "openai", baseUrl: `http://127.0.0.1:${backend.address().port}/v1`,
    apiKey: "k", model: "test-model", permissionMode: "auto", maxTurns: 3,
    contextWindow: 100000, compactThreshold: 0.8, vision: true };
  const { server, address } = await startGui({ config, port: 0, open: false });
  try {
    const PROBE = "持久化探针-midrun-8f3a";
    const ctrl = new AbortController();
    const pending = fetch(address + "/api/chat", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: PROBE, sessionKey: "flush" }), signal: ctrl.signal,
    }).catch(() => null);
    // 等两个刷盘窗口（2.5s 间隔）+ 余量
    await new Promise((r) => setTimeout(r, 6000));
    const dir = join(home, "sessions"); // MYCLAUDE_HOME 直接就是配置目录
    let found = false;
    for (const f of readdirSync(dir)) {
      try { if (readFileSync(join(dir, f), "utf8").includes(PROBE)) { found = true; break; } } catch {}
    }
    assert.ok(found, "the user message must be on disk while the run is still hanging");
    // 收尾：模拟浏览器消失 —— 断连即停让 run 快速结束
    ctrl.abort();
    await pending;
  } finally {
    await new Promise((r) => server.close(r));
    await new Promise((r) => backend.close(r));
  }
});
