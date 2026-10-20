import test from "node:test";
import assert from "node:assert/strict";

import { buildAuthHeaders, createTransport } from "../src/mcp/client.js";

test("explicit headers pass through unchanged", () => {
  const h = buildAuthHeaders({ headers: { Authorization: "Bearer abc" } });
  assert.equal(h.Authorization, "Bearer abc");
});

test("bearer shorthand becomes an Authorization header", () => {
  const h = buildAuthHeaders({ bearer: "tok123" });
  assert.equal(h.Authorization, "Bearer tok123");
});

test("apiKey uses X-API-Key by default", () => {
  const h = buildAuthHeaders({ apiKey: "secret" });
  assert.equal(h["X-API-Key"], "secret");
});

test("apiKeyHeader can rename the key header", () => {
  const h = buildAuthHeaders({ apiKey: "secret", apiKeyHeader: "X-Token" });
  assert.equal(h["X-Token"], "secret");
  assert.equal(h["X-API-Key"], undefined);
});

test("explicit headers override a shorthand", () => {
  const h = buildAuthHeaders({ bearer: "fromBearer", headers: { Authorization: "Bearer explicit" } });
  assert.equal(h.Authorization, "Bearer explicit");
});

test("${ENV} references are expanded from the environment", () => {
  const prev = process.env.MCP_TEST_TOKEN;
  process.env.MCP_TEST_TOKEN = "from-env";
  try {
    const h = buildAuthHeaders({ bearer: "${MCP_TEST_TOKEN}" });
    assert.equal(h.Authorization, "Bearer from-env");
  } finally {
    if (prev === undefined) { delete process.env.MCP_TEST_TOKEN; }
    else { process.env.MCP_TEST_TOKEN = prev; }
  }
});

test("a missing environment variable is reported by name", () => {
  const name = "MCP_TEST_MISSING_" + Date.now();
  assert.throws(
    () => buildAuthHeaders({ bearer: "${" + name + "}" }),
    (e) => e.message.includes(name)
  );
});

test("http transports receive the built headers", () => {
  const sse = createTransport("srv", { url: "http://x/sse", transport: "sse", bearer: "b1" });
  assert.equal(sse.headers.Authorization, "Bearer b1");

  const http = createTransport("srv", { url: "http://x/mcp", bearer: "b2" });
  assert.equal(http.headers.Authorization, "Bearer b2");
});

test("stdio transport is unaffected by auth config", () => {
  const t = createTransport("srv", { command: "node", args: ["x.js"], bearer: "ignored" });
  assert.ok(t, "stdio transport builds without touching auth");
});
