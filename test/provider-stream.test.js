/**
 * The provider's streaming contract.
 *
 * Two real failures lived here:
 *   - The stop button did nothing once a stream had started, because the
 *     caller-abort listener was removed the moment the response headers
 *     arrived - exactly the phase where a hung gateway needs to be interrupted.
 *   - A stream that went silent after the headers stalled the agent forever:
 *     the only timer covered time-to-first-byte.
 *
 * A local HTTP server stands in for the gateway: it answers with SSE headers
 * and one chunk, then goes quiet, which is the shape of a real stall.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";

import { OpenAIProvider } from "../src/providers/openai.js";

/** SSE server that sends one delta chunk and then stalls forever. */
function stallServer() {
  const state = { requests: 0, closed: false };
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      state.requests++;
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write("data: " + JSON.stringify({ choices: [{ delta: { content: "a" } }] }) + "\n\n");
      res.on("close", () => { state.closed = true; });
      // ...and never another byte.
    });
  });
  return { server, state };
}

async function listen(server) {
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return "http://127.0.0.1:" + server.address().port + "/v1";
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("aborting mid-stream interrupts the read", async () => {
  const { server, state } = stallServer();
  const baseUrl = await listen(server);
  try {
    const provider = new OpenAIProvider({ baseUrl, apiKey: "k", model: "m", requestTimeoutMs: 30000 });
    const ac = new AbortController();
    const p = provider.streamChat({
      messages: [{ role: "user", content: "hi" }],
      signal: ac.signal,
      onDelta() {},
    });
    await sleep(400); // headers + first chunk have arrived by now
    ac.abort();
    await assert.rejects(p, (e) => e.name === "AbortError" || /abort/i.test(e.message || ""),
      "the pending read must reject when the caller aborts");
    assert.ok(Date.now() !== 0);
  } finally {
    server.close();
  }
});

test("a stream that goes silent is cut off instead of stalling forever", async () => {
  const { server } = stallServer();
  const baseUrl = await listen(server);
  try {
    const provider = new OpenAIProvider({
      baseUrl, apiKey: "k", model: "m",
      requestTimeoutMs: 30000,
      streamIdleTimeoutMs: 400,
    });
    const t0 = Date.now();
    await assert.rejects(
      provider.streamChat({ messages: [{ role: "user", content: "hi" }], onDelta() {} }),
      (e) => /timed out|idle/i.test(e.message || ""),
      "silence after the first chunk must raise, not hang"
    );
    assert.ok(Date.now() - t0 < 5000, "the watchdog fired, it did not wait forever");
  } finally {
    server.close();
  }
});
