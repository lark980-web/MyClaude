/**
 * Hitting the turn cap must be an actionable event, not a silent stop.
 *
 * "reached max turns (100)" used to be the last thing a stuck run ever said:
 * no event reached the browser, so the UI looked like the task had simply
 * died. The backend now emits max_turns, which the frontend renders as a
 * one-click continue.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "myclaude-maxturns-"));
process.env.MYCLAUDE_HOME = home;
const { startGui } = await import("../src/ui/gui-server.js");

async function mockBackend() {
  const server = createServer((req, res) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      // Always answer with a tool call: with maxTurns=1 the single turn is
      // consumed by the call and the run stops at the cap.
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write("data: " + JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "t1", function: { name: "Echo", arguments: "{}" } }] } }] }) + "\n\n");
      res.write("data: " + JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }) + "\n\n");
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { server, url: `http://127.0.0.1:${server.address().port}/v1` };
}

test("a run stopped by the turn cap emits a max_turns event", async () => {
  const backend = await mockBackend();
  const config = {
    provider: "openai", baseUrl: backend.url, apiKey: "test",
    model: "test-model", permissionMode: "auto", maxTurns: 1,
    contextWindow: 100000, compactThreshold: 0.8, vision: true,
  };
  const { server, address } = await startGui({ config, port: 0, open: false });
  try {
    const res = await fetch(address + "/api/chat", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "go", sessionKey: "cap" }),
    });
    const events = (await res.text()).split("\n").filter((l) => l.startsWith("data:"))
      .map((l) => { try { return JSON.parse(l.slice(5).trim()); } catch { return null; } })
      .filter(Boolean);
    const capped = events.find((e) => e.type === "max_turns");
    assert.ok(capped, "the cap is reported to the browser");
    assert.equal(capped.limit, 1);
    assert.ok(events.some((e) => e.type === "done"), "and the turn still closes cleanly");
  } finally {
    await new Promise((r) => server.close(r));
    await new Promise((r) => backend.server.close(r));
  }
});
