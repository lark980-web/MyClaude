import { spawn } from "node:child_process";
import { StreamableHttpTransport, SseHttpTransport } from "./http-transport.js";

let nextId = 1;

class StdioTransport {
  constructor({ command, args = [], env = {}, cwd }) {
    this.command = command;
    this.args = args;
    this.env = env;
    this.cwd = cwd;
    this.proc = null;
    this.buffer = "";
    this.pending = new Map();
    this.onNotification = null;
    this.onClose = null;
  }

  start() {
    if (this.proc) return;
    this.proc = spawn(this.command, this.args, {
      cwd: this.cwd,
      env: { ...process.env, ...this.env },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      shell: process.platform === "win32",
    });

    this.proc.stdout.setEncoding("utf8");
    this.proc.stdout.on("data", (chunk) => this.#onData(chunk));

    this.proc.stderr.setEncoding("utf8");
    this.proc.stderr.on("data", (chunk) => {
      this.onStderr?.(chunk);
    });

    this.proc.on("exit", (code) => {
      for (const [, p] of this.pending) p.reject(new Error(`MCP process exited (${code})`));
      this.pending.clear();
      this.onClose?.({ code });
    });

    this.proc.on("error", (e) => {
      for (const [, p] of this.pending) p.reject(e);
      this.pending.clear();
      this.onClose?.({ error: e });
    });
  }

  #onData(chunk) {
    this.buffer += chunk;
    while (true) {
      const nl = this.buffer.indexOf("\n");
      if (nl < 0) break;
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg.id != null && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(`${msg.error.code}: ${msg.error.message}`));
        else resolve(msg.result);
      } else if (msg.method) {
        this.onNotification?.(msg);
      }
    }
  }

  send(msg) {
    this.start();
    this.proc.stdin.write(JSON.stringify(msg) + "\n");
  }

  request(method, params, timeoutMs = 60000) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP request timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method, params) {
    // Resolves immediately: stdio writes are ordered, so the notification is
    // already queued ahead of any later request.
    this.send({ jsonrpc: "2.0", method, params });
    return Promise.resolve();
  }

  close() {
    try {
      this.proc?.stdin.end();
      this.proc?.kill();
    } catch {}
    this.proc = null;
  }
}


/**
 * Pick a transport from a server spec.
 *
 *   { command, args, env, cwd }  -> stdio child process
 *   { url }                      -> Streamable HTTP, falling back to SSE
 */
export function createTransport(name, spec) {
  if (spec.command) {
    return new StdioTransport({
      command: spec.command,
      args: spec.args || [],
      env: spec.env || {},
      cwd: spec.cwd,
      timeoutMs: spec.timeoutMs,
    });
  }
  if (spec.url) {
    // transport: "sse" forces the legacy split protocol; "http" forces the
    // modern one; omit to let the client negotiate (see McpClient.connect).
    if (spec.transport === "sse") {
      return new SseHttpTransport({ url: spec.url, headers: spec.headers, timeoutMs: spec.timeoutMs });
    }
    return new StreamableHttpTransport({ url: spec.url, headers: spec.headers, timeoutMs: spec.timeoutMs });
  }
  throw new Error("MCP server needs either command (stdio) or url (http)");
}

export class McpClient {
  constructor(name, spec) {
    this.name = name;
    this.spec = spec;
    this.transport = createTransport(name, spec);
    this.tools = [];
    this.serverInfo = null;
    this.initialized = false;
  }

  /**
   * Open the transport.
   *
   * An HTTP server that only implements the legacy split protocol answers the
   * Streamable POST with 4xx, so on that error we swap in the SSE transport and
   * retry once. stdio has nothing to negotiate.
   */
  async startTransport() {
    try {
      await this.transport.start();
      return;
    } catch (e) {
      if (!this.spec.url) throw e;
    }
    if (this.transport instanceof SseHttpTransport) { return; }
    this.transport = new SseHttpTransport({
      url: this.spec.url,
      headers: this.spec.headers,
      timeoutMs: this.spec.timeoutMs,
    });
    await this.transport.start();
  }

  async connect() {
    await this.startTransport();
    const initParams = {
      protocolVersion: "2024-11-05",
      capabilities: { roots: {}, sampling: {} },
      clientInfo: { name: "myclaude", version: "0.1.0" },
    };

    let result;
    try {
      result = await this.transport.request("initialize", initParams, 30000);
    } catch (e) {
      // A Streamable-only request against a legacy server fails here rather
      // than at connect, so this is the second place where the SSE fallback
      // has to fire.
      if (await this.#fallbackToSse(e)) {
        result = await this.transport.request("initialize", initParams, 30000);
      } else {
        throw e;
      }
    }

    this.serverInfo = result?.serverInfo || null;
    await this.transport.notify("notifications/initialized", {});
    this.initialized = true;
    await this.refreshTools();
    return this;
  }

  /** Swap a failed Streamable HTTP attempt for the legacy SSE transport. */
  async #fallbackToSse(error) {
    if (!this.spec.url) { return false; }
    if (this.transport instanceof SseHttpTransport) { return false; }
    const status = error && (error.status || /\b4\d\d\b/.test(String(error.message)) ? 400 : 0);
    if (!status && !/404|405|400|not found|method/i.test(String(error && error.message))) { return false; }
    this.transport = new SseHttpTransport({
      url: this.spec.url,
      headers: this.spec.headers,
      timeoutMs: this.spec.timeoutMs,
    });
    await this.transport.start();
    return true;
  }

  async refreshTools() {
    const result = await this.transport.request("tools/list", {}, 30000);
    this.tools = (result?.tools || []).map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema || { type: "object", properties: {} },
      server: this.name,
    }));
    return this.tools;
  }

  async callTool(name, args) {
    const result = await this.transport.request(
      "tools/call",
      { name, arguments: args || {} },
      120000
    );
    const parts = [];
    for (const item of result?.content || []) {
      if (item.type === "text") parts.push(item.text);
      else if (item.type === "resource") parts.push(`[resource ${item.resource?.uri}]`);
      else if (item.type === "image") parts.push(`[image ${item.mimeType}]`);
      else parts.push(JSON.stringify(item));
    }
    return { ok: !result?.isError, content: parts.join("\n") || "(empty)" };
  }

  close() {
    this.transport.close();
  }
}

export class McpManager {
  constructor() {
    this.clients = new Map();
  }

  async loadFromConfig(mcpServers = {}) {
    const results = [];
    this.failed = this.failed || new Map();
    for (const [name, spec] of Object.entries(mcpServers)) {
      if (spec.disabled) continue;
      if (!spec.command && !spec.url) {
        results.push({ name, error: "needs either command (stdio) or url (http/sse)" });
        continue;
      }
      try {
        const client = new McpClient(name, spec);
        await client.connect();
        this.clients.set(name, client);
        this.failed.delete(name);
        results.push({ name, tools: client.tools.length, info: client.serverInfo });
      } catch (e) {
        results.push({ name, error: e.message });
        this.failed.set(name, e.message);
      }
    }
    return results;
  }

  allTools() {
    const out = [];
    for (const [name, client] of this.clients) {
      for (const t of client.tools) {
        out.push({
          ...t,
          qualifiedName: `${name}__${t.name}`,
        });
      }
    }
    return out;
  }

  async call(qualifiedName, args) {
    const idx = qualifiedName.indexOf("__");
    if (idx < 0) throw new Error(`invalid MCP tool name: ${qualifiedName}`);
    const server = qualifiedName.slice(0, idx);
    const tool = qualifiedName.slice(idx + 2);
    const client = this.clients.get(server);
    if (!client) throw new Error(`unknown MCP server: ${server}`);
    return client.callTool(tool, args);
  }

  /** Connected servers plus the ones that failed, so the UI can show why. */
  status() {
    const out = [...this.clients.entries()].map(([name, c]) => ({
      name,
      tools: c.tools.length,
      info: c.serverInfo,
      transport: c.spec.url ? (c.spec.transport || "http") : "stdio",
      url: c.spec.url || null,
    }));
    for (const [name, error] of this.failed || []) {
      out.push({ name, tools: 0, error });
    }
    return out;
  }

  closeAll() {
    for (const c of this.clients.values()) c.close();
    this.clients.clear();
  }
}
