/**
 * /effort must reach the wire.
 *
 * config.effort was a dead setting: stored, displayed, and read by nothing.
 * The provider now forwards high|medium|low as the standard reasoning_effort
 * request field; off and unset send exactly the old request, so gateways that
 * do not know the field are not disturbed. The GUI thinking toggle drives the
 * same config, which is what makes it one setting with two entry points.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.MYCLAUDE_HOME = mkdtempSync(join(tmpdir(), "myclaude-effort-"));
const { OpenAIProvider } = await import("../src/providers/openai.js");
const { startGui } = await import("../src/ui/gui-server.js");

/** Provider backend that records request bodies and answers once. */
function captureBackend() {
  const state = { bodies: [] };
  const server = createServer((req, res) => {
    let d = "";
    req.on("data", (c) => (d += c));
    req.on("end", () => {
      try { state.bodies.push(JSON.parse(d)); } catch {}
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: "ok" } }] }) + "\n\n");
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  return { server, state };
}

async function listen(server) {
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return "http://127.0.0.1:" + server.address().port + "/v1";
}

test("effort high reaches the request body", async () => {
  const { server, state } = captureBackend();
  const baseUrl = await listen(server);
  try {
    const provider = new OpenAIProvider({ baseUrl, apiKey: "k", model: "m", effort: "high" });
    await provider.streamChat({ messages: [{ role: "user", content: "hi" }], onDelta() {} });
    assert.equal(state.bodies[0].reasoning_effort, "high");
  } finally { server.close(); }
});

test("off and unset send no reasoning_effort field", async () => {
  const { server, state } = captureBackend();
  const baseUrl = await listen(server);
  try {
    for (const effort of ["off", null, undefined]) {
      const provider = new OpenAIProvider({ baseUrl, apiKey: "k", model: "m", effort });
      await provider.streamChat({ messages: [{ role: "user", content: "hi" }], onDelta() {} });
      const body = state.bodies[state.bodies.length - 1];
      assert.equal(body.reasoning_effort, undefined, "effort=" + effort + " must send nothing");
    }
  } finally { server.close(); }
});

test("the thinking toggle and /effort drive one setting", async () => {
  const { server, state } = captureBackend();
  const baseUrl = await listen(server);
  const { server: gui, address } = await startGui({
    config: { provider: "openai", baseUrl, apiKey: "k", model: "m", permissionMode: "auto", maxTurns: 4 },
    port: 0, open: false,
  });
  try {
    // The thinking toggle posts effort, like the button now does.
    const post = await fetch(address + "/api/config", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ effort: "high" }),
    });
    assert.equal(post.status, 200);
    const cfg = await (await fetch(address + "/api/config")).json();
    assert.equal(cfg.effort, "high", "the setting is visible to the UI");
    // The next chat carries it to the provider.
    await fetch(address + "/api/chat", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "hi" }),
    }).then((r) => r.text());
    const body = state.bodies[state.bodies.length - 1];
    assert.equal(body.reasoning_effort, "high", "the setting reaches the wire");
  } finally { gui.close(); server.close(); }
});

test("an unknown effort is refused rather than stored", async () => {
  const { server } = captureBackend();
  const baseUrl = await listen(server);
  const { server: gui, address } = await startGui({
    config: { provider: "openai", baseUrl, apiKey: "k", model: "m" },
    port: 0, open: false,
  });
  try {
    await fetch(address + "/api/config", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ effort: "ultra" }),
    });
    const cfg = await (await fetch(address + "/api/config")).json();
    assert.equal(cfg.effort, null, "an unknown level must not be stored");
  } finally { gui.close(); server.close(); }
});
