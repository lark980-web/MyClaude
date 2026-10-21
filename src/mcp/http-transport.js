/* ------------------------------------------- HTTP + SSE (legacy 2024) --- */

/**
 * The 2024 split transport: replies arrive over a long-lived GET stream and
 * requests are posted to a separate endpoint. Kept because a large number of
 * hosted servers still ship only this shape.
 */
export class SseHttpTransport {
  constructor({ url, headers = {}, timeoutMs = 60000, authProvider = null }) {
    this.url = String(url).replace(/\/+$/, "");
    this.headers = { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...headers };
    this.timeoutMs = timeoutMs;
    this.pending = new Map();
    this.onNotification = null;
    this.onClose = null;
    this.endpoint = null;      // discovered from the first "endpoint" event
    this.streamAbort = null;
    this.started = false;
  }

  /** Open the GET stream; the server announces its POST endpoint on it. */
  /**
   * Open the GET stream and wait for the server to announce its POST endpoint.
   *
   * The read loop runs in the background: awaiting it here would never return,
   * because the stream is meant to stay open for the life of the session.
   */
  /** Headers for one request, including a freshly minted bearer token. */
  async authHeaders() {
    if (!this.authProvider) { return this.headers; }
    try {
      const extra = await this.authProvider();
      return extra ? { ...this.headers, ...extra } : this.headers;
    } catch {
      // A failed token refresh must not block the request; the server will
      // answer 401 and the caller can then run the login flow.
      return this.headers;
    }
  }

  async start() {
    if (this.started) { return; }
    this.started = true;
    this.streamAbort = new AbortController();

    const res = await fetch(this.url, {
      headers: { Accept: "text/event-stream" },
      signal: this.streamAbort.signal,
    });
    if (!res.ok) {
      this.started = false;
      throw new Error("MCP SSE stream failed: " + res.status);
    }

    this.pumpPromise = this.#pump(res).catch(() => {});
    await this.#waitForEndpoint();
  }

  #waitForEndpoint() {
    return new Promise((resolve, reject) => {
      const deadline = Date.now() + 8000;
      const tick = () => {
        if (this.endpoint) { return resolve(); }
        if (!this.started) { return reject(new Error("MCP SSE stream closed before announcing endpoint")); }
        if (Date.now() > deadline) { return reject(new Error("MCP SSE server never announced its POST endpoint")); }
        setTimeout(tick, 40);
      };
      tick();
    });
  }

  async #pump(res) {
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    let eventName = "";
    const dataLines = [];

    const flush = () => {
      if (!dataLines.length) { return; }
      const payload = dataLines.join("\n");
      dataLines.length = 0;
      if (!payload.startsWith("{")) {
        // The endpoint event carries a bare path, not JSON-RPC.
        if (payload) { this.endpoint = new URL(payload, this.url).toString(); }
        return;
      }
      let msg;
      try { msg = JSON.parse(payload); } catch { return; }
      if (msg.id != null && this.pending.has(msg.id)) {
        const entry = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        clearTimeout(entry.timer);
        if (msg.error) { entry.reject(new Error(msg.error.code + ": " + msg.error.message)); }
        else { entry.resolve(msg.result); }
      } else if (msg.method) {
        this.onNotification?.(msg);
      }
    };

    while (true) {
      const { done, value } = await reader.read();
      if (done) { break; }
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (line.startsWith("event:")) { eventName = line.slice(6).trim(); continue; }
        if (line.startsWith("data:")) { dataLines.push(line.slice(5).trim()); continue; }
        if (line === "") { flush(); eventName = ""; }
      }
    }

    this.started = false;
    this.onClose?.({ end: true });
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error("MCP SSE stream closed"));
    }
    this.pending.clear();
  }
  async send(msg) {
    if (!this.endpoint) { return; }
    return fetch(this.endpoint, {
      method: "POST",
      headers: await this.authHeaders(),
      body: JSON.stringify(msg),
      signal: AbortSignal.timeout(this.timeoutMs),
    }).then(() => {}).catch(() => {});
  }

  /** Awaitable notification POST; see the Streamable transport for the why. */
  notify(method, params) {
    return this.send({ jsonrpc: "2.0", method, params });
  }

  async request(method, params) {
    if (!this.endpoint) { await this.start(); }
    const id = nextId();
    const body = JSON.stringify({ jsonrpc: "2.0", id, method, params });

    // The bearer token is fetched before the promise starts: the callback below
    // is not async, so it cannot await.
    const requestHeaders = await this.authHeaders();

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP request timed out: ${method}`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });

      fetch(this.endpoint, {
        method: "POST",
        headers: requestHeaders,
        body,
        signal: AbortSignal.timeout(this.timeoutMs),
      }).catch((e) => {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e);
      });
    });
  }

  close() {
    this.streamAbort?.abort();
    this.onClose?.({});
  }
}

function nextId() {
  return Math.floor(Math.random() * 1e9) + 1;
}
/**
 * HTTP transports for MCP servers.
 *
 * Two wire formats are in the wild and servers implement one or the other:
 *
 *   Streamable HTTP  POST {url}   -> JSON-RPC body, JSON or SSE response
 *   HTTP + SSE       GET {url}    -> SSE stream carrying replies,
 *                     POST {url}/message -> JSON-RPC body
 *
 * Both are driven through the same request()/onNotification surface as the
 * stdio transport, so the client above is transport-agnostic.
 */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Classify an error that should not be retried. */
function fatal(e) {
  return e && (e.name === "AbortError" || /401|403|404/.test(String(e.message)));
}

/* --------------------------------------------- Streamable HTTP (modern) --- */

export class StreamableHttpTransport {
  constructor({ url, headers = {}, timeoutMs = 60000, authProvider = null }) {
    this.url = String(url).replace(/\/+$/, "");
    this.headers = { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...headers };
    // OAuth tokens are minted at runtime and can expire, so request headers
    // are rebuilt per call instead of being captured once.
    this.authProvider = authProvider;
    this.timeoutMs = timeoutMs;
    this.sessionId = null;
    this.onNotification = null;
    this.onClose = null;
    this.closed = false;
  }

  /** Headers for one request, including a freshly minted bearer token. */
  async authHeaders() {
    if (!this.authProvider) { return this.headers; }
    try {
      const extra = await this.authProvider();
      return extra ? { ...this.headers, ...extra } : this.headers;
    } catch {
      // A failed token refresh must not block the request; the server answers
      // 401 and the caller can then run the login flow.
      return this.headers;
    }
  }

  async start() {
    // Streamable HTTP is connectionless: every request carries its own state.
    return;
  }

  /** POST a message; the returned promise settles when the server accepts it. */
  send(msg) {
    return this.post(JSON.stringify(msg)).then(() => {}).catch(() => {});
  }

  /**
   * POST a JSON-RPC notification (no id, no reply expected).
   *
   * Awaitable on purpose: the MCP handshake requires
   * notifications/initialized to reach the server before the first request,
   * so firing it and moving on races against tools/list.
   */
  notify(method, params) {
    return this.send({ jsonrpc: "2.0", method, params });
  }

  /**
   * POST one JSON-RPC message and read the reply.
   *
   * A 202 means "accepted, reply will arrive later"; the spec allows that for
   * notifications, so an empty result is returned instead of hanging.
   */
  async request(method, params) {
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method, params });
    const res = await this.post(body);
    const ctype = (res.headers.get("content-type") || "").toLowerCase();

    if (res.status === 202) { return {}; }
    if (!res.ok) { throw new Error(`MCP HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`); }

    if (ctype.includes("text/event-stream")) { return await this.readSse(res); }
    const json = await res.json();
    return json.result !== undefined ? json.result : {};
  }

  async post(body) {
    const headers = { ...this.headers };
    if (this.sessionId) { headers["mcp-session-id"] = this.sessionId; }
    const res = await fetch(this.url, {
      method: "POST",
      headers,
      body,
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const sid = res.headers.get("mcp-session-id");
    if (sid) { this.sessionId = sid; }
    return res;
  }

  /** Read a single JSON-RPC reply out of an SSE body. */
  async readSse(res) {
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    const dataLines = [];

    while (true) {
      const { done, value } = await reader.read();
      if (done) { break; }
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (line.startsWith("data:")) { dataLines.push(line.slice(5).trim()); }
        if (line === "") {
          if (dataLines.length) {
            const payload = dataLines.join("\n");
            dataLines.length = 0;
            let msg;
            try { msg = JSON.parse(payload); } catch { continue; }
            if (msg.method && msg.id == null) { this.onNotification?.(msg); continue; }
            if (msg.id != null) { return msg.result !== undefined ? msg.result : {}; }
          }
        }
      }
    }
    return {};
  }

  close() {
    this.closed = true;
    this.onClose?.({});
  }
}

