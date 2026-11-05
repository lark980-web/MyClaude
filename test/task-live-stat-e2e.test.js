/**
 * End-to-end: /api/chat must stream progress events while the model is busy.
 * Uses a deliberately slow mock backend so the 1s progress interval fires.
 */
import test from "node:test";
import { after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.MYCLAUDE_HOME = mkdtempSync(join(tmpdir(), "myclaude-live-"));
const { startGui } = await import("../src/ui/gui-server.js");

async function slowBackend(delayMs) {
  const server = createServer((req, res) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      setTimeout(() => {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "ok" } }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`);
        res.write("data: [DONE]\n\n");
        res.end();
      }, delayMs);
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { server, url: `http://127.0.0.1:${server.address().port}/v1` };
}

test("a running task emits progress with elapsed time and token counters", async () => {
  const backend = await slowBackend(1400);
  const config = { provider: "openai", baseUrl: backend.url, apiKey: "test", model: "m",
    permissionMode: "auto", vision: true, maxTurns: 6, contextWindow: 100000, compactThreshold: 0.8 };
  const { server: gui, address } = await startGui({ config, port: 0, open: false });
  try {
    const res = await fetch(address + "/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "hi", sessionKey: "live-e2e" }),
    });
    assert.equal(res.status, 200);
    const events = (await res.text()).split("\n")
      .filter((l) => l.startsWith("data:"))
      .map((l) => JSON.parse(l.slice(5).trim()));
    const progress = events.filter((e) => e.type === "progress");
    assert.ok(progress.length >= 1, "at least one progress event during the slow turn");
    const p = progress[0];
    assert.ok(typeof p.elapsedMs === "number" && p.elapsedMs >= 0, "elapsedMs present");
    assert.ok(typeof p.inputTokens === "number", "inputTokens present");
    assert.ok(typeof p.outputTokens === "number", "outputTokens present");
    assert.ok(events.some((e) => e.type === "done"), "turn still completes");
  } finally {
    await new Promise((r) => gui.close(r));
    await new Promise((r) => backend.server.close(r));
  }
});

after(() => { setTimeout(() => process.exit(0), 100).unref?.(); });
