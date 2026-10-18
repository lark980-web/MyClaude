import { createServer } from "node:http";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import { basename, dirname, extname, join, resolve, isAbsolute, relative } from "node:path";
import { createProvider } from "../providers/openai.js";
import { createAgent } from "../agent/runtime.js";
import { allRegisteredTools, registerTools, multiEditTool, todoWriteTool, webFetchTool } from "../tools/index.js";
import { EXTENDED_TOOLS } from "../tools/extended.js";
import { getTodos } from "../tools/extra.js";
import { taskSummaries } from "../tools/tasks.js";
import { loadConfig, saveConfig } from "../config.js";
import { resolveAttachments, describeAttachment } from "../attachments.js";
import {
  createAutoSaver,
  listSessions,
  latestSession,
  loadSession,
  saveSession,
  deleteSession,
  pruneSessions
} from "../session.js";
import { loadGuiAssets } from "./assets.js";

const VERSION = "0.10.0";
const MAX_FILE_BYTES = 1024 * 1024;

/** Paths the file browser must never expose. */
const BINARY_EXT = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".ico", ".pdf", ".zip", ".gz", ".tar", ".7z", ".rar",
  ".exe", ".dll", ".so", ".dylib", ".node", ".bin", ".wasm", ".class", ".jar", ".pyc", ".o", ".a", ".lib",
  ".mp4", ".mp3", ".wav", ".avi", ".mkv", ".mov", ".woff", ".woff2", ".ttf", ".otf", ".eot"
]);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".png": "image/png"
};

function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(text)
  });
  res.end(text);
}

function sendText(res, status, text, type) {
  res.writeHead(status, { "Content-Type": type || "text/plain; charset=utf-8", "Cache-Control": "no-store" });
  res.end(text);
}

function readJson(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => {
      data += c;
      if (data.length > 32 * 1024 * 1024) req.destroy();
    });
    req.on("end", () => {
      try { resolve(JSON.parse(data || "{}")); } catch { resolve({}); }
    });
    req.on("error", () => resolve({}));
  });
}

export async function startGui({ config: initialConfig, port = 7788, open = true, cwd = process.cwd() } = {}) {
  const config = { ...initialConfig };
  const provider = createProvider(config);
  const assets = loadGuiAssets();

  /** One live conversation per browser tab; "default" is the legacy key. */
  const sessions = new Map();
  const savers = new Map();
  const confirmResolvers = new Map();
  const questionResolvers = new Map();

  const sse = (res, event) => {
    if (res.writableEnded) return;
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };

  const keyOf = (body) => (body && typeof body.sessionKey === "string" && body.sessionKey) || "default";

  const saverFor = (key, agent) => {
    let saver = savers.get(key);
    if (!saver) {
      saver = createAutoSaver({
        getMessages: () => agent.messages,
        getMeta: () => ({
          cwd,
          model: config.model,
          provider: config.provider,
          permissionMode: agent.mode ?? config.permissionMode,
          turnCount: agent.turnCount,
          version: VERSION,
          ui: "gui"
        })
      });
      savers.set(key, saver);
    }
    return saver;
  };

  const agentFor = async (key, ui) => {
    let agent = sessions.get(key);
    if (!agent) {
      agent = await createAgent({ provider, config, ui, providerFactory: () => createProvider(config) });
      sessions.set(key, agent);
    } else if (ui) {
      if (typeof agent.setUi === "function") agent.setUi(ui);
      else agent.ui = ui;
    }
    return agent;
  };

  /** UI adapter: every method maps onto one SSE event. */
  const makeUi = (res) => ({
    streamText: (t) => sse(res, { type: "delta", text: t }),
    endStream: () => sse(res, { type: "assistant_end" }),
    info: (t) => sse(res, { type: "info", text: String(t) }),
    warn: (t) => sse(res, { type: "warn", text: String(t) }),
    error: (t) => sse(res, { type: "error", text: String(t) }),
    success: (t) => sse(res, { type: "success", text: String(t) }),
    toolStart: (name, args) => sse(res, { type: "tool_start", call: { name, args } }),
    toolEnd: (name, ok, elapsed, output, extra) =>
      sse(res, {
        type: "tool_end",
        name,
        ok,
        elapsed,
        output,
        // Structured payloads (git diffs, task ids) let the client render
        // something better than a wall of text.
        data: pickData(extra)
      }),
    confirmTool: (name, args) =>
      new Promise((resolve) => {
        const id = Math.random().toString(36).slice(2);
        confirmResolvers.set(id, resolve);
        sse(res, { type: "confirm", id, name, args });
        setTimeout(() => {
          if (confirmResolvers.has(id)) {
            confirmResolvers.delete(id);
            resolve(false);
          }
        }, 120000).unref?.();
      }),
    askQuestions: (questions) =>
      new Promise((resolve) => {
        const id = Math.random().toString(36).slice(2);
        questionResolvers.set(id, resolve);
        sse(res, { type: "question", id, questions });
        setTimeout(() => {
          if (questionResolvers.has(id)) {
            questionResolvers.delete(id);
            resolve(null);
          }
        }, 300000).unref?.();
      })
  });

  /** Per-turn UI whose todo events mirror the TodoWrite list. */
  const makeTurnUi = (res, key) => {
    const base = makeUi(res);
    return {
      ...base,
      toolEnd: (name, ok, elapsed, output, extra) => {
        base.toolEnd(name, ok, elapsed, output, extra);
        if (name === "TodoWrite") sse(res, { type: "todos", todos: getTodos(key) });
      }
    };
  };

  /** Rough character-based token estimate (matches Agent.maybeCompact). */
  const approxTokens = (agent) => {
    if (!agent) return 0;
    const chars = agent.messages.reduce((sum, m) => {
      const c = typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? "");
      return sum + c.length + 20;
    }, 0);
    return Math.ceil(chars / 4);
  };

  /** Keep only the JSON-safe structured bits of a tool result. */
  const pickData = (result) => {
    if (!result || typeof result !== "object") { return null; }
    const out = {};
    if (result.git) { out.git = result.git; }
    if (Array.isArray(result.diff)) { out.diff = result.diff; }
    if (result.taskId) { out.taskId = result.taskId; }
    return Object.keys(out).length ? out : null;
  };

  const statsOf = (agent) => {
    // Prefer the endpoint's own accounting; fall back to the character
    // estimate when a provider does not report usage.
    const reported = agent ? (agent.totalInputTokens || 0) + (agent.totalOutputTokens || 0) : 0;
    const used = reported || approxTokens(agent);
    const limit = Math.round((config.contextWindow || 1000000) * (config.compactThreshold || 0.8));
    return {
      messages: agent ? agent.messages.length : 0,
      turns: agent ? agent.turnCount : 0,
      tokens: used,
      inputTokens: agent ? agent.totalInputTokens || 0 : 0,
      outputTokens: agent ? agent.totalOutputTokens || 0 : 0,
      contextLimit: limit,
      contextUsed: limit ? Math.min(1, used / limit) : 0
    };
  };

  const toolList = () => {
    registerTools([multiEditTool, todoWriteTool, webFetchTool, ...EXTENDED_TOOLS]);
    return allRegisteredTools().map((t) => ({ name: t.name, description: t.description || "" }));
  };

  /* ------------------------------------------------------------ file browser -- */

  /** Reject paths outside the configured working directory. */
  function safePath(p) {
    const root = resolve(cwd);
    const target = resolve(String(p || "."));
    const rel = relative(root, target);
    if (rel === "") return target;
    if (rel.startsWith("..") || isAbsolute(rel)) return null;
    return target;
  }

  async function listDir(dir) {
    const target = safePath(dir);
    if (!target) return null;
    const entries = await readdir(target, { withFileTypes: true });
    const out = [];
    for (const e of entries) {
      if (e.name === "node_modules" || e.name === ".git") continue;
      const full = join(target, e.name);
      let size = 0;
      if (!e.isDirectory()) {
        try { size = (await stat(full)).size; } catch {}
      }
      out.push({ name: e.name, path: full, dir: e.isDirectory(), size });
    }
    out.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
    return { path: target, parent: target === resolve(cwd) ? null : dirname(target), entries: out };
  }

  async function readFileForViewer(p) {
    const target = safePath(p);
    if (!target) return null;
    const st = await stat(target);
    if (st.isDirectory()) return { error: "is a directory" };
    const ext = extname(target).toLowerCase();
    const name = basename(target);
    if (BINARY_EXT.has(ext)) {
      return { path: target, name, size: st.size, binary: true, content: "", truncated: false };
    }
    const raw = await readFile(target);
    const slice = raw.subarray(0, MAX_FILE_BYTES);
    const text = slice.toString("utf8");
    const binary = text.includes("\u0000");
    return {
      path: target,
      name,
      size: st.size,
      utf8: !binary,
      binary,
      truncated: raw.length > MAX_FILE_BYTES,
      content: binary ? "" : text
    };
  }

  /* ----------------------------------------------------------------- routes -- */

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${port}`);
    const path = url.pathname;

    // Host-header guard: the server binds to loopback and should only answer
    // loopback names, so a hostile page cannot drive it through DNS rebinding.
    const host = String(req.headers.host || "");
    if (!/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(host)) {
      sendText(res, 403, "forbidden host");
      return;
    }

    try {
      /* ---- static assets ---- */
      if (path === "/" || path === "/index.html") {
        sendText(res, 200, assets.page, MIME[".html"]);
        return;
      }
      if (path === "/app.css") {
        sendText(res, 200, assets.styles, MIME[".css"]);
        return;
      }
      if (path === "/app.js") {
        sendText(res, 200, assets.app, MIME[".js"]);
        return;
      }
      if (path === "/markdown.js") {
        sendText(res, 200, assets.markdown, MIME[".js"]);
        return;
      }

      /* ---- config ---- */
      if (path === "/api/config" && req.method === "GET") {
        const key = url.searchParams.get("sessionKey") || "default";
        const agent = sessions.get(key);
        sendJson(res, 200, {
          version: VERSION,
          model: config.model,
          provider: config.provider,
          baseUrl: config.baseUrl,
          permissionMode: agent?.mode ?? config.permissionMode,
          vision: config.vision !== false,
          cwd,
          permissions: config.permissions || {},
          fallbacks: (config.fallbacks || []).map((f) => ({ name: f.name || f.model, model: f.model })),
          routing: agent ? agent.routingStatus?.() : null,
          tools: toolList(),
          ...statsOf(agent)
        });
        return;
      }

      if (path === "/api/config" && req.method === "POST") {
        const body = await readJson(req);
        if (body.model) {
          config.model = String(body.model);
          provider.model = config.model;
          for (const agent of sessions.values()) agent.setModel?.(config.model);
          saveConfig({ model: config.model });
        }
        if (body.permissionMode && ["ask", "auto", "plan"].includes(body.permissionMode)) {
          config.permissionMode = body.permissionMode;
          saveConfig({ permissionMode: config.permissionMode });
          for (const agent of sessions.values()) agent.setMode?.(config.permissionMode);
        }
        if (typeof body.vision === "boolean") {
          config.vision = body.vision;
          saveConfig({ vision: config.vision });
          for (const agent of sessions.values()) agent.setVision?.(config.vision);
        }
        if (body.baseUrl) {
          config.baseUrl = String(body.baseUrl);
          provider.baseUrl = config.baseUrl.replace(/\/+$/, "");
          saveConfig({ baseUrl: config.baseUrl });
        }
        if (body.apiKey) {
          config.apiKey = String(body.apiKey);
          provider.apiKey = config.apiKey;
          saveConfig({ apiKey: config.apiKey });
        }
        sendJson(res, 200, { ok: true, permissionMode: config.permissionMode, vision: config.vision !== false, model: config.model });
        return;
      }

      /* ---- permissions ---- */
      if (path === "/api/permissions" && req.method === "GET") {
        sendJson(res, 200, { permissions: config.permissions || {} });
        return;
      }
      if (path === "/api/permissions" && req.method === "POST") {
        const body = await readJson(req);
        const perms = { allow: [], deny: [], ask: [], ...(config.permissions || {}) };
        for (const kind of ["allow", "deny", "ask"]) {
          const add = body.add?.[kind];
          if (Array.isArray(add)) {
            for (const rule of add) if (!perms[kind].includes(rule)) perms[kind].push(String(rule));
          }
          const remove = body.remove?.[kind];
          if (Array.isArray(remove)) perms[kind] = perms[kind].filter((r) => !remove.includes(r));
        }
        config.permissions = perms;
        saveConfig({ permissions: perms });
        for (const agent of sessions.values()) {
          if (agent.permissions) agent.permissions = new (agent.permissions.constructor)(perms);
        }
        sendJson(res, 200, { ok: true, permissions: perms });
        return;
      }

      /* ---- 模型列表（供设置页选择）---- */
      if (path === "/api/models" && req.method === "GET") {
        try {
          const models = await provider.listModels();
          sendJson(res, 200, { ok: true, models });
        } catch (e) {
          sendJson(res, 200, { ok: false, models: [], error: String(e?.message || e) });
        }
        return;
      }

      /* ---- tools / tasks / fs / mcp ---- */
      if (path === "/api/tools") {
        sendJson(res, 200, { tools: toolList() });
        return;
      }

      if (path === "/api/tasks") {
        sendJson(res, 200, { tasks: taskSummaries() });
        return;
      }

      if (path === "/api/mcp") {
        // Any live agent owns the shared manager, so search across tabs.
        let servers = [];
        for (const agent of sessions.values()) {
          try {
            const st = agent?.mcpManager?.status?.();
            if (st && st.length) { servers = st; break; }
            if (st) { servers = st; }
          } catch {}
        }
        // Before the first turn no agent exists yet, so fall back to the
        // configured names; the UI can then show "waiting" instead of claiming
        // nothing is configured.
        if (!servers.length) {
          servers = Object.entries(config.mcpServers || {})
            .filter(([, spec]) => !spec?.disabled)
            .map(([name, spec]) => ({
              name,
              tools: 0,
              pending: true,
              transport: spec?.url ? (spec.transport || "http") : "stdio",
              url: spec?.url || null,
            }));
        }
        sendJson(res, 200, { servers });
        return;
      }

      if (path === "/api/todos") {
        const key = url.searchParams.get("sessionKey") || "default";
        sendJson(res, 200, { todos: getTodos(key) });
        return;
      }

      if (path === "/api/fs" && req.method === "GET") {
        const dir = url.searchParams.get("path") || cwd;
        const listing = await listDir(dir);
        if (!listing) { sendJson(res, 403, { error: "path outside the workspace" }); return; }
        sendJson(res, 200, listing);
        return;
      }

      if (path === "/api/fs/file" && req.method === "GET") {
        const name = url.searchParams.get("path");
        if (!name) { sendJson(res, 400, { error: "path is required" }); return; }
        const file = await readFileForViewer(name);
        if (!file) { sendJson(res, 403, { error: "path outside the workspace" }); return; }
        if (file.error) { sendJson(res, 400, file); return; }
        sendJson(res, 200, file);
        return;
      }

      /* ---- confirm / answer ---- */
      if (path === "/api/confirm" && req.method === "POST") {
        const body = await readJson(req);
        const resolve = confirmResolvers.get(body.id);
        if (resolve) {
          confirmResolvers.delete(body.id);
          resolve(!!body.allow);
        }
        sendJson(res, 200, { ok: true });
        return;
      }

      if (path === "/api/answer" && req.method === "POST") {
        const body = await readJson(req);
        const resolve = questionResolvers.get(body.id);
        if (resolve) {
          questionResolvers.delete(body.id);
          resolve(body.answers ?? null);
        }
        sendJson(res, 200, { ok: true });
        return;
      }

      /* ---- abort ---- */
      if (path === "/api/abort" && req.method === "POST") {
        const body = await readJson(req);
        const key = keyOf(body);
        const agent = sessions.get(key);
        if (agent && typeof agent.abort === "function") agent.abort();
        for (const [, resolve] of confirmResolvers) resolve(false);
        confirmResolvers.clear();
        for (const [, resolve] of questionResolvers) resolve(null);
        questionResolvers.clear();
        sendJson(res, 200, { ok: true, aborted: !!agent });
        return;
      }

      /* ---- attachments ---- */
      if (path === "/api/attach" && req.method === "POST") {
        const body = await readJson(req);
        const inputs = [];
        for (const p of body.paths || []) inputs.push({ path: String(p) });
        for (const f of body.files || []) {
          if (!f?.data) continue;
          inputs.push({
            kind: f.mime?.startsWith("image/") ? "image" : "text",
            name: f.name, mime: f.mime, data: f.data, size: f.size
          });
        }
        const resolved = await resolveAttachments(inputs);
        const ok = resolved.filter((a) => a.kind !== "error");
        const failed = resolved.filter((a) => a.kind === "error");
        sendJson(res, 200, {
          ok: true,
          attachments: ok.map((a) => ({ ...a, label: describeAttachment(a) })),
          errors: failed.map((a) => ({ name: a.name, error: a.error }))
        });
        return;
      }

      /* ---- chat (SSE) ---- */
      if (path === "/api/chat" && req.method === "POST") {
        const body = await readJson(req);
        const key = keyOf(body);
        res.writeHead(200, {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache, no-transform",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no"
        });
        res.flushHeaders?.();

        const ui = makeTurnUi(res, key);
        const agent = await agentFor(key, ui);
        const saver = saverFor(key, agent);

        try {
          // Retry: drop the previous answer (and optionally swap the prompt)
          // before asking the model again. The browser has already replaced the
          // rendered messages, so only the history needs rewinding here.
          if (body.retry) {
            // Rewind keeps the last user message; re-running it would append a
            // duplicate, so it is dropped and only the loop is replayed.
            agent.rewind(typeof body.message === "string" ? body.message : undefined);
            await agent.run("", { attachments: body.attachments, reuseLastUser: true });
          } else {
            await agent.run(String(body.message || ""), { attachments: body.attachments });
          }
          agent.maybeCompact?.();
        } catch (e) {
          ui.error(`agent error: ${e.message}`);
        }

        try { saver.save({ force: true }); } catch {}
        sse(res, { type: "todos", todos: getTodos(key) });
        sse(res, { type: "stats", ...statsOf(agent) });
        sse(res, { type: "mode", permissionMode: agent.mode ?? config.permissionMode });
        if (agent.routingStatus) sse(res, { type: "routing", ...agent.routingStatus() });
        sse(res, { type: "session", id: saver.id, file: saver.file ?? null });
        sse(res, { type: "done" });
        res.end();
        return;
      }

      /* ---- sessions ---- */
      if (path === "/api/sessions" && req.method === "GET") {
        pruneSessions();
        const rows = listSessions().map(withTitle);
        rows.sort((a, b) => {
          if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1;
          return String(b.updatedAt || b.savedAt).localeCompare(String(a.updatedAt || a.savedAt));
        });
        sendJson(res, 200, { sessions: rows });
        return;
      }

      if (path.startsWith("/api/sessions/") && req.method === "PATCH") {
        const id = decodeURIComponent(path.slice("/api/sessions/".length));
        const body = await readJson(req);
        const data = loadSession(id);
        if (!data) { sendJson(res, 404, { ok: false, error: "session not found" }); return; }
        if (typeof body.title === "string") data.title = body.title.slice(0, 120);
        if (typeof body.pinned === "boolean") data.pinned = body.pinned;
        saveSession(id, data.messages || [], {
          cwd: data.cwd,
          model: data.model,
          provider: data.provider,
          permissionMode: data.permissionMode,
          turnCount: data.turnCount,
          version: data.version,
          ui: data.ui,
          title: data.title,
          pinned: data.pinned
        });
        sendJson(res, 200, { ok: true, id, title: data.title, pinned: !!data.pinned });
        return;
      }

      if (path.startsWith("/api/sessions/") && req.method === "DELETE") {
        const id = decodeURIComponent(path.slice("/api/sessions/".length));
        const removed = deleteSession(id);
        if (removed) {
          savers.get(id)?.dispose?.();
          savers.delete(id);
          sessions.delete(id);
        }
        sendJson(res, 200, { ok: removed });
        return;
      }

      if (path === "/api/session" && req.method === "POST") {
        const body = await readJson(req);
        const target =
          body.action === "resume" && body.id
            ? loadSession(String(body.id))
            : loadSession(latestSession({ cwd })?.id ?? latestSession()?.id ?? "");
        if (!target) {
          sendJson(res, 404, { ok: false, error: "session not found" });
          return;
        }
        const key = keyOf(body);
        const agent = await agentFor(key, makeUi({ write: () => {}, writableEnded: true }));
        agent.messages = target.messages || [];
        agent.turnCount = target.turnCount || 0;
        const saver = saverFor(key, agent);
        saver.rotate(target.id);
        sendJson(res, 200, {
          ok: true,
          id: target.id,
          messages: agent.messages.length,
          transcript: agent.messages
        });
        return;
      }

      if (path === "/api/session/export" && req.method === "GET") {
        const id = url.searchParams.get("id") || "";
        const data = loadSession(id);
        if (!data) { sendJson(res, 404, { ok: false, error: "session not found" }); return; }
        sendJson(res, 200, { ok: true, id, markdown: toMarkdown(data) });
        return;
      }

      if (path === "/api/reset" && req.method === "POST") {
        const body = await readJson(req);
        const key = keyOf(body);
        savers.get(key)?.dispose?.();
        savers.delete(key);
        const agent = sessions.get(key);
        if (agent) {
          agent.messages = [];
          agent.turnCount = 0;
        }
        sessions.delete(key);
        sendJson(res, 200, { ok: true });
        return;
      }

      sendText(res, 404, "not found");
    } catch (e) {
      if (!res.headersSent) sendJson(res, 500, { error: String(e?.message || e) });
      else res.end();
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });

  server.on("close", () => {
    for (const saver of savers.values()) {
      try { saver.dispose(); } catch {}
    }
    savers.clear();
  });

  const boundPort = server.address().port;
  const address = `http://127.0.0.1:${boundPort}`;
  if (open) {
    const cmd =
      process.platform === "win32"
        ? `start "" "${address}"`
        : process.platform === "darwin"
          ? `open "${address}"`
          : `xdg-open "${address}"`;
    import("node:child_process").then(({ exec }) => exec(cmd));
  }

  return { server, address, port: boundPort };
}

/** Render a stored session as a Markdown document. */
function toMarkdown(data) {
  const lines = [];
  const title = data.title || "MyClaude chat";
  lines.push("# " + title, "");
  const meta = [];
  if (data.model) meta.push("model: " + data.model);
  if (data.cwd) meta.push("cwd: " + data.cwd);
  if (data.updatedAt || data.savedAt) meta.push("saved: " + (data.updatedAt || data.savedAt));
  if (meta.length) lines.push("_" + meta.join("  ·  ") + "_", "");

  for (const m of data.messages || []) {
    if (m.role === "user") {
      const text = typeof m.content === "string"
        ? m.content
        : (m.content || []).filter((p) => p.type === "text").map((p) => p.text).join("\n");
      if (text && text.trim()) lines.push("## User", "", text.trim(), "");
    } else if (m.role === "assistant" && m.content) {
      lines.push("## MyClaude", "", String(m.content).trim(), "");
    }
  }
  return lines.join("\n");
}

/** Derive a readable chat title from the first user message. */
function withTitle(s) {
  if (s.title) return s;
  // Titles are stored on save once the user renames a chat; otherwise they are
  // derived from the first user message.

  let title = null;
  try {
    const data = loadSession(s.id);
    const first = (data?.messages || []).find((m) => m.role === "user");
    if (first) {
      const text =
        typeof first.content === "string"
          ? first.content
          : (first.content || []).filter((p) => p.type === "text").map((p) => p.text).join(" ");
      const clean = String(text || "").replace(/\s+/g, " ").trim();
      title = clean.length > 60 ? clean.slice(0, 57) + "..." : clean;
    }
  } catch {}
  return { ...s, title: title || s.id };
}

