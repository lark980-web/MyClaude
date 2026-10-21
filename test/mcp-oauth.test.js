import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  metadataUrls,
  discoverMetadata,
  registerClient,
  startDeviceAuthorization,
  pollForToken,
  refreshAccessToken,
  OAuthTokenStore,
} from "../src/mcp/oauth.js";

/** A fetch stand-in that answers from a routing table. */
  
function mockFetch(routes) {
  const calls = [];
  const impl = async (url, opts = {}) => {
    calls.push({ url: String(url), method: opts.method || "GET", body: opts.body });
    const key = String(url);
    const hit = routes[key];
    if (!hit) { return { ok: false, status: 404, json: async () => ({ error: "not_found" }) }; }
    if (typeof hit === "function") { return hit(opts); }
    return { ok: hit.status === undefined ? true : hit.status < 400, status: hit.status || 200, json: async () => hit.body };
  };
  impl.calls = calls;
  return impl;
}

test("metadataUrls covers both the path-prefixed and the flat spelling", () => {
  const urls = metadataUrls(new URL("https://api.example.com/mcp"), "oauth-authorization-server");
  assert.equal(urls.length, 2);
  assert.ok(urls[0].includes("/mcp/.well-known/oauth-authorization-server"), urls[0]);
  assert.ok(urls[1].includes("/.well-known/oauth-authorization-server/mcp"), urls[1]);
});

test("a root issuer produces the standard well-known path", () => {
  const urls = metadataUrls(new URL("https://api.example.com/"), "oauth-authorization-server");
  assert.ok(urls[0].endsWith("/.well-known/oauth-authorization-server"), urls[0]);
});

test("discoverMetadata reads the authorization server document", async () => {
  const impl = mockFetch({
    "https://api.example.com/.well-known/oauth-authorization-server": {
      body: { issuer: "https://api.example.com", token_endpoint: "https://api.example.com/token", device_authorization_endpoint: "https://api.example.com/device" },
    },
  });
  const meta = await discoverMetadata("https://api.example.com", { fetchImpl: impl });
  assert.equal(meta.token_endpoint, "https://api.example.com/token");
  assert.equal(meta.device_authorization_endpoint, "https://api.example.com/device");
});

test("discoverMetadata explains itself when nothing is published", async () => {
  const impl = mockFetch({});
  await assert.rejects(
    () => discoverMetadata("https://api.example.com", { fetchImpl: impl }),
    /No OAuth metadata found/);
  
});

test("a metadata document without a token endpoint is rejected", async () => {
  const impl = mockFetch({
    "https://api.example.com/.well-known/oauth-authorization-server": { body: { issuer: "x" } },
  });
  await assert.rejects(
    () => discoverMetadata("https://api.example.com", { fetchImpl: impl }),
    /No OAuth metadata found/
  );
});

test("registerClient posts the client info and returns the id", async () => {
  const impl = mockFetch({
    "https://api.example.com/register": { body: { client_id: "abc123" } },
  });
  const reg = await registerClient({ registration_endpoint: "https://api.example.com/register" }, { fetchImpl: impl });
  assert.equal(reg.client_id, "abc123");
  const sent = JSON.parse(impl.calls[0].body);
  assert.equal(sent.client_name, "myclaude");
  assert.ok(sent.grant_types.includes("urn:ietf:params:oauth:grant-type:device_code"));
});

test("registerClient falls back to a configured client id", async () => {
  const reg = await registerClient({}, { clientId: "preset" });
  assert.equal(reg.client_id, "preset");
});

test("registerClient explains a server without registration_endpoint", async () => {
  await assert.rejects(() => registerClient({}), /registration_endpoint/);
});

test("startDeviceAuthorization returns the user code and the url", async () => {
  const impl = mockFetch({
    "https://api.example.com/device": {
      body: { device_code: "dev", user_code: "WXYZ-1234", verification_uri: "https://example.com/activate", expires_in: 900, interval: 5 },
    },
  });
  const d = await startDeviceAuthorization({ device_authorization_endpoint: "https://api.example.com/device" }, "cid", { fetchImpl: impl });
  assert.equal(d.user_code, "WXYZ-1234");
  assert.equal(d.verification_uri, "https://example.com/activate");
  assert.equal(d.device_code, "dev");
});

test("pollForToken waits while the user has not approved yet", async () => {
  let n = 0;
  const impl = async () => {
    n++;
    if (n < 3) { return { ok: false, status: 400, json: async () => ({ error: "authorization_pending" }) }; }
    return { ok: true, status: 200, json: async () => ({ access_token: "tok-1", refresh_token: "ref-1", expires_in: 3600 }) };
  };
  const waits = [];
  const tok = await pollForToken({ token_endpoint: "https://api.example.com/token" }, "cid", "dev", {
    fetchImpl: impl, sleep: async () => {}, onWait: () => waits.push(1), expiresIn: 60,
  });
  assert.equal(tok.access_token, "tok-1");
  assert.equal(waits.length, 2, "waited twice before the token arrived");
});

test("pollForToken backs off when the server says slow_down", async () => {
  let n = 0;
  const impl = async () => {
    n++;
    if (n === 1) { return { ok: false, status: 400, json: async () => ({ error: "slow_down" }) }; }
    return { ok: true, status: 200, json: async () => ({ access_token: "tok" }) };
  };
  const delays = [];
  await pollForToken({ token_endpoint: "https://api.example.com/token" }, "cid", "dev", {
    fetchImpl: impl, sleep: async (ms) => { delays.push(ms); }, expiresIn: 60,
  });
  assert.ok(delays.length >= 1, "waited after slow_down");
  assert.ok(delays[0] > 5000, `the wait grew past the default 5s: ${delays[0]}`);
});

test("pollForToken reports a denied or expired request", async () => {
  const impl = async () => ({ ok: false, status: 400, json: async () => ({ error: "access_denied" }) });
  await assert.rejects(
    () => pollForToken({ token_endpoint: "https://api.example.com/token" }, "cid", "dev", { fetchImpl: impl, sleep: async () => {}, expiresIn: 60 }),
    /denied/
  );
});

test("refreshAccessToken exchanges a refresh token", async () => {
  const impl = mockFetch({
    "https://api.example.com/token": { body: { access_token: "tok-2", refresh_token: "ref-2", expires_in: 3600 } },
  });
  const tok = await refreshAccessToken({ token_endpoint: "https://api.example.com/token" }, "cid", "ref-1", { fetchImpl: impl });
  assert.equal(tok.access_token, "tok-2");
});

test("the token store keeps tokens between instances", () => {
  const dir = mkdtempSync(join(process.env.TEMP || ".", "oauth-"));
  try {
    const file = join(dir, "mcp-oauth.json");
    const store = new OAuthTokenStore({ file });
    store.set("notion", { access_token: "tok", refresh_token: "ref", expires_at: 123, client_id: "cid" });
    assert.ok(existsSync(file), "the token file was written");

    const again = new OAuthTokenStore({ file });
    assert.equal(again.get("notion").access_token, "tok");
    again.clear("notion");
    assert.equal(new OAuthTokenStore({ file }).get("notion"), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a nearly expired token is refreshed before it is used", async () => {
  const dir = mkdtempSync(join(process.env.TEMP || ".", "oauth-refresh-"));
  try {
    const store = new OAuthTokenStore({ file: join(dir, "tokens.json") });
    const now = 1_000_000;
    store.set("s", { access_token: "old", refresh_token: "ref", expires_at: now + 1000, client_id: "cid" });
    const impl = mockFetch({
      "https://api.example.com/token": { body: { access_token: "fresh", expires_in: 3600 } },
    });
    const token = await store.accessToken("s", { token_endpoint: "https://api.example.com/token" }, { fetchImpl: impl, now });
    assert.equal(token, "fresh");
    assert.equal(store.get("s").access_token, "fresh");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a token that is still good is used as-is", async () => {
  const dir = mkdtempSync(join(process.env.TEMP || ".", "oauth-fresh-"));
  try {
    const store = new OAuthTokenStore({ file: join(dir, "tokens.json") });
    const now = 1_000_000;
    store.set("s", { access_token: "good", refresh_token: "ref", expires_at: now + 3_600_000, client_id: "cid" });
    const token = await store.accessToken("s", { token_endpoint: "https://api.example.com/token" }, { now });
    assert.equal(token, "good");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
