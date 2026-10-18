import { spawn } from "node:child_process";

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
    this.send({ jsonrpc: "2.0", method, params });
  }

  close() {
    try {
      this.proc?.stdin.end();
      this.proc?.kill();
    } catch {}
    this.proc = null;
  }
}

export class McpClient {
  constructor(name, spec) {
    this.name = name;
    this.spec = spec;
    this.transport = new StdioTransport({
      command: spec.command,
      args: spec.args || [],
      env: spec.env || {},
      cwd: spec.cwd,
    });
    this.tools = [];
    this.serverInfo = null;
    this.initialized = false;
  }

  async connect() {
    this.transport.start();
    const result = await this.transport.request(
      "initialize",
      {
        protocolVersion: "2024-11-05",
        capabilities: { roots: {}, sampling: {} },
        clientInfo: { name: "myclaude", version: "0.1.0" },
      },
      30000
    );
    this.serverInfo = result?.serverInfo || null;
    this.transport.notify("notifications/initialized", {});
    this.initialized = true;
    await this.refreshTools();
    return this;
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
    for (const [name, spec] of Object.entries(mcpServers)) {
      if (spec.disabled) continue;
      if (!spec.command) {
        results.push({ name, error: "only stdio servers (command) are supported" });
        continue;
      }
      try {
        const client = new McpClient(name, spec);
        await client.connect();
        this.clients.set(name, client);
        results.push({ name, tools: client.tools.length, info: client.serverInfo });
      } catch (e) {
        results.push({ name, error: e.message });
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

  status() {
    return [...this.clients.entries()].map(([name, c]) => ({
      name,
      tools: c.tools.length,
      info: c.serverInfo,
    }));
  }

  closeAll() {
    for (const c of this.clients.values()) c.close();
    this.clients.clear();
  }
}
