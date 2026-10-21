/**
 * OAuth 2.0 for remote MCP servers.
 *
 * MCP servers that need a login (Notion, Linear, Sentry and friends) no longer
 * accept a hand-copied token, so the client has to run a real authorization
 * flow. Claude Code uses the RFC 8628 device grant: the agent asks the
 * authorization server for a device code, the user approves it in a browser,
 * and the agent polls until a bearer token arrives.
 *
 * The device grant is used rather than a loopback redirect because it needs
 * no local HTTP server, so it works the same from the terminal and the GUI,
 * and behind a remote gateway where 127.0.0.1 is not reachable.
 *
 * The flow is:
 *   1. read the server metadata (RFC 8414)
 *   2. register a client dynamically (RFC 7591) when the server allows it
 *   3. request a device code and show the user a code to type
 *   4. poll the token endpoint until the user approves
 *   5. store the token and refresh it before it expires
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { CONFIG_DIR } from "../config.js";

/** Metadata documents are looked for under these names, in order. */
const METADATA_PATHS = [
  "oauth-authorization-server",
  "openid-configuration",
];

/** Default client identity used for dynamic registration. */
const CLIENT_INFO = {
  client_name: "myclaude",
  client_uri: "https://github.com/lark980-web/MyClaude",
  // The device grant never redirects, so no callback URL is registered.
  redirect_uris: [],
  grant_types: ["urn:ietf:params:oauth:grant-type:device_code", "refresh_token"],
  response_types: ["code"],
  token_endpoint_auth_method: "none",
};

/**
 * Build the URLs of a well-known metadata document for a server.
 *
 * RFC 8414 puts the document at the root of the issuer, but a server that
 * serves several tenants under a path prefix needs the prefix preserved.
 * Both spellings are tried, in the order the RFC and the OIDC spec use.
 *
 * @param {URL} issuer
 * @param {string} name One of METADATA_PATHS
 * @returns {string[]}
 */
export function metadataUrls(issuer, name) {
  const path = issuer.pathname === "/" ? "" : issuer.pathname.replace(/\/$/, "");
  const root = new URL(issuer.origin);
  const nested = new URL(`${path}/.well-known/${name}`, root);
  const flat = new URL(`/.well-known/${name}${path}`, root);
  // The path-prefixed form is what a multi-tenant server publishes; the flat
  // form is the RFC 8414 default. Both are worth a request.
  return [nested.toString(), flat.toString()];
}

/**
 * Fetch the authorization server metadata for a server.
 *
 * @param {string|URL} baseUrl
 * @param {{fetchImpl?: Function, timeoutMs?: number}} [opts]
 * @returns {Promise<Object>}
 */
export async function discoverMetadata(baseUrl, opts = {}) {
  const doFetch = opts.fetchImpl || fetch;
  const timeoutMs = opts.timeoutMs || 10000;
  const issuer = new URL(String(baseUrl));
  for (const name of METADATA_PATHS) {
    for (const url of metadataUrls(issuer, name)) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        const res = await doFetch(url, {
          headers: { Accept: "application/json" },
          signal: ctrl.signal,
        });
        if (!res.ok) { continue; }
        const body = await res.json();
        if (!body || typeof body !== "object") { continue; }
        // A metadata document without a token endpoint is useless to us.
        if (!body.token_endpoint) { continue; }
        return { ...body, issuer: body.issuer || issuer.origin, metadataUrl: url };
      } catch {
        // A missing or malformed document just means the next candidate is
        // tried; the server may only publish one of the two spellings.
      } finally {
        clearTimeout(timer);
      }
    }
  }
  const tried = METADATA_PATHS.map((n) => "/.well-known/" + n).join(", ");
  throw new Error(`No OAuth metadata found for ${issuer.origin} (tried ${tried})`);
}

/**
 * Register a client with the authorization server (RFC 7591).
 *
 * Servers that support the device grant usually also support dynamic
 * registration, so a user never has to register a client by hand. When the
 * server refuses, the caller can fall back to a client id from the config.
 *
 * @param {Object} meta Metadata from discoverMetadata
 * @param {{clientId?: string, fetchImpl?: Function}} [opts]
 * @returns {Promise<Object>}
 */
export async function registerClient(meta, opts = {}) {
  const doFetch = opts.fetchImpl || fetch;
  if (opts.clientId) { return { client_id: opts.clientId }; }
  if (!meta.registration_endpoint) {
    throw new Error(
      "The MCP server does not publish a registration_endpoint, so a client id " +
      "must be configured for it (mcpServers.<name>.clientId)."
    );
  }
  const res = await doFetch(meta.registration_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(CLIENT_INFO),
  });
  if (!res.ok) {
    throw new Error("Client registration failed (HTTP " + res.status + ")");
  }
  const body = await res.json();
  if (!body || !body.client_id) {
    throw new Error("Client registration returned no client_id");
  }
  return body;
}

/**
 * Ask the authorization server for a device code (RFC 8628).
 *
 * @param {Object} meta
 * @param {string} clientId
 * @param {{scope?: string, fetchImpl?: Function}} [opts]
 * @returns {Promise<Object>}
 */
export async function startDeviceAuthorization(meta, clientId, opts = {}) {
  const doFetch = opts.fetchImpl || fetch;
  const endpoint = meta.device_authorization_endpoint;
  if (!endpoint) {
    throw new Error(
      "The MCP server does not advertise a device_authorization_endpoint, so the " +
      "device authorization grant cannot be used."
    );
  }
  const form = new URLSearchParams({
    client_id: clientId,
    grant_type: "urn:ietf:params:oauth:grant-type:device_code",
  });
  if (opts.scope) { form.set("scope", opts.scope); }
  const res = await doFetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: form.toString(),
  });
  if (!res.ok) {
    throw new Error("Device authorization failed (HTTP " + res.status + ")");
  }
  const body = await res.json();
  if (!body || !body.device_code || !body.user_code) {
    throw new Error("Device authorization returned no device_code");
  }
  return body;
}

/**
 * Poll the token endpoint until the user approves the device code.
 *
 * The server answers "authorization_pending" until the browser flow finishes,
 * so this waits. "slow_down" asks the client to back off, which is honoured.
 *
 * @param {Object} meta
 * @param {string} clientId
 * @param {string} deviceCode
 * @param {{intervalMs?: number, expiresIn?: number, onWait?: Function, fetchImpl?: Function, sleep?: Function}} [opts]
 * @returns {Promise<Object>} the token response
 */
export async function pollForToken(meta, clientId, deviceCode, opts = {}) {
  const doFetch = opts.fetchImpl || fetch;
  const sleep = opts.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  let interval = opts.intervalMs || 5000;
  const deadline = Date.now() + (opts.expiresIn || 900) * 1000;

  while (Date.now() < deadline) {
    const form = new URLSearchParams({
      client_id: clientId,
      device_code: deviceCode,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    });
    const res = await doFetch(meta.token_endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: form.toString(),
    });
    let body = null;
    try { body = await res.json(); } catch { body = null; }

    if (res.ok && body && (body.access_token || body.id_token)) {
      return body;
    }
    const code = body && body.error ? String(body.error) : "";
    if (code === "authorization_pending") {
      if (opts.onWait) { opts.onWait(); }
      await sleep(interval);
      continue;
    }
    if (code === "slow_down") {
      // The server wants us to poll less often.
      interval += 5000;
      await sleep(interval);
      continue;
    }
    if (code === "expired_token" || code === "access_denied") {
      throw new Error(
        code === "expired_token"
          ? "The device code expired before it was approved."
          : "The authorization request was denied."
      );
    }
    const detail = body && body.error_description ? ": " + body.error_description : "";
    throw new Error("Token request failed (HTTP " + res.status + detail + ")");
  }
  throw new Error("Timed out waiting for the device authorization to be approved.");
}

/**
 * Exchange a refresh token for a new access token.
 *
 * @param {Object} meta
 * @param {string} clientId
 * @param {string} refreshToken
 * @param {{fetchImpl?: Function}} [opts]
 * @returns {Promise<Object>}
 */
export async function refreshAccessToken(meta, clientId, refreshToken, opts = {}) {
  const doFetch = opts.fetchImpl || fetch;
  const form = new URLSearchParams({
    client_id: clientId,
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });
  const res = await doFetch(meta.token_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: form.toString(),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok || !body || !body.access_token) {
    const detail = body && body.error_description ? ": " + body.error_description : "";
    throw new Error("Token refresh failed (HTTP " + res.status + detail + ")");
  }
  return body;
}

/**
 * Stored OAuth tokens for MCP servers.
 *
 * Tokens live in their own file rather than in config.json because they are
 * secrets that rotate on their own: the config is written by hand, the token
 * file is rewritten by the client.
 */
export class OAuthTokenStore {
  /**
   * @param {{file?: string}} [opts]
   */
  constructor({ file } = {}) {
    this.file = file || join(CONFIG_DIR, "mcp-oauth.json");
    /** @type {Map<string, Object>} keyed by server name */
    this.entries = new Map();
    this.load();
  }

  load() {
    try {
      if (!existsSync(this.file)) { return; }
      const data = JSON.parse(readFileSync(this.file, "utf8"));
      for (const [name, row] of Object.entries(data.servers || {})) {
        this.entries.set(name, row);
      }
    } catch {
      // A damaged token file must not stop the client from starting; the
      // user simply has to log in again.
    }
  }

  save() {
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const out = {};
      for (const [name, row] of this.entries) { out[name] = row; }
      writeFileSync(this.file, JSON.stringify({ version: 1, servers: out }, null, 2), "utf8");
    } catch {
      // Losing the token only means logging in again.
    }
  }

  /** @returns {Object|null} the stored record for a server */
  get(name) {
    return this.entries.get(name) || null;
  }

  /** Remember the token record for a server. */
  set(name, record) {
    this.entries.set(name, record);
    this.save();
  }

  /** Forget one server, or every server when no name is given. */
  clear(name) {
    if (name) { this.entries.delete(name); }
    else { this.entries.clear(); }
    this.save();
  }

  /**
   * The bearer token to send, refreshing it first when it is about to expire.
   *
   * A token that expires mid-request would surface as an opaque 401, so the
   * refresh happens up front, with a margin that covers a slow request.
   *
   * @param {string} name
   * @param {Object} meta
   * @param {{fetchImpl?: Function, now?: number}} [opts]
   * @returns {Promise<string|null>}
   */
  async accessToken(name, meta, opts = {}) {
    const row = this.entries.get(name);
    if (!row || !row.access_token) { return null; }
    const now = opts.now || Date.now();
    const expiresAt = row.expires_at || 0;
    const needsRefresh = row.refresh_token && expiresAt && expiresAt - now < 60000;
    if (!needsRefresh) { return row.access_token; }
    try {
      const fresh = await refreshAccessToken(meta, row.client_id, row.refresh_token, opts);
      const merged = {
        ...row,
        access_token: fresh.access_token,
        refresh_token: fresh.refresh_token || row.refresh_token,
        expires_at: fresh.expires_in ? now + fresh.expires_in * 1000 : 0,
      };
      this.set(name, merged);
      return merged.access_token;
    } catch {
      // A failed refresh still leaves the old token usable for a while, so
      // the request can go out and fail with a clearer 401 if it is dead.
      return row.access_token;
    }
  }
}
