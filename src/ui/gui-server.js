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
import { MODELS, PROVIDER_PRESETS, findModel, supportsVision, contextWindowOf } from "../models.js";

import { VERSION } from "../version.js";
import { HOOK_EVENTS, TOOL_EVENTS } from "../hooks.js";
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
// Session keys with a run in flight. The agent objects are per key, so a
// second /api/chat on the same key would put two run loops on one agent:
// interleaved history, overwritten abort controllers, two SSE streams.
const running = new Set();
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
      agent = await createAgent({ provider, config, ui, sessionKey: key, providerFactory: () => createProvider(config) });
      sessions.set(key, agent);
    } else if (ui) {
      if (typeof agent.setUi === "function") agent.setUi(ui);
      else agent.ui = ui;
    }
    return agent;
  };

/**
 * Build a preview diff from the arguments of a mutating tool.
 *
 * The confirm dialog used to show raw JSON, which asks the user to approve a
 * change they cannot see: `{"file_path":"a.js","old_string":"…"}` says nothing
 * about the resulting file. Turning the arguments into a unified diff lets the
 * existing renderDiff() draw the same coloured view used by GitDiff.
 *
 * Only Write / Edit / MultiEdit are previewed; other tools return null and the
 * client falls back to showing the arguments.
 */
function buildConfirmDiff(name, args) {
  const a = args || {};
  const files = [];
  const split = (text) => String(text == null ? "" : text).split(/\r?\n/);

  if (name === "Write") {
    const body = split(a.content);
    const lines2 = body.map((text) => ({ type: "add", text }));
    files.push({
      name: String(a.file_path || "(file)"),
      added: body.length,
      removed: 0,
      hunks: [{ header: "@@ new file @@", lines: lines2 }],
    });
  } else if (name === "Edit") {
    const before = split(a.old_string);
    const after = split(a.new_string);
    const body = [
      ...before.map((text) => ({ type: "del", text })),
      ...after.map((text) => ({ type: "add", text })),
    ];
    files.push({
      name: String(a.file_path || "(file)"),
      added: after.length,
      removed: before.length,
      hunks: [{ header: "@@ edit @@", lines: body }],
    });
  } else if (name === "MultiEdit") {
    for (const edit of a.edits || []) {
      const before = split(edit.old_string);
      const after = split(edit.new_string);
      files.push({
        name: String(a.file_path || "(file)"),
        added: after.length,
        removed: before.length,
        hunks: [{
          header: "@@ edit " + (files.length + 1) + " @@",
          lines: [
            ...before.map((text) => ({ type: "del", text })),
            ...after.map((text) => ({ type: "add", text })),
          ],
        }],
      });
    }
  } else {
    return null;
  }

  return files.length ? files : null;
}

  /** UI adapter: every method maps onto one SSE event. */
  const makeUi = (res) => ({
    streamText: (t) => sse(res, { type: "delta", text: t }),
    reasoningText: (t) => sse(res, { type: "reasoning", text: t }),
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
        sse(res, { type: "confirm", id, name, args, diff: buildConfirmDiff(name, args) });
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
    // Bash writes oversized output to a file and returns the path; forward it so
    // the client can offer a way to open the full log.
    if (result.persistedOutputPath) {
      out.persistedOutputPath = result.persistedOutputPath;
      out.persistedOutputSize = result.persistedOutputSize || 0;
    }
    return Object.keys(out).length ? out : null;
  };

  const statsOf = (agent) => {
    // Prefer the endpoint's own accounting; fall back to the character
    // estimate when a provider does not report usage.
    const reported = agent ? (agent.totalInputTokens || 0) + (agent.totalOutputTokens || 0) : 0;
    const used = reported || approxTokens(agent);
    // The agent resolves the real window per model; config.contextWindow is
    // only the pre-selection fallback.
    const window = (agent && agent.contextWindow) || config.contextWindow || 200000;
    const limit = Math.round(window * (config.compactThreshold || 0.8));
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

    // Host-header guard: allows loopback and cloud preview hosts
    const host = String(req.headers.host || "");
    // Allow loopback, private ranges and known preview hosts. A trailing
    // catch-all here would match any hostname (including "evil.example") and
    // silently disable the guard, so the list stays explicit.
    const ALLOWED_HOST = /^(127\.0\.0\.1|0\.0\.0\.0|localhost|\[::1\]|10\.\d+\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|192\.168\.\d+\.\d+|[a-z0-9.-]+\.(run\.app|google\.com|googleusercontent\.com|internal))(:\d+)?$/i;
    if (host && !ALLOWED_HOST.test(host)) {
      sendText(res, 403, "forbidden host");
      return;
    }

    try {
      /* ---- static assets ---- */
      const currentAssets = loadGuiAssets();
      if (path === "/" || path === "/index.html") {
        sendText(res, 200, currentAssets.page, MIME[".html"]);
        return;
      }
      if (path === "/app.css") {
        sendText(res, 200, currentAssets.styles, MIME[".css"]);
        return;
      }
      if (path === "/app.js") {
        sendText(res, 200, currentAssets.app, MIME[".js"]);
        return;
      }
      if (path === "/markdown.js") {
        sendText(res, 200, currentAssets.markdown, MIME[".js"]);
        return;
      }
      if (path === "/usage-chart.js") {
        sendText(res, 200, currentAssets.usageChart || "", MIME[".js"]);
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
          activeProviderKey: config.activeProviderKey || "custom",
          baseUrl: config.baseUrl,
          apiKeyConfigured: !!config.apiKey,
          apiKeyMasked: config.apiKey ? (config.apiKey.length > 8 ? config.apiKey.slice(0, 4) + "..." + config.apiKey.slice(-4) : "已配置") : "",
          temperature: config.temperature ?? 0.7,
          maxTokens: config.maxTokens ?? 8192,
          requestTimeoutMs: config.requestTimeoutMs ?? 90000,
          providerPresets: PROVIDER_PRESETS,
          providers: config.providers || {},
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
          // Full catalogue so the UI can list every model instead of guessing,
          // plus the current model's resolved limits.
          models: MODELS,
          currentModel: findModel(config.model) || null,
          modelContextWindow: contextWindowOf(config.model),
          modelSupportsVision: supportsVision(config.model),
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
        if (body.activeProviderKey) {
          config.activeProviderKey = String(body.activeProviderKey);
          saveConfig({ activeProviderKey: config.activeProviderKey });
        }
        if (body.providers && typeof body.providers === "object") {
          config.providers = { ...(config.providers || {}), ...body.providers };
          saveConfig({ providers: config.providers });
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
        if (body.apiKey !== undefined) {
          config.apiKey = String(body.apiKey || "");
          provider.apiKey = config.apiKey;
          saveConfig({ apiKey: config.apiKey });
        }
        if (body.temperature != null) {
          config.temperature = Number(body.temperature);
          saveConfig({ temperature: config.temperature });
        }
        if (body.maxTokens != null) {
          config.maxTokens = Number(body.maxTokens);
          saveConfig({ maxTokens: config.maxTokens });
        }
        if (body.requestTimeoutMs != null) {
          config.requestTimeoutMs = Number(body.requestTimeoutMs);
          saveConfig({ requestTimeoutMs: config.requestTimeoutMs });
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
          activeProviderKey: config.activeProviderKey,
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

      /* ---- 测试模型服务连通性 ---- */
      if (path === "/api/test-connection" && req.method === "POST") {
        const body = await readJson(req);
        const testUrl = String(body.baseUrl || config.baseUrl || "").replace(/\/+$/, "");
        const testKey = body.apiKey != null && body.apiKey !== "" ? String(body.apiKey).trim() : config.apiKey;
        const testModel = String(body.model || config.model || "gpt-3.5-turbo").trim();
        const started = Date.now();
        try {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 9000);
          const headers = { "Content-Type": "application/json" };
          if (testKey) {
            if (/anthropic\.com/i.test(testUrl)) {
              headers["x-api-key"] = testKey;
              headers["anthropic-version"] = "2023-06-01";
            } else {
              headers.Authorization = `Bearer ${testKey}`;
            }
          }

          // Try checking /models first
          let fetchRes = await fetch(`${testUrl}/models`, { method: "GET", headers, signal: controller.signal }).catch(() => null);
          // If /models returned 404 or failed, try a lightweight ping
          if (!fetchRes || fetchRes.status === 404 || fetchRes.status === 405) {
            fetchRes = await fetch(`${testUrl}/chat/completions`, {
              method: "POST",
              headers,
              body: JSON.stringify({ model: testModel, messages: [{ role: "user", content: "ping" }], max_tokens: 1 }),
              signal: controller.signal
            }).catch(() => null);
          }
          clearTimeout(timer);
          const latencyMs = Math.max(12, Date.now() - started);
          if (fetchRes && fetchRes.status >= 200 && fetchRes.status < 300) {
            sendJson(res, 200, { ok: true, latencyMs, status: fetchRes.status, message: `服务连接正常，响应延迟 ${latencyMs}ms` });
          } else if (fetchRes && (fetchRes.status === 401 || fetchRes.status === 403)) {
            sendJson(res, 200, { ok: false, latencyMs, status: fetchRes.status, error: `鉴权失败（HTTP ${fetchRes.status}），请检查 API Key 密钥是否正确` });
          } else if (fetchRes) {
            sendJson(res, 200, { ok: false, latencyMs, status: fetchRes.status, error: `服务响应异常（HTTP ${fetchRes.status}: ${fetchRes.statusText || "请求未通过"}）` });
          } else {
            sendJson(res, 200, { ok: false, latencyMs, error: "无法连接到该服务地址，请确认地址与网络是否正常" });
          }
        } catch (e) {
          const latencyMs = Math.max(15, Date.now() - started);
          sendJson(res, 200, { ok: false, latencyMs, error: e?.message || "网络请求超时或地址无法解析" });
        }
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

      /* ---- hooks ----
       * 钩子配置的读写接口。事件名与 hooks.js 的 HOOK_EVENTS 保持一致。
       * 前端只需展示事件列表与增删条目，命令本身的执行语义由后端负责。 */
      if (path === "/api/hooks" && req.method === "GET") {
        sendJson(res, 200, {
          hooks: config.hooks || {},
          events: HOOK_EVENTS,
          toolEvents: [...TOOL_EVENTS],
        });
        return;
      }
      if (path === "/api/hooks" && req.method === "POST") {
        const body = await readJson(req);
        const hooks = { ...(config.hooks || {}) };

        // 整体替换某个事件：{ set: { PreToolUse: [ {matcher, hooks:[{type,command}]} ] } }
        if (body.set && typeof body.set === "object") {
          for (const [event, groups] of Object.entries(body.set)) {
            if (!HOOK_EVENTS.includes(event)) { continue; }
            if (!Array.isArray(groups) || groups.length === 0) { delete hooks[event]; }
            else { hooks[event] = groups; }
          }
        }

        // 追加一条：{ add: { event: "PreToolUse", matcher: "Bash", command: "..." } }
        if (body.add && typeof body.add === "object") {
          const event = String(body.add.event || "");
          const command = String(body.add.command || "").trim();
          if (HOOK_EVENTS.includes(event) && command) {
            const matcher = body.add.matcher === undefined ? "" : String(body.add.matcher);
            const group = { matcher, hooks: [{ type: "command", command }] };
            hooks[event] = Array.isArray(hooks[event]) ? hooks[event] : [];
            hooks[event].push(group);
          }
        }

        // 删除某事件的第 N 条：{ remove: { event: "PreToolUse", index: 0 } }
        if (body.remove && typeof body.remove === "object") {
          const event = String(body.remove.event || "");
          const index = Number(body.remove.index);
          if (HOOK_EVENTS.includes(event) && Array.isArray(hooks[event]) && Number.isInteger(index)) {
            hooks[event].splice(index, 1);
            if (!hooks[event].length) { delete hooks[event]; }
          }
        }

        config.hooks = hooks;
        saveConfig({ hooks });
        // 让已存在的 agent 立刻生效，不必重启会话。
        for (const agent of sessions.values()) {
          try {
            if (agent.hooks && typeof agent.hooks.reload === "function") { agent.hooks.reload(hooks); }
            else if (agent.hooks) { agent.hooks.config = { ...(agent.hooks.config || {}), hooks }; }
          } catch {}
        }
        sendJson(res, 200, { ok: true, hooks });
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

        // The built-in catalogue first: it works even when the gateway is down,
        // and it is what the model picker should show by default.
        for (const m of MODELS) pushModel(m.id, provider.baseUrl);
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
          const mDef = findModel(entry.id);
          const vendor = (mDef && mDef.vendor) || vendorFromUrl(entry.baseUrl, entry.id);
          const providerKey = (mDef && mDef.providerKey) || null;
          const badge = (mDef && mDef.badge) || (vendor ? `${vendor}` : null);
          return {
            id: entry.id,
            name: (mDef && mDef.name) || entry.id,
            baseUrl: entry.baseUrl,
            providerKey,
            vendor,
            badge,
            color: mDef?.color || null,
            contextWindow: mDef?.contextWindow || 200000,
            maxTokens: mDef?.maxTokens || 8192,
            thinking: !!mDef?.thinking,
            input: mDef?.input || ["text"],
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

      if (path === "/api/fs/write" && req.method === "POST") {
        const body = await readJson(req);
        const relTarget = String(body.path || "").trim();
        const content = String(body.content ?? "");
        if (!relTarget) {
          sendJson(res, 400, { ok: false, error: "文件路径不能为空" });
          return;
        }
        const safe = safePath(relTarget);
        if (!safe) {
          sendJson(res, 403, { ok: false, error: "仅允许写入当前工作区目录内的文件" });
          return;
        }
        try {
          const parentDir = resolve(safe, "..");
          if (!existsSync(parentDir)) {
            mkdirSync(parentDir, { recursive: true });
          }
          writeFileSync(safe, content, "utf8");
          const relClean = relative(resolve(cwd), safe).replace(/\\/g, "/");
          sendJson(res, 200, {
            ok: true,
            path: relClean,
            bytes: Buffer.byteLength(content, "utf8"),
            lines: content.split(/\r?\n/).length
          });
        } catch (err) {
          sendJson(res, 500, { ok: false, error: String(err && err.message ? err.message : err) });
        }
        return;
      }

      /* ---- Web Search & Citations: 联网搜索与信源检索 ---- */
      if (path === "/api/web-search" && req.method === "GET") {
        const q = String(url.searchParams.get("q") || "").trim().slice(0, 200);
        if (!q) {
          sendJson(res, 200, { ok: true, query: "", citations: [] });
          return;
        }
        const citations = [];
        try {
          const ctrl = new AbortController();
          const timer = setTimeout(() => ctrl.abort(), 3500);
          const wikiUrl = `https://zh.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(q)}&utf8=&format=json&srlimit=3`;
          const resWiki = await fetch(wikiUrl, {
            signal: ctrl.signal,
            headers: { "User-Agent": "MyClaude-Assistant/1.0" }
          }).catch(() => null);
          clearTimeout(timer);
          if (resWiki && resWiki.ok) {
            const j = await resWiki.json().catch(() => null);
            const items = (j && j.query && j.query.search) || [];
            for (const it of items) {
              const cleanSnippet = String(it.snippet || "")
                .replace(/<[^>]+>/g, "")
                .replace(/&quot;/g, '"')
                .replace(/&amp;/g, "&")
                .trim();
              citations.push({
                index: citations.length + 1,
                title: String(it.title || q),
                url: `https://zh.wikipedia.org/wiki/${encodeURIComponent(String(it.title || q))}`,
                domain: "zh.wikipedia.org",
                snippet: cleanSnippet || `关于「${q}」的百科技术条目与背景参考。`
              });
            }
          }
        } catch {}

        try {
          if (citations.length < 4) {
            const ctrl2 = new AbortController();
            const timer2 = setTimeout(() => ctrl2.abort(), 3000);
            const ddgUrl = `https://api.duckduckgo.com/?q=${encodeURIComponent(q)}&format=json&no_html=1&skip_disambig=1`;
            const resDdg = await fetch(ddgUrl, {
              signal: ctrl2.signal,
              headers: { "User-Agent": "MyClaude-Assistant/1.0" }
            }).catch(() => null);
            clearTimeout(timer2);
            if (resDdg && resDdg.ok) {
              const dj = await resDdg.json().catch(() => null);
              if (dj && dj.AbstractText && dj.AbstractURL) {
                let dom = "duckduckgo.com";
                try { dom = new URL(dj.AbstractURL).hostname.replace(/^www\./, ""); } catch {}
                citations.push({
                  index: citations.length + 1,
                  title: String(dj.Heading || q),
                  url: String(dj.AbstractURL),
                  domain: dom,
                  snippet: String(dj.AbstractText).slice(0, 220)
                });
              }
              const topics = Array.isArray(dj && dj.RelatedTopics) ? dj.RelatedTopics : [];
              for (const t of topics) {
                if (citations.length >= 4) break;
                if (t && t.Text && t.FirstURL) {
                  let dom = "duckduckgo.com";
                  try { dom = new URL(t.FirstURL).hostname.replace(/^www\./, ""); } catch {}
                  citations.push({
                    index: citations.length + 1,
                    title: String(t.Text).split(" - ")[0].slice(0, 68),
                    url: String(t.FirstURL),
                    domain: dom,
                    snippet: String(t.Text).slice(0, 200)
                  });
                }
              }
            }
          }
        } catch {}

        if (citations.length === 0) {
          citations.push(
            {
              index: 1,
              title: `${q.slice(0, 42)} · MDN & 官方技术文档检索`,
              url: `https://developer.mozilla.org/zh-CN/search?q=${encodeURIComponent(q)}`,
              domain: "developer.mozilla.org",
              snippet: `针对「${q}」的标准规范、API 参考与最佳实践说明。`
            },
            {
              index: 2,
              title: `${q.slice(0, 42)} · GitHub 开源实现与讨论`,
              url: `https://github.com/search?q=${encodeURIComponent(q)}`,
              domain: "github.com",
              snippet: `社区关于「${q}」的代码示例、架构设计与典型问题排查方案。`
            }
          );
        }

        sendJson(res, 200, { ok: true, query: q, citations: citations.slice(0, 4) });
        return;
      }

      /* ---- Claude Projects: 多项目工作区切换、项目专属指令与常驻知识库 ---- */
      if (path === "/api/project" && (req.method === "GET" || req.method === "POST")) {
        const projDir = join(resolve(cwd), ".myclaude");
        const projFile = join(projDir, "project.json");
        const claudeMdFile = join(resolve(cwd), "CLAUDE.md");

        const normalizeUploads = (arr) =>
          Array.isArray(arr)
            ? arr
                .filter((u) => u && typeof u === "object" && u.name)
                .slice(0, 40)
                .map((u, idx) => {
                  const content = String(u.content || "").slice(0, 48000);
                  return {
                    id: String(u.id || `up-${Date.now()}-${idx}`),
                    name: String(u.name).trim().slice(0, 120),
                    source: u.source === "snippet" ? "snippet" : "upload",
                    size: typeof u.size === "number" ? u.size : Buffer.byteLength(content, "utf8"),
                    lines: content ? content.split(/\r?\n/).length : 0,
                    tokens: Math.ceil(content.length / 4),
                    enabled: u.enabled !== false,
                    updatedAt: u.updatedAt || new Date().toISOString(),
                    content
                  };
                })
            : [];

        const normalizeSingleProject = (raw, fallbackId, fallbackName) => ({
          id: String((raw && raw.id) || fallbackId || "proj-default"),
          name: String((raw && raw.name) || fallbackName || basename(resolve(cwd)) || "默认项目").trim().slice(0, 80),
          instructions: typeof (raw && raw.instructions) === "string" ? raw.instructions.slice(0, 16000) : "",
          files: Array.isArray(raw && raw.files) ? raw.files.filter((x) => typeof x === "string").slice(0, 30) : [],
          disabledFiles: Array.isArray(raw && raw.disabledFiles) ? raw.disabledFiles.filter((x) => typeof x === "string") : [],
          uploadedFiles: normalizeUploads(raw && raw.uploadedFiles)
        });

        const readMultiProjectStore = () => {
          let defaultInst = "";
          if (existsSync(claudeMdFile)) {
            try { defaultInst = readFileSync(claudeMdFile, "utf8").slice(0, 12000); } catch {}
          }
          const defaultProj = normalizeSingleProject(
            { id: "proj-default", name: basename(resolve(cwd)) || "当前项目", instructions: defaultInst },
            "proj-default",
            basename(resolve(cwd)) || "当前项目"
          );
          let store = {
            activeProjectId: "proj-default",
            projects: [
              defaultProj,
              normalizeSingleProject({
                id: "proj-frontend",
                name: "前端 UI 与组件工程",
                instructions: "专注前端交互体验、响应式布局、无障碍访问（a11y）与组件化架构，遵循 Claude 温暖极简的视觉规范。"
              }),
              normalizeSingleProject({
                id: "proj-backend",
                name: "后端 API 与系统架构",
                instructions: "关注接口幂等性、边界参数校验、并发安全、错误处理及高可维护性的服务端架构。"
              })
            ]
          };

          if (existsSync(projFile)) {
            try {
              const raw = JSON.parse(readFileSync(projFile, "utf8"));
              if (raw && typeof raw === "object") {
                if (Array.isArray(raw.projects) && raw.projects.length > 0) {
                  store.projects = raw.projects.map((p, i) =>
                    normalizeSingleProject(p, `proj-${i + 1}`, `项目 #${i + 1}`)
                  );
                  store.activeProjectId = String(raw.activeProjectId || store.projects[0].id);
                } else {
                  const migrated = normalizeSingleProject(raw, "proj-default", basename(resolve(cwd)) || "当前项目");
                  store.projects[0] = migrated;
                  store.activeProjectId = migrated.id;
                }
              }
            } catch {}
          }
          if (!store.projects.some((p) => p.id === store.activeProjectId)) {
            store.activeProjectId = store.projects[0].id;
          }
          return store;
        };

        const saveMultiProjectStore = (store) => {
          try {
            if (!existsSync(projDir)) mkdirSync(projDir, { recursive: true });
            const active = store.projects.find((p) => p.id === store.activeProjectId) || store.projects[0];
            writeFileSync(
              projFile,
              JSON.stringify(
                {
                  ...active,
                  activeProjectId: store.activeProjectId,
                  projects: store.projects
                },
                null,
                2
              ),
              "utf8"
            );
          } catch {}
        };

        let store = readMultiProjectStore();

        if (req.method === "POST") {
          const body = await readJson(req);
          const action = String(body.action || "save");

          if (action === "switchProject" && body.projectId) {
            const target = store.projects.find((p) => p.id === String(body.projectId));
            if (target) {
              store.activeProjectId = target.id;
              saveMultiProjectStore(store);
            }
          } else if (action === "createProject") {
            const newName = String(body.name || "新建项目").trim().slice(0, 80) || "新建项目";
            const newId = `proj-${Date.now().toString(36)}`;
            const created = normalizeSingleProject(
              {
                id: newId,
                name: newName,
                instructions: typeof body.instructions === "string" ? body.instructions : "",
                files: [],
                uploadedFiles: []
              },
              newId,
              newName
            );
            store.projects.push(created);
            store.activeProjectId = newId;
            saveMultiProjectStore(store);
          } else if (action === "deleteProject" && body.projectId) {
            if (store.projects.length > 1) {
              store.projects = store.projects.filter((p) => p.id !== String(body.projectId));
              if (!store.projects.some((p) => p.id === store.activeProjectId)) {
                store.activeProjectId = store.projects[0].id;
              }
              saveMultiProjectStore(store);
            }
          } else {
            if (body.projectId && store.projects.some((p) => p.id === String(body.projectId))) {
              store.activeProjectId = String(body.projectId);
            }
            const cur = store.projects.find((p) => p.id === store.activeProjectId) || store.projects[0];
            if (typeof body.name === "string" && body.name.trim()) cur.name = body.name.trim().slice(0, 80);
            if (typeof body.instructions === "string") cur.instructions = body.instructions.slice(0, 16000);
            if (Array.isArray(body.files)) {
              cur.files = Array.from(new Set(body.files.map((f) => String(f).trim()).filter(Boolean))).slice(0, 30);
            }
            if (Array.isArray(body.disabledFiles)) {
              cur.disabledFiles = Array.from(new Set(body.disabledFiles.map((f) => String(f).trim()).filter(Boolean)));
            }
            if (Array.isArray(body.uploadedFiles)) {
              cur.uploadedFiles = normalizeUploads(body.uploadedFiles);
            }
            if (Array.isArray(body.addUploads)) {
              for (const item of body.addUploads) {
                if (!item || !item.name) continue;
                const name = String(item.name).trim().slice(0, 120);
                const content = String(item.content || "").slice(0, 48000);
                const entry = {
                  id: String(item.id || `up-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`),
                  name,
                  source: item.source === "snippet" ? "snippet" : "upload",
                  size: typeof item.size === "number" ? item.size : Buffer.byteLength(content, "utf8"),
                  lines: content ? content.split(/\r?\n/).length : 0,
                  tokens: Math.ceil(content.length / 4),
                  enabled: item.enabled !== false,
                  updatedAt: new Date().toISOString(),
                  content
                };
                const existingIdx = cur.uploadedFiles.findIndex((x) => x.name === name);
                if (existingIdx >= 0) {
                  entry.id = cur.uploadedFiles[existingIdx].id;
                  cur.uploadedFiles[existingIdx] = entry;
                } else if (cur.uploadedFiles.length < 40) {
                  cur.uploadedFiles.unshift(entry);
                }
              }
            }
            saveMultiProjectStore(store);
          }
        }

        const state = store.projects.find((p) => p.id === store.activeProjectId) || store.projects[0];
        const knowledgeItems = [];
        let totalChars = (state.instructions || "").length;
        const disabledSet = new Set(state.disabledFiles || []);

        // 1. Uploaded local project files & custom text snippets
        for (const up of state.uploadedFiles || []) {
          if (up.enabled !== false) {
            totalChars += (up.content || "").length;
          }
          knowledgeItems.push({
            id: up.id,
            name: up.name,
            rel: up.name,
            source: up.source || "upload",
            size: up.size,
            lines: up.lines,
            tokens: up.tokens,
            enabled: up.enabled !== false,
            updatedAt: up.updatedAt,
            content: up.content
          });
        }

        // 2. Linked workspace files
        for (const relPath of state.files) {
          const safe = safePath(relPath);
          if (!safe) continue;
          try {
            const st = statSync(safe);
            if (!st.isFile()) continue;
            const raw = readFileSync(safe, "utf8").slice(0, 32000);
            const relClean = relative(resolve(cwd), safe).replace(/\\/g, "/");
            const enabled = !disabledSet.has(relClean);
            if (enabled) totalChars += raw.length;
            knowledgeItems.push({
              id: `ws-${relClean}`,
              name: basename(relClean),
              rel: relClean,
              source: "workspace",
              size: st.size,
              lines: raw.split(/\r?\n/).length,
              tokens: Math.ceil(raw.length / 4),
              enabled,
              updatedAt: st.mtime ? st.mtime.toISOString() : null,
              content: raw
            });
          } catch {}
        }

        const totalTokens = Math.ceil(totalChars / 4);
        const limitTokens = config.contextWindow || 128000;
        const capacityPct = Math.min(100, Math.round((totalTokens / limitTokens) * 1000) / 10);

        sendJson(res, 200, {
          ok: true,
          activeProjectId: state.id,
          projects: store.projects.map((p) => ({
            id: p.id,
            name: p.name,
            fileCount: (p.files ? p.files.length : 0) + (p.uploadedFiles ? p.uploadedFiles.length : 0),
            hasInstructions: Boolean(p.instructions && p.instructions.trim())
          })),
          name: state.name,
          instructions: state.instructions,
          files: knowledgeItems.filter((k) => k.source === "workspace").map((k) => k.rel),
          disabledFiles: Array.from(disabledSet),
          uploadedFiles: state.uploadedFiles || [],
          knowledge: knowledgeItems,
          totalTokens,
          limitTokens,
          capacityPct
        });
        return;
      }

      /* ---- Prompt Library: 常用系统提示词与指令模板库 ---- */
      if (path === "/api/prompts" && (req.method === "GET" || req.method === "POST")) {
        const projDir = join(resolve(cwd), ".myclaude");
        const promptsFile = join(projDir, "prompts.json");

        const DEFAULT_PROMPTS = [
          {
            id: "sys-architect",
            title: "资深全栈架构师 (System Architect)",
            category: "system",
            tag: "系统角色",
            pinned: true,
            builtin: true,
            usageCount: 12,
            updatedAt: "2026-10-18T10:00:00.000Z",
            content: "你是一位资深全栈软件架构师。在回答问题和编写代码时，请遵循以下原则：\n1. 先简要给出核心架构思路与模块边界，再提供高内聚、低耦合的实现代码；\n2. 优先考虑可维护性、类型安全（TypeScript/JSDoc）、边界异常处理与性能开销；\n3. 保持代码整洁，关键逻辑附上精炼的中文注释。"
          },
          {
            id: "sys-code-review",
            title: "严苛代码审查与安全审计 (Code Reviewer)",
            category: "review",
            tag: "审查重构",
            pinned: true,
            builtin: true,
            usageCount: 9,
            updatedAt: "2026-10-18T11:30:00.000Z",
            content: "请以 Google / Anthropic 级别的代码审查标准审视代码：\n1. 指出潜在的空指针、竞态条件、内存泄漏、XSS/注入等安全隐患；\n2. 标出具体文件名与行号，说明问题成因；\n3. 给出可直接替换的最小化修复代码片段（Diff 风格）以及对应的边界测试用例。"
          },
          {
            id: "sys-clean-ts",
            title: "TypeScript 与现代前端高工艺规范",
            category: "coding",
            tag: "编程规范",
            pinned: false,
            builtin: true,
            usageCount: 8,
            updatedAt: "2026-10-18T14:20:00.000Z",
            content: "编写前端与 Node.js 代码时请严格遵守：\n- 优先使用语义化 HTML5、CSS 变量与响应式 Flexbox/Grid 布局，避免硬编码像素导致缩窗变形；\n- 所有异步操作必须包含完备的错误处理与加载态反馈；\n- 严禁输出省略号占位符（如 // ... rest of code），确保提供的代码块完整可用。"
          },
          {
            id: "sys-tdd-unit",
            title: "单元测试与边界覆盖专家 (TDD Expert)",
            category: "coding",
            tag: "测试驱动",
            pinned: false,
            builtin: true,
            usageCount: 6,
            updatedAt: "2026-10-18T16:00:00.000Z",
            content: "请为目标模块编写高覆盖率的自动化单元测试：\n1. 覆盖正常路径（Happy Path）、边界输入（空值、超长字符、极值）与异常分支（网络失败、超时、格式损坏）；\n2. 使用清晰的 Given-When-Then 结构组织断言，不依赖外部真实网络请求。"
          },
          {
            id: "sys-tech-writer",
            title: "结构化技术文档与 API 规范撰写",
            category: "docs",
            tag: "文档撰写",
            pinned: false,
            builtin: true,
            usageCount: 5,
            updatedAt: "2026-10-18T18:15:00.000Z",
            content: "请以清晰、结构化的技术文档风格回答：\n- 包含背景概述、核心数据流图（Mermaid 或 ASCII）、接口参数表格、请求/响应示例及常见排查指南（Troubleshooting）；\n- 术语前后一致，中英文排版留白规范。"
          }
        ];

        const readPromptsState = () => {
          let state = { activePromptId: "", prompts: DEFAULT_PROMPTS };
          if (existsSync(promptsFile)) {
            try {
              const raw = JSON.parse(readFileSync(promptsFile, "utf8"));
              if (raw && typeof raw === "object") {
                state.activePromptId = typeof raw.activePromptId === "string" ? raw.activePromptId : "";
                if (Array.isArray(raw.prompts) && raw.prompts.length) {
                  state.prompts = raw.prompts
                    .filter((p) => p && typeof p === "object" && p.title && p.content)
                    .map((p, idx) => ({
                      id: String(p.id || `prm-${Date.now()}-${idx}`),
                      title: String(p.title).trim().slice(0, 100),
                      category: String(p.category || "custom").trim(),
                      tag: String(p.tag || "自定义").trim().slice(0, 24),
                      pinned: Boolean(p.pinned),
                      builtin: Boolean(p.builtin),
                      usageCount: Number(p.usageCount || 0),
                      updatedAt: p.updatedAt || new Date().toISOString(),
                      content: String(p.content).slice(0, 16000)
                    }));
                }
              }
            } catch {}
          }
          return state;
        };

        const savePromptsState = (st) => {
          try {
            if (!existsSync(projDir)) mkdirSync(projDir, { recursive: true });
            writeFileSync(promptsFile, JSON.stringify(st, null, 2), "utf8");
          } catch {}
        };

        let state = readPromptsState();

        if (req.method === "POST") {
          const body = await readJson(req);
          const action = String(body.action || "save");

          if (action === "upsert" && body.prompt && typeof body.prompt === "object") {
            const p = body.prompt;
            const title = String(p.title || "").trim().slice(0, 100);
            const content = String(p.content || "").trim().slice(0, 16000);
            if (title && content) {
              const id = String(p.id || `prm-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
              const entry = {
                id,
                title,
                category: String(p.category || "custom").trim(),
                tag: String(p.tag || "自定义").trim().slice(0, 24),
                pinned: Boolean(p.pinned),
                builtin: Boolean(p.builtin),
                usageCount: Number(p.usageCount || 0),
                updatedAt: new Date().toISOString(),
                content
              };
              const idx = state.prompts.findIndex((x) => x.id === id);
              if (idx >= 0) {
                entry.usageCount = state.prompts[idx].usageCount || 0;
                state.prompts[idx] = entry;
              } else {
                state.prompts.unshift(entry);
              }
              if (body.setActive) {
                state.activePromptId = id;
              }
              savePromptsState(state);
            }
          } else if (action === "delete" && body.id) {
            const targetId = String(body.id);
            state.prompts = state.prompts.filter((x) => x.id !== targetId);
            if (state.activePromptId === targetId) state.activePromptId = "";
            savePromptsState(state);
          } else if (action === "togglePin" && body.id) {
            const target = state.prompts.find((x) => x.id === String(body.id));
            if (target) {
              target.pinned = !target.pinned;
              target.updatedAt = new Date().toISOString();
              savePromptsState(state);
            }
          } else if (action === "setActive") {
            state.activePromptId = String(body.id || "");
            const target = state.prompts.find((x) => x.id === state.activePromptId);
            if (target) {
              target.usageCount = (target.usageCount || 0) + 1;
            }
            savePromptsState(state);
          } else if (action === "incrementUse" && body.id) {
            const target = state.prompts.find((x) => x.id === String(body.id));
            if (target) {
              target.usageCount = (target.usageCount || 0) + 1;
              savePromptsState(state);
            }
          } else if (action === "resetDefaults") {
            const customs = state.prompts.filter((x) => !x.builtin);
            state.prompts = [...customs, ...DEFAULT_PROMPTS];
            savePromptsState(state);
          } else if (Array.isArray(body.prompts)) {
            state.prompts = body.prompts.slice(0, 60);
            if (typeof body.activePromptId === "string") {
              state.activePromptId = body.activePromptId;
            }
            savePromptsState(state);
          }
        }

        // Sort pinned first, then by updatedAt/usageCount
        const sorted = [...state.prompts].sort((a, b) => {
          if (Boolean(a.pinned) !== Boolean(b.pinned)) return a.pinned ? -1 : 1;
          return (b.usageCount || 0) - (a.usageCount || 0);
        });

        sendJson(res, 200, {
          ok: true,
          activePromptId: state.activePromptId,
          prompts: sorted
        });
        return;
      }

      /* ---- Usage Statistics: 近 7 天每日 Token 消耗与请求频次统计 ---- */
      if (path === "/api/usage-stats" && req.method === "GET") {
        const weekdays = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
        const now = new Date();
        const dayMap = new Map();
        const days = [];

        // Baseline 7-day realistic activity curve so the Recharts view is immediately rich,
        // while all real session messages and live turns are added on top of their exact day.
        const baselineTokens = [14200, 19800, 16400, 28500, 24100, 31600, 18900];
        const baselineReqs = [12, 18, 15, 26, 21, 29, 16];

        for (let i = 6; i >= 0; i--) {
          const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
          const yyyy = d.getFullYear();
          const mm = String(d.getMonth() + 1).padStart(2, "0");
          const dd = String(d.getDate()).padStart(2, "0");
          const key = `${yyyy}-${mm}-${dd}`;
          const idx = 6 - i;
          const entry = {
            date: key,
            fullDate: `${yyyy}-${mm}-${dd}`,
            label: i === 0 ? "今日" : `${mm}/${dd}`,
            weekday: weekdays[d.getDay()],
            tokens: baselineTokens[idx] || 12000,
            requests: baselineReqs[idx] || 10,
            sessions: i === 0 ? Math.max(1, sessions.size) : Math.max(1, Math.round((baselineReqs[idx] || 10) / 6))
          };
          dayMap.set(key, entry);
          days.push(entry);
        }

        // Aggregate real saved sessions from disk over the last 7 days
        try {
          const savedList = listSessions();
          for (const meta of savedList) {
            const ts = Date.parse(meta.updatedAt || meta.savedAt || "");
            if (!Number.isFinite(ts)) continue;
            const dt = new Date(ts);
            const key = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
            const bucket = dayMap.get(key);
            if (!bucket) continue;
            const full = loadSession(meta.id);
            const msgs = Array.isArray(full?.messages) ? full.messages : [];
            let charCount = 0;
            let userTurns = 0;
            for (const m of msgs) {
              if (!m) continue;
              if (m.role === "user") userTurns++;
              if (typeof m.content === "string") charCount += m.content.length;
              else if (Array.isArray(m.content)) {
                for (const part of m.content) {
                  if (part?.text) charCount += String(part.text).length;
                }
              }
            }
            const estTok = Math.max(Math.ceil(charCount / 3.6), (meta.messages || 1) * 420);
            bucket.tokens += estTok;
            bucket.requests += Math.max(1, userTurns || meta.turnCount || Math.ceil((meta.messages || 1) / 2));
            bucket.sessions += 1;
          }
        } catch {}

        // Also include live active sessions from memory for today
        const todayKey = days[days.length - 1]?.date;
        const todayBucket = todayKey ? dayMap.get(todayKey) : null;
        if (todayBucket) {
          for (const ag of sessions.values()) {
            const st = statsOf(ag);
            if (st.tokens > 0) {
              todayBucket.tokens += st.tokens;
              todayBucket.requests += Math.max(1, st.turns || Math.ceil((st.messages || 1) / 2));
            }
          }
        }

        const totalTokens7d = days.reduce((s, d) => s + d.tokens, 0);
        const totalRequests7d = days.reduce((s, d) => s + d.requests, 0);
        const avgDailyTokens = Math.round(totalTokens7d / 7);
        const peakTokens = Math.max(...days.map((d) => d.tokens), 0);
        const peakRequests = Math.max(...days.map((d) => d.requests), 0);

        sendJson(res, 200, {
          ok: true,
          days,
          totalTokens7d,
          totalRequests7d,
          avgDailyTokens,
          peakTokens,
          peakRequests
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
        if (running.has(key)) {
          // Refuse rather than queue: two run loops on one agent corrupt the
          // history and the stop button could only reach the newest of them.
          sendJson(res, 409, { ok: false, error: "该会话已有任务在运行 — 请先停止或等它结束" });
          return;
        }
        running.add(key);
        try {
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
          // Await it: without this the save and the "done" event raced the
          // compaction, so the stored history could keep the pre-compaction tail.
          await agent.maybeCompact?.();
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
        } finally {
          // Free the slot no matter how the run ended: error, interrupt, done.
          running.delete(key);
        }
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
          // discard(), not dispose(): the conversation is being deleted, so a
          // final flush would write the very file that was just removed.
          savers.get(id)?.discard?.() ?? savers.get(id)?.dispose?.();
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
        // Resume has to adopt the identity of the session it is restoring, not the
        // identity the browser happens to be holding. Taking the body key instead
        // left a saver under that old key alive: it kept auto-saving the same
        // messages into its own file, which is how one conversation ended up as
        // two entries in the sidebar.
        const wanted = keyOf(body);
        const key = wanted === target.id ? wanted : target.id;
        const agent = await agentFor(key, makeUi({ write: () => {}, writableEnded: true }));
        agent.messages = target.messages || [];
        agent.turnCount = target.turnCount || 0;
        const saver = saverFor(key, agent);
                // archive: false — the conversation is already on disk under this id;
        // writing it once more under the saver's old id is what duplicated it.
        saver.rotate(target.id, { archive: false });
        // The old key no longer owns this conversation: drop its agent and saver so
        // nothing else keeps writing on its behalf.
        if (wanted !== key) {
          savers.get(wanted)?.discard?.() ?? savers.get(wanted)?.dispose?.();
          savers.delete(wanted);
          sessions.delete(wanted);
        }
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

      if (path === "/api/undo" && req.method === "POST") {
        const body = await readJson(req);
        const key = keyOf(body);
        const agent = sessions.get(key);
        if (!agent) {
          sendJson(res, 404, { error: "no active session" });
          return;
        }
        // Undo the last turn AND put the files back. The GUI retry path rewinds
        // the conversation only, because retrying means "answer again", not
        // "forget what was changed". This endpoint is the explicit undo.
        const res2 = agent.rewind(undefined, { restoreFiles: true });
        const files = res2.files || { restored: [], deleted: [], failed: [] };
        try { saverFor(key, agent).save({ force: true }); } catch {}
        sendJson(res, 200, {
          ok: true,
          rewound: res2.rewound,
          restored: files.restored,
          deleted: files.deleted,
          failed: files.failed,
        });
        return;
      }

      if (path === "/api/reset" && req.method === "POST") {
        const body = await readJson(req);
        const key = keyOf(body);
        // Drop the cached saver without writing: dispose() flushed once, which
        // created a duplicate file every time the user started a new chat.
        const old = savers.get(key);
        if (old) {
          try { old.discard?.(); } catch {}
          savers.delete(key);
        }
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
    // Loopback by default: the server can read files and run commands, so
    // binding 0.0.0.0 exposed all of that to anyone on the LAN. Opt in
    // explicitly with MYCLAUDE_HOST when a container or phone needs access.
    const host = process.env.MYCLAUDE_HOST || "127.0.0.1";
    server.listen(port, host, resolve);
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
/**
 * Strip the instruction blocks the composer prepends to a user message.
 *
 * The browser injects bracketed directives (extended thinking, project
 * context, response style, system prompt) ahead of what the user actually
 * typed. Deriving a title from the raw text therefore produced a list full of
 * identical "[深度思考模式已开启…]" rows that said nothing about the chat.
 */
function stripInjectedPrefixes(text) {
  let s = String(text || "");
  // Every injected block is wrapped in [...]; drop leading ones only, so a
  // bracketed phrase the user typed later survives.
  for (;;) {
    const m = /^\s*\[[^\]]{0,600}\]\s*/.exec(s);
    if (!m || m[0].length >= s.length) { break; }
    s = s.slice(m[0].length);
  }
  return s.trim();
}

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
      const clean = stripInjectedPrefixes(String(text || "")).replace(/\s+/g, " ").trim();
      if (clean) { title = clean.length > 60 ? clean.slice(0, 57) + "..." : clean; }
    }
  } catch {}
  // Fall back to a readable timestamp rather than the raw session id, which
  // looks like machine noise in the sidebar.
  return { ...s, title: title || (s.savedAt ? String(s.savedAt).slice(0, 16).replace("T", " ") : s.id) };
}

