/**
 * MCP prompts and resources: discovery, bridging into the tool list, and
 * dispatch through the qualified-name router.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { McpClient, McpManager } from "../src/mcp/client.js";

/** Streamable-HTTP mock advertising tools, prompts and resources. */
function mockServer() {
  const state = { requests: [] };
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const msg = JSON.parse(body || "{}");
      state.requests.push(msg.method);
      const id = msg.id;
      let result = {};
      if (msg.method === "initialize") {
        result = {
          protocolVersion: "2024-11-05",
          serverInfo: { name: "full-mock", version: "1" },
          capabilities: { tools: {}, prompts: {}, resources: {} },
        };
      } else if (msg.method === "tools/list") {
        result = { tools: [{ name: "echo", description: "Echo", inputSchema: { type: "object", properties: {} } }] };
      } else if (msg.method === "prompts/list") {
        result = { prompts: [{ name: "review", description: "Review a diff", arguments: [{ name: "target", description: "what to review", required: true }] }] };
      } else if (msg.method === "prompts/get") {
        result = { description: "Review a diff", messages: [
          { role: "user", content: { type: "text", text: "请审查 " + (msg.params.arguments.target || "?") } },
        ] };
      } else if (msg.method === "resources/list") {
        result = { resources: [{ uri: "file:///notes.md", name: "notes", mimeType: "text/markdown" }] };
      } else if (msg.method === "resources/read") {
        result = { contents: [{ uri: msg.params.uri, mimeType: "text/markdown", text: "# 笔记\n内容在这里" }] };
      } else if (msg.method === "tools/call") {
        result = { content: [{ type: "text", text: "echoed" }] };
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id, result }));
    });
  });
  return { server, state };
}

async function url(server) {
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return "http://127.0.0.1:" + server.address().port + "/mcp";
}

test("client discovers prompts and resources when advertised", async () => {
  const m = mockServer();
  const u = await url(m.server);
  try {
    const client = new McpClient("full", { url: u });
    await client.connect();
    assert.equal(client.tools.length, 1);
    assert.equal(client.prompts.length, 1);
    assert.equal(client.prompts[0].name, "review");
    assert.equal(client.prompts[0].arguments[0].name, "target");
    assert.equal(client.resources.length, 1);
    assert.equal(client.resources[0].uri, "file:///notes.md");
    assert.ok(m.state.requests.includes("prompts/list"));
    assert.ok(m.state.requests.includes("resources/list"));
    client.close();
  } finally { await new Promise((r) => m.server.close(r)); }
});

test("manager status reports prompt/resource counts and lists", async () => {
  const m = mockServer();
  const u = await url(m.server);
  try {
    const mgr = new McpManager();
    await mgr.loadFromConfig({ full: { url: u } });
    const st = mgr.status()[0];
    assert.equal(st.tools, 1);
    assert.equal(st.prompts, 1);
    assert.equal(st.resources, 1);
    assert.equal(st.promptList[0].name, "review");
    assert.equal(st.resourceList[0].name, "notes");
    mgr.closeAll();
  } finally { await new Promise((r) => m.server.close(r)); }
});

test("manager dispatches prompt__ and resource__ qualified names", async () => {
  const m = mockServer();
  const u = await url(m.server);
  try {
    const mgr = new McpManager();
    await mgr.loadFromConfig({ full: { url: u } });

    const pr = await mgr.call("full__prompt__review", { target: "src/ui" });
    assert.equal(pr.ok, true);
    assert.match(pr.content, /请审查 src\/ui/);
    assert.equal(pr.messages[0].role, "user");

    const rs = await mgr.call("full__resource__notes", {});
    assert.equal(rs.ok, true);
    assert.match(rs.content, /# 笔记/);

    const missing = await mgr.call("full__resource__ghost", {});
    assert.equal(missing.ok, false);

    const tl = await mgr.call("full__echo", {});
    assert.equal(tl.content, "echoed");
    mgr.closeAll();
  } finally { await new Promise((r) => m.server.close(r)); }
});

test("findPrompt and findResource resolve bare and qualified names", async () => {
  const m = mockServer();
  const u = await url(m.server);
  try {
    const mgr = new McpManager();
    await mgr.loadFromConfig({ full: { url: u } });
    assert.ok(mgr.findPrompt("review"));
    assert.ok(mgr.findPrompt("full__review"));
    assert.equal(mgr.findPrompt("nope"), null);
    assert.ok(mgr.findResource("file:///notes.md"));
    assert.ok(mgr.findResource("full__notes"));
    mgr.closeAll();
  } finally { await new Promise((r) => m.server.close(r)); }
});

test("servers without prompt/resource capabilities are not queried", async () => {
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const msg = JSON.parse(body || "{}");
      const result = msg.method === "initialize"
        ? { protocolVersion: "2024-11-05", serverInfo: { name: "tools-only" }, capabilities: { tools: {} } }
        : msg.method === "tools/list" ? { tools: [] } : {};
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }));
    });
  });
  const u = await url(server);
  try {
    const client = new McpClient("t", { url: u });
    await client.connect();
    assert.equal(client.prompts.length, 0);
    assert.equal(client.resources.length, 0);
    client.close();
  } finally { await new Promise((r) => server.close(r)); }
});
