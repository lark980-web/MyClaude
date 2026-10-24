/**
 * One run per session, and a stop button that works through the GUI.
 *
 * The backend had no guard, so a second send while a task was running put two
 * loops on one agent. And once a stream had started, /api/abort could not reach
 * it (see provider-stream tests), which is the "stop button does nothing"
 * report. Both are pinned here against the real server with a hanging backend.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.MYCLAUDE_HOME = mkdtempSync(join(tmpdir(), "myclaude-busy-"));
const { startGui } = await import("../src/ui/gui-server.js");

/** Provider backend that answers with one chunk and then hangs. */
function hangingBackend() {
  return createServer((req, res) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write("data: " + JSON.stringify({ choices: [{ delta: { content: "a" } }] }) + "\n\n");
      // never [DONE], never end
    });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("a second send on a running session is refused, and stop still works", async () => {
  const backend = hangingBackend();
  await new Promise((r) => backend.listen(0, "127.0.0.1", r));
  const { server, address } = await startGui({
    config: { provider: "openai", baseUrl: "http://127.0.0.1:" + backend.address().port + "/v1", apiKey: "k", model: "m", permissionMode: "auto", maxTurns: 4 },
    port: 0,
    open: false,
  });

  try {
    // First send: starts and then stalls in the stream.
    const first = await fetch(address + "/api/chat", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "hi" }),
    });
    assert.equal(first.status, 200);
    const reader = first.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    const readUntil = async (want) => {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return "closed";
        buf += dec.decode(value, { stream: true });
        if (buf.includes(want)) return want;
      }
    };
    // The stall means no done event yet; give the run a moment to be in flight.
    await sleep(400);

    // Second send on the same session must be refused, not queued on the agent.
    const second = await fetch(address + "/api/chat", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "again" }),
    });
    assert.equal(second.status, 409, "a running session refuses a second run");

    // Stop must reach the hung stream and end the first request with done.
    await fetch(address + "/api/abort", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionKey: "default" }),
    });
    const end = await Promise.race([readUntil('"done"'), sleep(6000).then(() => "timeout")]);
    assert.equal(end, '"done"', "abort reached the stream and the turn ended");

    // The slot is free again once the run is over.
    const third = await fetch(address + "/api/chat", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "third" }),
    });
    assert.equal(third.status, 200, "the session accepts a new run after stop");
    await third.body.cancel().catch(() => {});
  } finally {
    server.close();
    backend.close();
  }
});
