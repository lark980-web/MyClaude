/**
 * Attachments (images and text files) for vision-capable models.
 *
 * An attachment is a plain object:
 *   { kind: "image", name, path, mime, size, data }   // data = base64 (no prefix)
 *   { kind: "text",  name, path, mime, size, text }
 *
 * `buildUserContent` turns them into the OpenAI multi-part message format:
 *   [{ type: "text", text }, { type: "image_url", image_url: { url: "data:..." } }]
 * When there are no attachments it returns a plain string so providers that only
 * accept string content keep working.
 */
import { readFile, stat } from "node:fs/promises";
import { basename, extname } from "node:path";

export const IMAGE_MIME = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
};

const TEXT_EXT = new Set([
  ".md", ".markdown", ".txt", ".log", ".json", ".jsonl", ".yaml", ".yml", ".toml",
  ".ini", ".cfg", ".csv", ".tsv", ".xml", ".html", ".htm", ".css", ".scss",
  ".js", ".mjs", ".cjs", ".jsx", ".ts", ".tsx", ".py", ".rb", ".go", ".rs",
  ".java", ".kt", ".c", ".h", ".cpp", ".hpp", ".cs", ".php", ".sh", ".ps1",
  ".sql", ".env", ".gitignore", ".dockerfile",
]);

const DEFAULT_MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const DEFAULT_MAX_TEXT_BYTES = 200 * 1024;

export function extOf(filePath) {
  return extname(String(filePath || "")).toLowerCase();
}

export function mimeFromPath(filePath) {
  const ext = extOf(filePath);
  if (IMAGE_MIME[ext]) return IMAGE_MIME[ext];
  if (ext === ".pdf") return "application/pdf";
  if (TEXT_EXT.has(ext)) return "text/plain";
  return "application/octet-stream";
}

export function isImagePath(filePath) {
  return !!IMAGE_MIME[extOf(filePath)];
}

export function isTextPath(filePath) {
  return TEXT_EXT.has(extOf(filePath));
}

export function dataUrl(attachment) {
  return `data:${attachment.mime};base64,${attachment.data}`;
}

/**
 * Read a file from disk into an attachment descriptor.
 * Throws on missing files, oversized images, or unsupported binary content.
 */
export async function attachmentFromPath(filePath, opts = {}) {
  const maxImageBytes = opts.maxImageBytes ?? DEFAULT_MAX_IMAGE_BYTES;
  const maxTextBytes = opts.maxTextBytes ?? DEFAULT_MAX_TEXT_BYTES;
  const name = opts.name || basename(filePath);

  const st = await stat(filePath);
  if (st.isDirectory()) {
    const e = new Error(`EISDIR: ${filePath} is a directory`);
    e.code = "EISDIR";
    throw e;
  }

  const mime = mimeFromPath(filePath);
  if (mime.startsWith("image/")) {
    if (st.size > maxImageBytes) {
      const e = new Error(`image too large: ${st.size} bytes (max ${maxImageBytes})`);
      e.code = "E_TOO_LARGE";
      throw e;
    }
    const buf = await readFile(filePath);
    return { kind: "image", name, path: filePath, mime, size: st.size, data: buf.toString("base64") };
  }

  if (mime === "text/plain") {
    if (st.size > maxTextBytes) {
      const e = new Error(`text file too large: ${st.size} bytes (max ${maxTextBytes})`);
      e.code = "E_TOO_LARGE";
      throw e;
    }
    const text = await readFile(filePath, "utf8");
    return { kind: "text", name, path: filePath, mime, size: st.size, text };
  }

  // PDFs and other binaries: keep the reference so the agent can Read it itself.
  return { kind: "file", name, path: filePath, mime, size: st.size };
}

/**
 * Accepts a mix of paths, {path} objects and already-built attachments and
 * returns normalized attachment descriptors. Invalid entries become
 * { kind: "error", name, error } so a single bad file does not abort a turn.
 */
export async function resolveAttachments(list, opts = {}) {
  if (!Array.isArray(list) || !list.length) return [];
  const out = [];
  for (const item of list) {
    if (!item) continue;
    if (typeof item === "string") {
      out.push(await safeFromPath(item, opts));
      continue;
    }
    if (item.kind && (item.data || item.text || item.kind === "file")) {
      out.push(item);
      continue;
    }
    if (item.path) {
      out.push(await safeFromPath(item.path, { ...opts, name: item.name }));
      continue;
    }
    if (item.data && item.mime) {
      out.push({ kind: item.mime.startsWith("image/") ? "image" : "text", name: item.name || "attachment", mime: item.mime, size: item.size ?? 0, data: item.data, text: item.text });
    }
  }
  return out;
}

async function safeFromPath(filePath, opts) {
  try {
    return await attachmentFromPath(filePath, opts);
  } catch (e) {
    return { kind: "error", name: basename(String(filePath)), path: String(filePath), error: e.message };
  }
}

/** Human-readable one-liner used by CLI/UI listings. */
export function describeAttachment(a) {
  if (!a) return "";
  if (a.kind === "error") return `${a.name} (error: ${a.error})`;
  const kb = Math.max(1, Math.round((a.size || 0) / 1024));
  return `${a.name} (${a.kind}, ${kb}KB)`;
}

function textPartFor(a) {
  return {
    type: "text",
    text: `[attached file: ${a.name}]\n${a.text ?? ""}`,
  };
}

function noteFor(a, vision) {
  if (a.kind === "image") {
    return vision
      ? `[image ${a.name}]`
      : `[image ${a.name} — skipped: vision disabled]`;
  }
  if (a.kind === "error") return `[attachment ${a.name} failed: ${a.error}]`;
  if (a.kind === "file") return `[file ${a.name} (${a.mime}) at ${a.path} — use Read to inspect]`;
  return `[attachment ${a.name}]`;
}

/**
 * Build the `content` value for a user message.
 * @returns {string | Array<object>}
 */
export function buildUserContent(text, attachments = [], { vision = true } = {}) {
  const list = (attachments || []).filter(Boolean);
  const body = String(text ?? "");
  if (!list.length) return body;

  const parts = [];
  if (body.trim()) parts.push({ type: "text", text: body });

  const notes = [];
  for (const a of list) {
    if (a.kind === "image" && vision && a.data) {
      parts.push({ type: "image_url", image_url: { url: dataUrl(a) } });
    } else if (a.kind === "text" && typeof a.text === "string") {
      parts.push(textPartFor(a));
    } else {
      notes.push(noteFor(a, vision));
    }
  }
  if (notes.length) parts.push({ type: "text", text: notes.join("\n") });
  if (!parts.length) parts.push({ type: "text", text: "(attachment only)" });
  return parts;
}

/**
 * Images returned by tools (e.g. Read on a .png) must not go into the `tool`
 * role message — OpenAI only accepts a string there. They are sent as a
 * follow-up user message instead.
 */
export function buildToolAttachmentContent(attachments = [], { vision = true } = {}) {
  const images = (attachments || []).filter((a) => a?.kind === "image" && a.data);
  if (!images.length) return null;
  if (!vision) {
    return `[tool returned ${images.length} image(s), skipped: vision disabled]`;
  }
  return [
    { type: "text", text: `[${images.length} image(s) returned by tools]` },
    ...images.map((a) => ({ type: "image_url", image_url: { url: dataUrl(a) } })),
  ];
}
