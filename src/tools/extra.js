import { readFile, writeFile, stat } from "node:fs/promises";

const MAX_OUTPUT = 30000;

function ok(content) {
  return { ok: true, content };
}
function err(content) {
  return { ok: false, content };
}
function truncate(text, limit = MAX_OUTPUT) {
  return text.length <= limit ? text : `${text.slice(0, limit)}\n...[truncated ${text.length - limit} chars]`;
}

const todoStore = new Map();

export const todoWriteTool = {
  name: "TodoWrite",
  description:
    "Create or update the task list. Send the complete list every time; it replaces the previous state.",
  input_schema: {
    type: "object",
    properties: {
      todos: {
        type: "array",
        items: {
          type: "object",
          properties: {
            content: { type: "string", description: "Imperative description of the task" },
            status: { type: "string", enum: ["pending", "in_progress", "completed", "cancelled"] },
            priority: { type: "string", enum: ["high", "medium", "low"] },
          },
          required: ["content", "status"],
        },
      },
    },
    required: ["todos"],
  },
  async run({ todos }, ctx = {}) {
    if (!Array.isArray(todos)) return err("todos must be an array");
    const key = ctx.sessionKey || "default";
    const normalized = todos.map((t, i) => ({
      id: i + 1,
      content: String(t.content ?? ""),
      status: ["pending", "in_progress", "completed", "cancelled"].includes(t.status) ? t.status : "pending",
      priority: ["high", "medium", "low"].includes(t.priority) ? t.priority : undefined,
    }));
    todoStore.set(key, normalized);

    const icon = { pending: "☐", in_progress: "▶", completed: "☑", cancelled: "✗" };
    const counts = normalized.reduce((acc, t) => ((acc[t.status] = (acc[t.status] || 0) + 1), acc), {});
    const lines = normalized.map((t) => `${icon[t.status]} ${t.content}${t.priority ? ` [${t.priority}]` : ""}`);
    const summary = Object.entries(counts)
      .map(([k, v]) => `${v} ${k}`)
      .join(", ");
    return ok(`${summary || "no todos"}\n${lines.join("\n")}`);
  },
};

export function setTodos(sessionKey = "default", todos = []) {
  if (Array.isArray(todos) && todos.length) { todoStore.set(sessionKey, todos); }
  else { todoStore.delete(sessionKey); }
}

export function getTodos(sessionKey = "default") {
  return todoStore.get(sessionKey) || [];
}

export function clearTodos(sessionKey = "default") {
  todoStore.delete(sessionKey);
}

function htmlToText(html) {
  let s = html;
  s = s.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ");
  s = s.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ");
  s = s.replace(/<!--[\s\S]*?-->/g, " ");
  s = s.replace(/<\/(p|div|section|article|li|h[1-6]|tr|br)>/gi, "\n");
  s = s.replace(/<br\s*\/?>/gi, "\n");
  s = s.replace(/<[^>]+>/g, "");
  s = s
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&ldquo;|&rdquo;/g, '"')
    .replace(/&mdash;/g, "—")
    .replace(/&ndash;/g, "–");
  s = s.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").replace(/[ \t]{2,}/g, " ");
  return s.trim();
}

export const webFetchTool = {
  name: "WebFetch",
  description:
    "Fetch an http(s) URL and return its text content. HTML is reduced to readable text. Use for documentation and pages.",
  input_schema: {
    type: "object",
    properties: {
      url: { type: "string", description: "Absolute http(s) URL" },
      max_chars: { type: "number", description: "Maximum characters to return (default 20000)" },
    },
    required: ["url"],
  },
  async run({ url, max_chars = 20000 }) {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      return err(`invalid URL: ${url}`);
    }
    if (!["http:", "https:"].includes(parsed.protocol)) {
      return err(`unsupported protocol: ${parsed.protocol} (only http/https)`);
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30000);
    try {
      const res = await fetch(parsed, {
        signal: controller.signal,
        redirect: "follow",
        headers: { "User-Agent": "MyClaude/0.1 (+https://localhost)", Accept: "text/html,text/plain,*/*" },
      });
      const contentType = res.headers.get("content-type") || "";
      const raw = await res.text();
      const isHtml = contentType.includes("html") || /^\s*<(!doctype|html)/i.test(raw.slice(0, 200));
      const text = isHtml ? htmlToText(raw) : raw;
      const body = text.slice(0, max_chars);
      const note = text.length > max_chars ? `\n...[truncated ${text.length - max_chars} chars]` : "";
      return ok(`HTTP ${res.status} ${contentType}\n${res.url}\n\n${body}${note}`);
    } catch (e) {
      if (e.name === "AbortError") return err("request timed out after 30s");
      return err(`fetch failed: ${e.message}`);
    } finally {
      clearTimeout(timer);
    }
  },
};

export function truncateOutput(text, limit = MAX_OUTPUT) {
  return truncate(text, limit);
}
