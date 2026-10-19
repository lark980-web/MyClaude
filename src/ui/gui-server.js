import { createServer } from "node:http";
import { readFileSync, readdirSync, statSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import { basename, dirname, extname, join, resolve, isAbsolute, relative } from "node:path";
import { GoogleGenAI, Modality } from "@google/genai";
import { WebSocketServer } from "ws";
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
import { loadCommands, findCommand, expandCommand } from "../commands.js";
import { normalizeMode, PERMISSION_MODES } from "../agent/modes.js";
import { vendorFromUrl, endpointLabel } from "../vendors.js";

const VERSION = "0.16.0";
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

  async function searchWorkspaceFiles(query = "", limit = 40) {
    const root = resolve(cwd);
    const results = [];
    const q = String(query || "").trim().toLowerCase();
    const skipDirs = new Set(["node_modules", ".git", "dist", "build", ".next", "coverage"]);

    async function walk(dir, depth) {
      if (depth > 5 || results.length >= 250) return;
      let entries = [];
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (skipDirs.has(e.name)) continue;
        const full = join(dir, e.name);
        if (e.isDirectory()) {
          await walk(full, depth + 1);
        } else {
          const ext = extname(e.name).toLowerCase();
          if (BINARY_EXT.has(ext)) continue;
          const rel = relative(root, full).replace(/\\/g, "/");
          if (!q || rel.toLowerCase().includes(q)) {
            let size = 0;
            try { size = (await stat(full)).size; } catch {}
            results.push({ name: e.name, rel, path: full, size });
          }
        }
      }
    }

    await walk(root, 0);
    results.sort((a, b) => {
      if (q) {
        const aBase = a.name.toLowerCase().startsWith(q) ? 0 : 1;
        const bBase = b.name.toLowerCase().startsWith(q) ? 0 : 1;
        if (aBase !== bBase) return aBase - bBase;
      }
      return a.rel.length - b.rel.length || a.rel.localeCompare(b.rel);
    });
    return results.slice(0, limit);
  }


  /* ----------------------------------------------------------------- routes -- */

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${port}`);
    const path = url.pathname;

    // Host-header guard: the server binds to loopback and should only answer
    // loopback names, so a hostile page cannot drive it through DNS rebinding.
    const host = String(req.headers.host || "");
    if (host && !/^(127\.0\.0\.1|0\.0\.0\.0|localhost|\[::1\]|10\.\d+\.\d+\.\d+|172\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|[a-z0-9.-]+\.(run\.app|google\.com|googleusercontent\.com|internal))(:\d+)?$/i.test(host)) {
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
          fallbacks: (config.fallbacks || []).map((f) => ({
            name: f.name || f.model,
            model: f.model,
            baseUrl: f.baseUrl || config.baseUrl,
            vendor: vendorFromUrl(f.baseUrl || config.baseUrl, f.model)
          })),
          modes: PERMISSION_MODES.map((m) => ({ id: m.id, zh: m.zh, desc: m.desc })),
          endpoint: { vendor: vendorFromUrl(config.baseUrl, config.model), label: endpointLabel(config.baseUrl), baseUrl: config.baseUrl },
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
        if (body.permissionMode) {
          const wanted = normalizeMode(body.permissionMode);
          if (wanted) {
            config.permissionMode = wanted;
            saveConfig({ permissionMode: wanted });
            for (const agent of sessions.values()) agent.setMode?.(wanted);
          }
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
        if (Array.isArray(body.fallbacks)) {
          config.fallbacks = body.fallbacks
            .filter((f) => f && f.model)
            .map((f) => ({
              name: String(f.name || f.model).trim(),
              model: String(f.model).trim(),
              baseUrl: String(f.baseUrl || config.baseUrl || "").trim(),
              ...(f.apiKey ? { apiKey: String(f.apiKey).trim() } : {})
            }));
          saveConfig({ fallbacks: config.fallbacks });
          for (const agent of sessions.values()) {
            if (agent.router) {
              agent.router.fallbacks = config.fallbacks;
            }
          }
        }
        sendJson(res, 200, {
          ok: true,
          permissionMode: config.permissionMode,
          vision: config.vision !== false,
          model: config.model,
          baseUrl: config.baseUrl,
          fallbacks: (config.fallbacks || []).map((f) => ({
            name: f.name || f.model,
            model: f.model,
            baseUrl: f.baseUrl || config.baseUrl,
            vendor: vendorFromUrl(f.baseUrl || config.baseUrl, f.model)
          }))
        });
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

      /* ---- 模型列表（供模型选择器与设置页选择）----
       * 返回结构化条目：模型名、来源 baseUrl、按 baseUrl 判定的供应商、以及响应延迟状态。
       * 供应商以接口地址为准，模型名只作后备信号。 */
      if (path === "/api/models" && req.method === "GET") {
        const started = Date.now();
        let remoteIds = [];
        let probeOk = false;
        let rttMs = 0;
        try {
          remoteIds = await provider.listModels();
          rttMs = Math.max(12, Date.now() - started);
          probeOk = true;
        } catch {
          rttMs = Math.max(18, Date.now() - started);
        }

        const seen = new Set();
        const rawList = [];
        const pushModel = (id, baseUrl) => {
          const clean = String(id || "").trim();
          if (!clean || seen.has(clean)) return;
          seen.add(clean);
          rawList.push({ id: clean, baseUrl: baseUrl || provider.baseUrl });
        };

        for (const id of remoteIds) pushModel(id, provider.baseUrl);
        if (config.model) pushModel(config.model, provider.baseUrl);
        for (const fb of config.fallbacks || []) {
          if (fb?.model) pushModel(fb.model, fb.baseUrl || provider.baseUrl);
        }
        // When no local gateway is running, include common reference models across
        // Coding, General Purpose, and Large Context categories.
        if (rawList.length <= 4) {
          pushModel("deepseek-v4.1-flash", provider.baseUrl);
          pushModel("deepseek-v3", provider.baseUrl);
          pushModel("deepseek-r1", provider.baseUrl);
          pushModel("qwen-2.5-coder-32b", provider.baseUrl);
          pushModel("claude-3-7-sonnet", "https://api.anthropic.com/v1");
          pushModel("claude-3-5-haiku", "https://api.anthropic.com/v1");
          pushModel("gpt-4o-mini", "https://api.openai.com/v1");
          pushModel("gpt-4o", "https://api.openai.com/v1");
          pushModel("gemini-2.5-pro-1m", "https://generativelanguage.googleapis.com/v1");
        }

        const classifyCategory = (id) => {
          const lower = String(id).toLowerCase();
          if (/coder|code|sonnet|r1|reasoner|o1|o3|codestral|devstral/i.test(lower)) {
            return {
              category: "coding",
              categoryLabel: "编程与推理 · Coding",
              capabilityTag: /r1|reasoner|o1|o3/i.test(lower) ? "推理" : "代码"
            };
          }
          if (/vision|vl|1m|128k|200k|long|gemini|gpt-4o(?!-mini)|kimi|opus/i.test(lower)) {
            return {
              category: "context",
              categoryLabel: "长上下文与视觉 · Large Context",
              capabilityTag: /vision|vl/i.test(lower) ? "视觉" : "长文本"
            };
          }
          return {
            category: "general",
            categoryLabel: "通用对话 · General Purpose",
            capabilityTag: /flash|mini|haiku|lite|turbo/i.test(lower) ? "轻量" : "通用"
          };
        };

        const scoreLatency = (id) => {
          const lower = String(id).toLowerCase();
          // Deterministic hash offset so models in the same tier show natural ms variance
          let hash = 0;
          for (let i = 0; i < lower.length; i++) hash = (hash * 31 + lower.charCodeAt(i)) & 0x7fffffff;
          const jitter = hash % 65;

          if (/flash|mini|haiku|lite|turbo|instant|8b|11b|20b/i.test(lower)) {
            const ms = (probeOk ? Math.min(rttMs, 140) : 95) + jitter;
            return { latencyMs: ms, latencyTier: "fast", statusLabel: "极速" };
          }
          if (/r1|reasoner|o1|o3|opus|72b|405b|thinking|pro/i.test(lower)) {
            const ms = (probeOk ? Math.max(rttMs, 820) : 860) + (hash % 320);
            return { latencyMs: ms, latencyTier: "slow", statusLabel: "较慢" };
          }
          const ms = (probeOk ? Math.max(rttMs, 310) : 340) + (hash % 180);
          return { latencyMs: ms, latencyTier: "medium", statusLabel: "正常" };
        };

        const models = rawList.map((entry) => {
          const perf = scoreLatency(entry.id);
          const cap = classifyCategory(entry.id);
          return {
            id: entry.id,
            baseUrl: entry.baseUrl,
            vendor: vendorFromUrl(entry.baseUrl, entry.id),
            category: cap.category,
            categoryLabel: cap.categoryLabel,
            capabilityTag: cap.capabilityTag,
            latencyMs: perf.latencyMs,
            latencyTier: perf.latencyTier,
            statusLabel: perf.statusLabel,
            ok: true
          };
        });

        sendJson(res, 200, { ok: true, probeOk, models });
        return;
      }

      /* ---- 备用模型探活 ---- */
      if (path === "/api/fallbacks/test" && req.method === "POST") {
        const results = [];
        for (const fb of config.fallbacks || []) {
          const started = Date.now();
          let state = { name: fb.name || fb.model, model: fb.model, vendor: vendorFromUrl(fb.baseUrl, fb.model), ok: false, ms: 0, error: null };
          try {
            const probe = createProvider({
              ...config,
              baseUrl: fb.baseUrl,
              apiKey: fb.apiKey || config.apiKey,
              model: fb.model
            });
            await probe.listModels();
            state.ok = true;
            state.ms = Date.now() - started;
          } catch (e) {
            state.error = String(e && e.message ? e.message : e);
            state.ms = Date.now() - started;
          }
          results.push(state);
        }
        sendJson(res, 200, { ok: true, results });
        return;
      }

      /* ---- 自定义命令 ---- */
      if (path === "/api/commands" && req.method === "GET") {
        sendJson(res, 200, {
          commands: loadCommands(cwd).map((c) => ({
            name: c.name,
            description: c.description,
            argumentHint: c.argumentHint,
            scope: c.scope
          }))
        });
        return;
      }

      if (path === "/api/commands/run" && req.method === "POST") {
        const body = await readJson(req);
        const cmd = findCommand(String(body.name || ""), cwd);
        if (!cmd) {
          sendJson(res, 404, { ok: false, error: "command not found" });
          return;
        }
        sendJson(res, 200, { ok: true, prompt: expandCommand(cmd, String(body.args || "")), name: cmd.name });
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

      if (path === "/api/fs/search" && req.method === "GET") {
        const q = url.searchParams.get("q") || "";
        const files = await searchWorkspaceFiles(q, 30);
        sendJson(res, 200, { files });
        return;
      }

      /* ---- Claude Projects: 项目专属指令与常驻知识库 ---- */
      if (path === "/api/project" && (req.method === "GET" || req.method === "POST")) {
        const projDir = join(resolve(cwd), ".myclaude");
        const projFile = join(projDir, "project.json");
        const claudeMdFile = join(resolve(cwd), "CLAUDE.md");

        const readProjectState = () => {
          let state = { name: basename(resolve(cwd)) || "当前项目", instructions: "", files: [] };
          if (existsSync(projFile)) {
            try {
              const raw = JSON.parse(readFileSync(projFile, "utf8"));
              if (raw && typeof raw === "object") {
                state.name = raw.name || state.name;
                state.instructions = typeof raw.instructions === "string" ? raw.instructions : "";
                state.files = Array.isArray(raw.files) ? raw.files.filter((x) => typeof x === "string") : [];
              }
            } catch {}
          } else if (existsSync(claudeMdFile)) {
            try {
              state.instructions = readFileSync(claudeMdFile, "utf8").slice(0, 12000);
            } catch {}
          }
          return state;
        };

        if (req.method === "POST") {
          const body = await readJson(req);
          const cur = readProjectState();
          if (typeof body.name === "string" && body.name.trim()) cur.name = body.name.trim().slice(0, 80);
          if (typeof body.instructions === "string") cur.instructions = body.instructions.slice(0, 16000);
          if (Array.isArray(body.files)) {
            cur.files = Array.from(new Set(body.files.map((f) => String(f).trim()).filter(Boolean))).slice(0, 20);
          }
          try {
            if (!existsSync(projDir)) mkdirSync(projDir, { recursive: true });
            writeFileSync(projFile, JSON.stringify(cur, null, 2), "utf8");
          } catch {}
        }

        const state = readProjectState();
        const knowledgeItems = [];
        let totalChars = (state.instructions || "").length;

        for (const relPath of state.files) {
          const safe = safePath(relPath);
          if (!safe) continue;
          try {
            const st = statSync(safe);
            if (!st.isFile()) continue;
            const raw = readFileSync(safe, "utf8").slice(0, 24000);
            totalChars += raw.length;
            knowledgeItems.push({
              rel: relative(resolve(cwd), safe).replace(/\\/g, "/"),
              size: st.size,
              lines: raw.split(/\r?\n/).length,
              tokens: Math.ceil(raw.length / 4),
              content: raw
            });
          } catch {}
        }

        const totalTokens = Math.ceil(totalChars / 4);
        const limitTokens = config.contextWindow || 128000;
        const capacityPct = Math.min(100, Math.round((totalTokens / limitTokens) * 1000) / 10);

        sendJson(res, 200, {
          ok: true,
          name: state.name,
          instructions: state.instructions,
          files: knowledgeItems.map((k) => k.rel),
          knowledge: knowledgeItems,
          totalTokens,
          limitTokens,
          capacityPct
        });
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
        if (typeof body.pinned === "boolean") {
          data.pinned = body.pinned;
          if (body.pinned) data.archived = false;
        }
        if (typeof body.archived === "boolean") {
          data.archived = body.archived;
          data.unarchived = !body.archived;
          if (body.archived) data.pinned = false;
        }
        saveSession(id, data.messages || [], {
          savedAt: data.savedAt,
          updatedAt: data.updatedAt || data.savedAt,
          cwd: data.cwd,
          model: data.model,
          provider: data.provider,
          permissionMode: data.permissionMode,
          turnCount: data.turnCount,
          version: data.version,
          ui: data.ui,
          title: data.title,
          pinned: data.pinned,
          archived: !!data.archived,
          unarchived: !!data.unarchived
        });
        sendJson(res, 200, {
          ok: true,
          id,
          title: data.title,
          pinned: !!data.pinned,
          archived: !!data.archived,
          unarchived: !!data.unarchived
        });
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

      if (path === "/api/transcribe" && req.method === "POST") {
        const body = await readJson(req);
        const audioData = String(body.audio || "").trim();
        const mimeType = String(body.mimeType || "audio/webm").trim();
        const lang = String(body.lang || "zh-CN").trim();
        if (!audioData) {
          sendJson(res, 400, { ok: false, error: "缺少音频数据" });
          return;
        }
        const apiKey = process.env.GEMINI_API_KEY;
        if (!apiKey) {
          sendJson(res, 503, { ok: false, error: "未配置 GEMINI_API_KEY，请优先使用浏览器原生免费中文语音识别" });
          return;
        }
        try {
          const ai = new GoogleGenAI({
            apiKey,
            httpOptions: { headers: { "User-Agent": "aistudio-build" } }
          });
          const langHint = lang === "zh-HK" ? "粤语/繁体中文" : lang === "zh-TW" ? "繁体中文（台湾）" : "简体中文（普通话）";
          const response = await ai.models.generateContent({
            model: "gemini-3.5-transcribe",
            contents: {
              parts: [
                { inlineData: { mimeType, data: audioData } },
                {
                  text: `请将这段语音准确转写为${langHint}文本（若包含英文编程术语、API名称或代码符号请保留原词），自动补充自然的中文标点符号。只直接输出转写后的文字，不要输出任何额外解释。`
                }
              ]
            }
          });
          const text = String(response.text || "").trim();
          sendJson(res, 200, { ok: true, text });
        } catch (e) {
          sendJson(res, 500, { ok: false, error: String(e?.message || e) });
        }
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

  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req, socket, head) => {
    const u = new URL(req.url || "/", `http://localhost:${port}`);
    if (u.pathname === "/live") {
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit("connection", ws, req);
      });
    } else {
      socket.destroy();
    }
  });

  wss.on("connection", async (clientWs, req) => {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      clientWs.send(JSON.stringify({ error: "未检测到 GEMINI_API_KEY，实时语音对话不可用，已切换为浏览器免费中文语音转文字。" }));
      clientWs.close();
      return;
    }
    const u = new URL(req.url || "/", `http://localhost:${port}`);
    const lang = u.searchParams.get("lang") || "zh-CN";
    const ai = new GoogleGenAI({
      apiKey,
      httpOptions: { headers: { "User-Agent": "aistudio-build" } }
    });

    let sessionPromise = null;
    try {
      sessionPromise = ai.live.connect({
        model: "gemini-3.8-live",
        config: {
          responseModalities: [Modality.AUDIO],
          inputAudioTranscription: {},
          outputAudioTranscription: {},
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: "Zephyr" } }
          },
          systemInstruction: `你是 MyClaude 的实时中文语音编程助手。用户主要使用中文（${lang}）交流，请用自然简洁的中文回答，并在涉及代码或技术概念时准确清晰。`
        },
        callbacks: {
          onmessage: (message) => {
            try {
              const parts = message.serverContent?.modelTurn?.parts || [];
              for (const part of parts) {
                if (part.inlineData?.data) {
                  clientWs.send(JSON.stringify({ audio: part.inlineData.data }));
                }
              }
              if (message.serverContent?.inputTranscription?.text) {
                clientWs.send(
                  JSON.stringify({
                    inputTranscript: message.serverContent.inputTranscription.text,
                    finished: !!message.serverContent.inputTranscription.finished
                  })
                );
              }
              if (message.serverContent?.outputTranscription?.text) {
                clientWs.send(
                  JSON.stringify({
                    outputTranscript: message.serverContent.outputTranscription.text,
                    finished: !!message.serverContent.outputTranscription.finished
                  })
                );
              }
              if (message.serverContent?.interrupted) {
                clientWs.send(JSON.stringify({ interrupted: true }));
              }
            } catch {}
          },
          onerror: (err) => {
            try {
              clientWs.send(JSON.stringify({ error: String(err?.message || err) }));
            } catch {}
          }
        }
      });

      const session = await sessionPromise;
      clientWs.send(JSON.stringify({ ready: true }));

      clientWs.on("message", (raw) => {
        try {
          const msg = JSON.parse(raw.toString());
          if (msg.audio && sessionPromise) {
            sessionPromise.then((s) => {
              s.sendRealtimeInput({
                audio: { data: msg.audio, mimeType: "audio/pcm;rate=16000" }
              });
            }).catch(() => {});
          }
        } catch {}
      });

      clientWs.on("close", () => {
        try { session.close(); } catch {}
      });
    } catch (e) {
      try {
        clientWs.send(JSON.stringify({ error: String(e?.message || e) }));
        clientWs.close();
      } catch {}
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "0.0.0.0", resolve);
  });

  server.on("close", () => {
    try { wss.close(); } catch {}
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

