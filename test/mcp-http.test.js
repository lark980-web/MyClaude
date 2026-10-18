/**
 * MCP HTTP transport tests.
 *
 * A mock server implements both wire formats (Streamable HTTP and the legacy
 * split SSE protocol) so the client's negotiation is exercised end to end
 * without reaching a third-party endpoint.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { McpClient, McpManager, createTransport } from "../src/mcp/client.js";
import { StreamableHttpTransport, SseHttpTransport } from "../src/mcp/http-transport.js";

const TOOL_RESULT = { content: [{ type: "text", text: "pong from mcp" }] };

/**
 * Mock MCP server.
 * mode "streamable": POST /mcp answers JSON directly.
 * mode "sse":        GET /mcp opens a stream, POST /mcp?message returns 202
 *                    and the reply is pushed down the stream.
 */
function mockServer(mode) {
  const state = { requests: [], streams: [] };
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    if (mode === "sse" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
      res.write("event: endpoint\ndata: /mcp?session=abc\n\n");
      state.streams.push(res);
      req.on("close", () => {
        const i = state.streams.indexOf(res);
        if (i >= 0) state.streams.splice(i, 1);
      });
      return;
    }
    if (mode === "sse" && req.method === "POST") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const msg = JSON.parse(body || "{}");
        state.requests.push(msg);
        res.writeHead(202).end();
        if (msg.id != null && state.streams.length) {
          const reply = replyFor(msg, mode);
          state.streams[0].write("event: message\ndata: " + JSON.stringify(reply) + "\n\n");
        }
      });
      return;
    }
    // streamable
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const msg = JSON.parse(body || "{}");
      state.requests.push(msg);
      if (msg.id == null) { res.writeHead(202).end(); return; }
      const reply = replyFor(msg, mode);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(reply));
    });
  });
  return { server, state };
}

function replyFor(msg, mode) {
  if (msg.method === "initialize") {
    return {
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        protocolVersion: "2024-11-05",
        serverInfo: { name: "mock-" + mode, version: "1.0" },
        capabilities: { tools: {} },
      },
    };
  }
  if (msg.method === "tools/list") {
    return {
      jsonrpc: "2.0",
      id: msg.id,
      result: { tools: [{ name: "ping", description: "Ping the server", inputSchema: { type: "object", properties: {} } }] },
    };
  }
  if (msg.method === "tools/call") {
    return { jsonrpc: "2.0", id: msg.id, result: TOOL_RESULT };
  }
  return { jsonrpc: "2.0", id: msg.id, result: {} };
}

async function listen(server) {
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return "http://127.0.0.1:" + server.address().port + "/mcp";
}

test("createTransport picks stdio, streamable or sse from the spec", () => {
  assert.equal(createTransport("a", { command: "node", args: ["x"] })?.constructor.name, "StdioTransport");
  assert.ok(createTransport("b", { url: "http://x/mcp" }) instanceof StreamableHttpTransport);
  assert.ok(createTransport("c", { url: "http://x/mcp", transport: "sse" }) instanceof SseHttpTransport);
  assert.throws(() => createTransport("d", {}), /command|url/);
});

test("McpClient talks to a Streamable HTTP server", async () => {
  const { server, state } = mockServer("streamable");
  const url = await listen(server);
  try {
    const client = new McpClient("mcp1", { url });
    await client.connect();
    assert.equal(client.serverInfo.name, "mock-streamable");
    assert.equal(client.tools.length, 1);
    assert.equal(client.tools[0].name, "ping");

    const out = await client.callTool("ping", {});
    assert.match(out.content, /pong from mcp/);
    // initialize -> notifications/initialized -> tools/list -> tools/call
    const methods = state.requests.map((r) => r.method);
    assert.deepEqual(methods, ["initialize", "notifications/initialized", "tools/list", "tools/call"]);
    client.close();
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test("McpClient talks to a legacy SSE server", async () => {
  const { server, state } = mockServer("sse");
  const url = await listen(server);
  try {
    const client = new McpClient("mcp2", { url, transport: "sse" });
    await client.connect();
    assert.equal(client.serverInfo.name, "mock-sse");
    assert.equal(client.tools.length, 1);

    const out = await client.callTool("ping", {});
    assert.match(out.content, /pong from mcp/);
    assert.ok(state.requests.some((r) => r.method === "initialize"));
    client.close();
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test("a Streamable attempt against an SSE-only server falls back and still works", async () => {
  // The mock answers POST /mcp in JSON, so to force the fallback we point the
  // client at a path that 404s for Streamable but exists for the SSE handshake.
  const { server, state } = mockServer("sse");
  const url = await listen(server);
  try {
    const client = new McpClient("mcp3", { url });
    // Pre-seed a transport that fails on request to simulate a 405 server.
    client.transport = {
      start: async () => {},
      request: async () => { throw new Error("405 Method Not Allowed"); },
      notify: () => {},
      close: () => {},
    };
    await client.connect();
    assert.ok(client.transport instanceof SseHttpTransport, "fell back to SSE");
    assert.equal(client.tools.length, 1);
    assert.ok(state.requests.some((r) => r.method === "initialize"));
    client.close();
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test("McpManager loads url servers and reports failures cleanly", async () => {
  const ok = mockServer("streamable");
  const okUrl = await listen(ok.server);
  try {
    const mgr = new McpManager();
    const results = await mgr.loadFromConfig({
      good: { url: okUrl },
      bad: {},                       // no command, no url
      off: { url: "http://127.0.0.1:1/x", disabled: true },
    });
    const good = results.find((r) => r.name === "good");
    assert.equal(good.error, undefined);
    assert.equal(good.tools, 1);
    const bad = results.find((r) => r.name === "bad");
    assert.match(bad.error, /command|url/);
    assert.ok(!results.some((r) => r.name === "off"), "disabled server is skipped");
    assert.equal(mgr.allTools()[0].qualifiedName, "good__ping");
    mgr.closeAll();
  } finally {
    await new Promise((r) => ok.server.close(r));
  }
});

test("an unreachable url reports an error instead of hanging", async () => {
  const mgr = new McpManager();
  const started = Date.now();
  const results = await mgr.loadFromConfig({ dead: { url: "http://127.0.0.1:9/mcp", timeoutMs: 1500 } });
  assert.ok(Date.now() - started < 20000, "did not hang");
  assert.match(results[0].error, /MCP|fetch|refused|timeout|ECONN/i);
});
