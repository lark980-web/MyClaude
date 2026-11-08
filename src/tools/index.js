import { readFile, writeFile, mkdir, readdir, stat, access } from "node:fs/promises";
import { exec, spawn, spawnSync } from "node:child_process";
import { basename, dirname, extname, resolve, join, relative, isAbsolute } from "node:path";
import { constants, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { startBackground, killTask, readTaskOutput, waitTask, taskSummaries, adoptProcess,
} from "./tasks.js";
import { todoWriteTool, webFetchTool } from "./extra.js";
import { upstreamSchema, upstreamDescription } from "./upstream-schemas.js";
import { GIT_TOOLS } from "./git.js";
import { tmpdir } from "node:os";


const require = createRequire(import.meta.url);

const MAX_READ_BYTES = 1024 * 1024;
const MAX_OUTPUT = 30000;

function ok(content) {
  return { ok: true, content };
}
function err(content) {
  return { ok: false, content };
}

function truncate(text, limit = MAX_OUTPUT) {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n\n...[truncated ${text.length - limit} chars]`;
}

/* ------------------------------------------------------- 子进程输出解码 */

/**
 * TextDecoder labels for the Windows console code pages cmd.exe reports.
 *
 * Node ships full ICU, so gbk/big5/shift_jis all resolve; an exotic page this
 * Node cannot decode falls back to the UTF-8 path below.
 */
const WINDOWS_CODEPAGE_ENCODINGS = {
  65001: "utf-8",
  936: "gbk",
  54936: "gb18030",
  950: "big5",
  932: "shift_jis",
  949: "euc-kr",
  1252: "windows-1252",
};

/** Create a streaming decoder for one of the labels above, or null. */
function makeDecoder(label) {
  try {
    const d = new TextDecoder(label, { fatal: false, ignoreBOM: true });
    return { decode: (buf, opts) => d.decode(buf, opts), label };
  } catch {
    return null;
  }
}

function utf8Decoder() {
  return makeDecoder("utf-8") || { decode: (buf) => String(buf), label: "utf-8" };
}

/** Count U+FFFD: a non-zero count means the bytes were not in that encoding. */
function replacementCount(text) {
  let n = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === REPLACEMENT_CHAR) n++;
  }
  return n;
}

/**
 * The code page a Windows console writes its output in.
 *
 * A Chinese Windows console defaults to 936 (GBK), so cmd.exe reports
 * "'ls' 不是内部或外部命令" as cp936 bytes. Decoding those as UTF-8 put 485
 * U+FFFD into a session's history; the mangled text was then re-sent to the
 * model, which could not read it and repeated the same wrong command.
 * chcp is asked once per process; a non-Windows platform never gets here.
 */
let consoleEncodingCache;
function consoleEncoding() {
  if (consoleEncodingCache !== undefined) return consoleEncodingCache;
  consoleEncodingCache = null;
  if (process.platform === "win32") {
    try {
      const probe = spawnSync("chcp", [], { encoding: "utf8", timeout: 5000, windowsHide: true });
      const m = /(\d{3,5})/.exec(String(probe.stdout || ""));
      const label = m ? WINDOWS_CODEPAGE_ENCODINGS[Number(m[1])] : null;
      if (label) consoleEncodingCache = label;
    } catch {
      // No chcp (or it is unavailable): stay on the UTF-8 path.
    }
  }
  return consoleEncodingCache;
}

/** A decoder state for one command's stdout or stderr. */
function outputDecoder() {
  const preferred = consoleEncoding();
  return {
    // The console code page, when it differs from UTF-8.
    primary: preferred && preferred !== "utf-8" ? makeDecoder(preferred) : null,
    utf8: utf8Decoder(),
    label: preferred || "utf-8",
    /** Bytes held back: a multi-byte character split across two chunks. */
    pending: Buffer.alloc(0),
    /** Set once a chunk decoded cleanly: the encoding cannot change mid-stream. */
    chosen: null,
  };
}

/** True when the bytes are a valid UTF-8 sequence (ASCII included). */
function isValidUtf8Chunk(buf) {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(buf);
    return true;
  } catch {
    return false;
  }
}

/** True when one byte can start a UTF-8 multi-byte sequence. */
function utf8LeadByte(byte) {
  return (byte >= 0xC2 && byte <= 0xDF) || (byte >= 0xE0 && byte <= 0xEF) || (byte >= 0xF0 && byte <= 0xF4);
}

/** True when every byte of a chunk is at least 0x80 (a run of non-ASCII). */
function looksLikeMultibyteText(buf) {
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] < 0x80) return false;
  }
  return buf.length > 0;
}

/**
 * Decode bytes whose character boundaries are still unknown.
 *
 * A multi-byte character can be split across two reads, so up to three bytes
 * are held back until the next chunk (or EOF) completes the sequence.
 */
function decodeChunk(decoder, chunk) {
  if (!decoder.primary) return decoder.utf8.decode(chunk, { stream: true });
  const buf = decoder.pending.length ? Buffer.concat([decoder.pending, chunk]) : chunk;
  decoder.pending = Buffer.alloc(0);

  if (decoder.chosen) {
    const d = decoder.chosen === "utf-8" ? decoder.utf8 : decoder.primary;
    return d.decode(buf, { stream: true });
  }

  // A complete UTF-8 sequence cannot be produced by GBK text that contains
  // non-ASCII bytes, so valid UTF-8 wins; ASCII alone decodes the same either way.
  if (isValidUtf8Chunk(buf)) {
    decoder.chosen = "utf-8";
    return decoder.utf8.decode(buf, { stream: true });
  }

  // The tail may be an incomplete character. Hold it back and decide on the
  // part that is complete rather than committing to an encoding on half a
  // character.
  const lead = buf[buf.length - 1];
  const tailLen = buf.length >= 2 && utf8LeadByte(buf[buf.length - 2]) && (lead & 0xC0) === 0x80 ? 2 : 1;
  const head = buf.subarray(0, buf.length - tailLen);
  const tail = buf.subarray(buf.length - tailLen);

  if (head.length && isValidUtf8Chunk(head)) {
    // A lead byte followed by three continuation bytes, where those four bytes
    // are a valid UTF-8 character but a run of non-ASCII bytes in GBK: the byte
    // before the lead byte still decides what the rest of the stream is.
    const cjk = head.length >= 4 &&
      utf8LeadByte(head[head.length - 4]) &&
      (head[head.length - 3] & 0xC0) === 0x80 &&
      (head[head.length - 2] & 0xC0) === 0x80 &&
      (head[head.length - 1] & 0xC0) === 0x80 &&
      looksLikeMultibyteText(tail);
    if (!cjk) {
      decoder.chosen = "utf-8";
      return decoder.utf8.decode(buf, { stream: true });
    }
  }

  decoder.chosen = decoder.label;
  return decoder.primary.decode(buf, { stream: true });
}

/** Decode a whole buffer, or pass an already-decoded string through. */
function decodeWholeOutput(decoder, value) {
  if (typeof value === "string") {
    // A string means the caller already assembled the text; just flush.
    if (decoder.pending && decoder.pending.length) decoder.pending = Buffer.alloc(0);
    return value;
  }
  const parts = [];
  if (value && value.length) parts.push(decodeChunk(decoder, value));
  if (decoder.pending && decoder.pending.length) {
    const d = decoder.chosen === "utf-8" || !decoder.primary ? decoder.utf8 : decoder.primary;
    parts.push(d.decode(decoder.pending));
    decoder.pending = Buffer.alloc(0);
  } else {
    const d = decoder.chosen === "utf-8" || !decoder.primary ? decoder.utf8 : decoder.primary;
    if (d) parts.push(d.decode());
  }
  return parts.join("");
}

/** Append a decoded chunk, keeping the pre-existing 10MB cap. */
function appendDecoded(current, decoder, chunk) {
  if (current.length >= 10 * 1024 * 1024) return current;
  return current + decodeChunk(decoder, chunk);
}

/* ------------------------------------------------------- 工具参数守卫 */

/**
 * Thrown when a tool call's arguments cannot be used as sent.
 *
 * It is deliberately not a TypeError: the message is what the model reads
 * back, so it has to name the field that is wrong instead of a Node internal
 * ("The \"path\" argument must be of type string... Received undefined").
 */
export class ToolArgumentError extends Error {
  constructor(message, detail) {
    super(message);
    this.name = "ToolArgumentError";
    this.detail = detail || null;
  }
}

/** A short, single-line preview of raw model output, for an error message. */
function previewRaw(text, max = 240) {
  const oneLine = String(text == null ? "" : text).replace(/\s+/g, " ").trim();
  if (oneLine.length <= max) return oneLine;
  return oneLine.slice(0, max) + "... (+" + (oneLine.length - max) + " chars)";
}

/**
 * Required fields that the partial text never carried.
 *
 * When the JSON is broken the fields it lost are exactly what the model has to
 * resend, so the error names them. Only keys that appear in the text are read,
 * which keeps this a report of what arrived rather than a guess at it.
 */
function missingKeysInRawText(raw, schema) {
  const required = schema && Array.isArray(schema.required) ? schema.required : [];
  if (!raw || !required.length) return [];
  const present = new Set();
  const re = /"([^"\\]+)"\s*:/g;
  let m;
  while ((m = re.exec(raw)) !== null) present.add(m[1]);
  return required.filter((k) => !present.has(k));
}

/** The error text for arguments whose JSON could not be parsed at all. */
function parseErrorText(toolName, raw, problem, schema) {
  const detail = problem ? "（" + problem + "）" : "";
  const missing = missingKeysInRawText(raw, schema);
  const missingText = missing.length ? "缺少必填参数 " + missing.map((k) => "'" + k + "'").join(", ") + "。" : "";
  return toolName + ": 工具参数不是合法 JSON" + detail + "，已按原文尝试修复，仍然失败。\n" +
    missingText +
    "收到的参数（截断显示）：" + previewRaw(raw) + "\n" +
    "请重新调用该工具，并输出完整的、符合 schema 的 JSON 参数。";
}

/**
 * Tool-call arguments that carry a raw JSON string under \`raw\`.
 *
 * The provider puts model output that failed to parse under \`raw\`; the same
 * key is what a well-behaved caller would never send as a string. A string
 * there that does not parse means the argument JSON was invalid or truncated,
 * which is the case this guard exists for.
 */
function rawLooksUnparsable(args) {
  const raw = args && args.raw;
  if (typeof raw !== "string" || !raw.trim()) return null;
  const trimmed = raw.trim();
  if (trimmed[0] !== "{" && trimmed[0] !== "[") return null;
  try {
    JSON.parse(trimmed);
    return null;
  } catch {
    return raw;
  }
}

function typeOfValue(value) {
  if (Array.isArray(value)) return "array";
  if (value === null) return "null";
  if (typeof value === "number" && !Number.isFinite(value)) return "non-finite number";
  if (typeof value === "object") return "object";
  return typeof value;
}

function matchesType(value, type) {
  switch (type) {
    case "string": return typeof value === "string";
    case "number": return typeof value === "number" && Number.isFinite(value);
    case "integer": return typeof value === "number" && Number.isInteger(value);
    case "boolean": return typeof value === "boolean";
    case "array": return Array.isArray(value);
    case "object": return !!value && typeof value === "object" && !Array.isArray(value);
    case "null": return value === null;
    default: return true;
  }
}

/** Field-level errors for one schema node, or null when it matches. */
function mismatchAgainstSubschema(value, fieldPath, schema) {
  if (!schema || typeof schema !== "object") return null;
  const label = fieldPath || "参数";
  const type = schema.type;
  const allowed = schema.enum;
  const items = schema.items;
  const minItems = schema.minItems;
  if (typeof type === "string" && !matchesType(value, type)) {
    return label + " 类型错误：schema 要求 " + type + "，实际是 " + typeOfValue(value);
  }
  if (Array.isArray(allowed) && allowed.length && !allowed.includes(value)) {
    return label + " 取值非法：只接受 " + allowed.map((x) => JSON.stringify(x)).join("/") +
      "，实际是 " + JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    if (typeof minItems === "number" && value.length < minItems) {
      return label + " 至少要有 " + minItems + " 项，实际 " + value.length + " 项";
    }
    if (items && typeof items === "object") {
      for (let i = 0; i < value.length; i++) {
        const bad = mismatchAgainstSubschema(value[i], label + "[" + i + "]", items);
        if (bad) return bad;
      }
    }
  }
  return null;
}

/**
 * Validate the arguments a tool is about to run with.
 *
 * Only the parts of JSON Schema the tool contracts actually use are checked —
 * required, type, enum, array items — plus a hard failure for a missing
 * required field. Range keywords such as minimum are deliberately ignored so
 * this guard cannot change behaviour that predates it.
 *
 * @returns {string|null} a readable error, or null when the call may proceed
 */
export function validateToolArguments(toolName, args, schema) {
  if (args === null || typeof args !== "object" || Array.isArray(args)) {
    return toolName + ": 参数必须是一个 JSON 对象（object），实际是 " + typeOfValue(args) + "。";
  }

  const rawProblem = rawLooksUnparsable(args);
  if (rawProblem) return parseErrorText(toolName, rawProblem, "JSON.parse 失败，生成可能被截断", schema);

  if (args.__parseError) {
    return parseErrorText(toolName, args.__raw || args.raw || "", "JSON.parse 失败，生成可能被截断", schema);
  }

  if (!schema || typeof schema !== "object") return null;
  // oneOf / anyOf: the call is valid when it satisfies any one branch.
  for (const key of ["oneOf", "anyOf"]) {
    const branches = schema[key];
    if (Array.isArray(branches) && branches.length) {
      const problems = [];
      for (const branch of branches) {
        const problem = validateToolArguments(toolName, args, branch);
        if (!problem) return null;
        problems.push(problem);
      }
      return toolName + ": 参数不满足 schema 的任何一个分支：" + previewRaw(problems.join(" / "), 300);
    }
  }

  const required = Array.isArray(schema.required) ? schema.required : [];
  const missing = required.filter((k) => args[k] === undefined || args[k] === null);
  if (missing.length) {
    return toolName + ": 缺少必填参数 " + missing.map((k) => "'" + k + "'").join(", ") +
      "。收到的参数是 " + previewRaw(JSON.stringify(args)) +
      "。请按工具 schema 重新调用（缺字段的调用不会被执行）。";
  }

  const properties = schema.properties && typeof schema.properties === "object" ? schema.properties : {};
  for (const field of Object.keys(properties)) {
    if (args[field] === undefined) continue;
    const bad = mismatchAgainstSubschema(args[field], field, properties[field]);
    if (bad) return toolName + ": " + bad;
  }
  return null;
}

/**
 * Wrap a tool so its arguments are validated before run() sees them.
 *
 * The tool objects themselves stay unchanged, so a caller that imports a tool
 * directly keeps working; every path that resolves a tool through findTool() /
 * allRegisteredTools() — which is what the agent, the CLI and the registry use
 * — gets the guard.
 */
export function withArgumentGuard(tool) {
  // One wrapper per tool per process. Callers (and tests) patch the object
  // findTool() hands them, so a fresh wrapper on every lookup would silently
  // drop the patch and the agent would run the unwrapped tool.
  const cached = GUARDED_TOOLS.get(tool.name);
  if (cached && cached.__source === tool) return cached;
  const guarded = Object.assign({}, tool);
  guarded.__source = tool;
  GUARDED_TOOLS.set(tool.name, guarded);
  const direct = tool.run.bind(tool);
  guarded.run = async (args, ctx) => {
    // Validate against the schema the tool's own run() is written for, not the
    // one advertised to the model: upstream-schemas.js is a best-effort
    // reconstruction, and where it disagrees with the runtime contract (its
    // TodoWrite says todos is an object, while run() takes an array) the
    // runtime contract is what "the arguments are usable" means.
    const problem = validateToolArguments(tool.name, args, tool.input_schema);
    if (problem) return { ok: false, content: problem };
    return direct(args, ctx);
  };
  return guarded;
}

/** Wrappers already built, keyed by tool name: findTool() must be stable. */
const GUARDED_TOOLS = new Map();

/** Read a count-style parameter without letting a bad value reach fs/streams. */
function positiveInt(value, fallback) {
  const n = typeof value === "string" ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/** A readable failure for a missing or non-string parameter. */
function requireString(toolName, field, value, hint) {
  if (typeof value === "string" && value.trim()) return null;
  const got = value === undefined ? "（缺字段）" : typeOfValue(value);
  return toolName + ": 参数 " + field + " 必须是非空字符串，实际是 " + got + "。" +
    (hint ? hint + " " : "") + "请重新调用并给出 " + field + "。";
}
/** Output beyond this size is written to disk instead of being pasted back. */
const PERSIST_THRESHOLD = 30000;
/** Where persisted output lives; one file per oversized result. */
function persistDir() {
  return join(tmpdir(), "myclaude-output");
}

/**
 * Return a small version of an oversized tool result, keeping the full text on disk.
 *
 * Build logs and test output routinely exceed the truncation limit, and a clipped
 * tail is exactly where the failure usually is. Writing the whole thing out and
 * handing back a path preserves it; the caller can read the file if it needs more.
 *
 * Writing must never break the command: if the disk is full or the directory is
 * read-only, fall back to the previous truncation behaviour.
 *
 * @returns {{content: string, persistedPath: string|null, persistedSize: number}}
 */
function persistLargeOutput(text) {
  const body = String(text);
  if (body.length <= PERSIST_THRESHOLD) { return { content: body, persistedPath: null, persistedSize: 0 }; }

  let file = null;
  try {
    const dir = persistDir();
    mkdirSync(dir, { recursive: true });
    file = join(dir, `bash-${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}.log`);
    writeFileSync(file, body, "utf8");
  } catch {
    // Unwritable disk: keep the old behaviour rather than failing the command.
    return { content: truncate(body), persistedPath: null, persistedSize: 0 };
  }

  const lineCount = body.split("\n").length;
  // Keep the head so the command output is still recognisable, and say plainly
  // where the rest went. The size is what tells the model how big a file it is.
  const kept = body.slice(0, PERSIST_THRESHOLD);
  const note =
    `\n[完整输出已保存到 ${file}，共 ${lineCount} 行 ${body.length} 字符]`;
  return { content: kept + note, persistedPath: file, persistedSize: body.length };
}

export const readTool = {
  name: "Read",
  description:
    "Read a file from the local filesystem. Text files are returned with line numbers (offset/limit for large files). " +
    "Images are returned as base64 attachments for vision models; PDFs are read page-wise as text when possible.",
  input_schema: {
    type: "object",
    properties: {
      file_path: { type: "string", description: "Absolute path to the file" },
      offset: { type: "number", description: "Line number to start from (1-indexed)" },
      limit: { type: "number", description: "Max lines to read (default 2000)" },
      pages: { type: "string", description: "PDF page range, e.g. '1-5' or '3' (max 20 pages per request)" },
    },
    required: ["file_path"],
  },
  async run(raw) {
    const a = raw || {};
    const badPath = requireString("Read", "file_path", a.file_path, "它必须是文件的绝对路径。");
    if (badPath) return err(badPath);
    const file_path = a.file_path;
    const offset = positiveInt(a.offset, 1);
    const limit = positiveInt(a.limit, 2000);
    const { pages, allow_large } = a;
    try {
      const st = await stat(file_path);
      if (st.isDirectory()) return err(`EISDIR: ${file_path} is a directory (use LS)`);
      // allow_large 是上游参数：放宽单文件体积上限（上游语义是「只要还塞得进上下文就允许」）。
      const sizeCap = MAX_READ_BYTES * (allow_large ? 25 : 5);
      if (st.size > sizeCap) return err(`file too large: ${st.size} bytes`);

      const ext = extname(file_path).toLowerCase();
      const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"]);
      if (IMAGE_EXT.has(ext)) {
        if (st.size > 5 * 1024 * 1024) return err(`image too large: ${st.size} bytes (max 5MB)`);
        const buf = await readFile(file_path);
        const mime = ext === ".png" ? "image/png" : ext === ".gif" ? "image/gif" : ext === ".webp" ? "image/webp" : "image/jpeg";
        const b64 = buf.toString("base64");
        return {
          ok: true,
          content: `[image ${basename(file_path)} ${st.size} bytes ${mime}]`,
          attachments: [{ type: "image", source: { type: "base64", media_type: mime, data: b64 } }],
        };
      }

      const raw = await readFile(file_path, "utf8");
      if (/\0/.test(raw.slice(0, 8000))) {
        return err(`binary file: ${file_path} (${st.size} bytes) — cannot display as text`);
      }

      if (ext === ".pdf") {
        const text = extractPdfText(raw, pages);
        if (text == null) {
          return err(`PDF text extraction unavailable for ${basename(file_path)}; open it with an external reader`);
        }
        return ok(truncate(text));
      }

      const lines = raw.split(/\r?\n/);
      const start = Math.max(0, offset - 1);
      const slice = lines.slice(start, start + limit);
      const numbered = slice.map((l, i) => `${start + i + 1}\t${l}`).join("\n");
      const header =
        lines.length > start + limit
          ? `[showing lines ${start + 1}-${start + slice.length} of ${lines.length}]`
          : `[${lines.length} lines]`;
      return ok(`${header}\n${truncate(numbered)}`);
    } catch (e) {
      return err(`${e.code || "ERR"}: ${e.message}`);
    }
  },
};

/** Best-effort PDF text extraction from Flate-compressed streams. */
function extractPdfText(raw, pages) {
  try {
    const { inflateSync } = require("node:zlib");
    const objects = [...raw.matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)];
    const chunks = [];
    for (const m of objects) {
      try {
        chunks.push(inflateSync(Buffer.from(m[1], "latin1")).toString("latin1"));
      } catch {
        chunks.push(m[1]);
      }
    }
    const all = chunks.join("\n");
    const texts = [...all.matchAll(/\((?:[^()\\]|\\.)*\)/g)].map((m) =>
      m[0]
        .slice(1, -1)
        .replace(/\\([()\\])/g, "$1")
        .replace(/\\n/g, "\n")
    );
    if (!texts.length) return null;
    let text = texts.join("");
    if (pages) {
      const m = /^(\d+)(?:-(\d+))?$/.exec(pages.trim());
      if (m) {
        const from = Number(m[1]);
        const to = m[2] ? Number(m[2]) : from;
        if (to - from > 19) return "page range too large (max 20 pages per request)";
        const pageCount = (raw.match(/\/Type\s*\/Page[^s]/g) || []).length || 1;
        const linesPerPage = Math.ceil(text.length / pageCount) || text.length;
        text = text.slice((from - 1) * linesPerPage, to * linesPerPage);
      }
    }
    return `[PDF text extraction — best effort, layout may be lost]\n\n${text}`;
  } catch {
    return null;
  }
}

export const writeTool = {
  name: "Write",
  description: "Write content to a file, creating parent directories as needed. Overwrites existing files.",
  input_schema: {
    type: "object",
    properties: {
      file_path: { type: "string", description: "Absolute path to write" },
      content: { type: "string", description: "Full file content" },
    },
    required: ["file_path", "content"],
  },
  async run({ file_path, content }) {
    if (typeof file_path !== "string" || !file_path) {
      return err("缺少 file_path 参数（模型输出的工具参数不是合法 JSON，已自动尝试修复仍失败；请重新调用并给出 file_path）");
    }

    try {
      await mkdir(dirname(file_path), { recursive: true });
      await writeFile(file_path, content, "utf8");
      return ok(`wrote ${Buffer.byteLength(content, "utf8")} bytes to ${file_path}`);
    } catch (e) {
      return err(`${e.code || "ERR"}: ${e.message}`);
    }
  },
};

export const editTool = {
  name: "Edit",
  description:
    "Replace an exact string in a file. old_string must appear exactly once unless replace_all is true.",
  input_schema: {
    type: "object",
    properties: {
      file_path: { type: "string" },
      old_string: { type: "string" },
      new_string: { type: "string" },
      replace_all: { type: "boolean" },
    },
    required: ["file_path", "old_string", "new_string"],
  },
  async run(raw) {
    const a = raw || {};
    const badPath = requireString("Edit", "file_path", a.file_path, "旧字符串必须能在该文件里唯一匹配。");
    if (badPath) return err(badPath);
    if (typeof a.old_string !== "string") {
      return err("Edit: 参数 old_string 必须是字符串（要替换掉的原文），实际是 " + typeOfValue(a.old_string) + "。请重新调用并给出 old_string。");
    }
    if (typeof a.new_string !== "string") {
      return err("Edit: 参数 new_string 必须是字符串（替换后的内容），实际是 " + typeOfValue(a.new_string) + "。请重新调用并给出 new_string。");
    }
    const { file_path, old_string, new_string, replace_all = false } = a;
    try {
      const raw = await readFile(file_path, "utf8");
      // Models emit LF even when the file on disk is CRLF, so a literal
      // includes() check fails on every Windows file. Retry with both sides
      // normalised, then restore the original line endings on write.
      const usesCRLF = raw.includes("\r\n");
      const normLine = (s) => String(s).replace(/\r\n/g, "\n");
      const restoreEol = (s) => (usesCRLF ? String(s).replace(/\n/g, "\r\n") : s);
      const haystack = raw.includes(old_string) ? raw : normLine(raw);
      const needle = raw.includes(old_string) ? old_string : normLine(old_string);
      if (!haystack.includes(needle)) return err("old_string not found in file");
      if (!replace_all) {
        const count = haystack.split(needle).length - 1;
        if (count > 1) return err(`old_string appears ${count} times; provide more context or use replace_all`);
        const next = haystack.replace(needle, new_string);
        await writeFile(file_path, restoreEol(next), "utf8");
        return ok(`replaced 1 occurrence in ${file_path}`);
      }
      const next = haystack.split(needle).join(new_string);
      await writeFile(file_path, restoreEol(next), "utf8");
      return ok(`replaced all occurrences in ${file_path}`);
    } catch (e) {
      return err(`${e.code || "ERR"}: ${e.message}`);
    }
  },
};

export const lsTool = {
  name: "LS",
  description: "List directory entries.",
  input_schema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Directory path (default: cwd)" },
    },
  },
  async run(raw) {
    const a = raw || {};
    if (a.path !== undefined && (typeof a.path !== "string" || !a.path.trim())) {
      return err(requireString("LS", "path", a.path, "不传 path 时默认列出当前工作目录。"));
    }
    const path = a.path === undefined ? process.cwd() : a.path;
    try {
      const entries = await readdir(path, { withFileTypes: true });
      const lines = entries
        .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
        .map((e) => (e.isDirectory() ? `${e.name}/` : e.name));
      return ok(lines.join("\n") || "(empty)");
    } catch (e) {
      return err(`${e.code || "ERR"}: ${e.message}`);
    }
  },
};

export const globTool = {
  name: "Glob",
  description: "Find files matching a glob pattern (supports ** and *).",
  input_schema: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Glob pattern, e.g. src/**/*.js" },
      path: { type: "string", description: "Base directory (default: cwd)" },
    },
    required: ["pattern"],
  },
  async run(raw) {
    const a = raw || {};
    const badPattern = requireString("Glob", "pattern", a.pattern, "例如 src/**/*.js。");
    if (badPattern) return err(badPattern);
    if (a.path !== undefined && (typeof a.path !== "string" || !a.path.trim())) {
      return err(requireString("Glob", "path", a.path, "不传 path 时默认从当前工作目录开始。"));
    }
    const pattern = a.pattern;
    const path = a.path === undefined ? process.cwd() : a.path;
    try {
      const matches = await globWalk(path, pattern);
      if (!matches.length) return ok("(no matches)");
      return ok(matches.slice(0, 500).join("\n") + (matches.length > 500 ? `\n...[+${matches.length - 500} more]` : ""));
    } catch (e) {
      return err(`${e.code || "ERR"}: ${e.message}`);
    }
  },
};

function globToRegExp(glob) {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        re += ".*";
        i++;
        if (glob[i + 1] === "/") i++;
      } else {
        re += "[^/\\\\]*";
      }
    } else if (c === "?") {
      re += ".";
    } else if ("\\^$.|+()[]{}".includes(c)) {
      re += "\\" + c;
    } else if (c === "/") {
      re += "[/\\\\]";
    } else {
      re += c;
    }
  }
  return new RegExp(`^${re}$`, "i");
}

async function globWalk(root, pattern) {
  const re = globToRegExp(pattern.replace(/\\/g, "/"));
  const out = [];
  const skip = new Set(["node_modules", ".git", "dist", "build", ".next", "__pycache__"]);
  async function walk(dir) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = join(dir, e.name);
      const rel = relative(root, full).replace(/\\/g, "/");
      if (e.isDirectory()) {
        if (skip.has(e.name)) continue;
        await walk(full);
      } else if (re.test(rel) || re.test(e.name)) {
        out.push(full);
      }
    }
  }
  await walk(root);
  return out;
}

/** Cached result of looking for the ripgrep binary. */
let ripgrepPath = null;
let ripgrepChecked = false;

/**
 * Locate ripgrep once per process.
 *
 * The pure-JS fallback reads every file it walks, which is fine for a small
 * tree and painfully slow on a real repository. ripgrep respects .gitignore,
 * skips binaries and searches in parallel, so it is preferred whenever the
 * binary is on PATH.
 */
function findRipgrep() {
  if (ripgrepChecked) { return ripgrepPath; }
  ripgrepChecked = true;

  // 1) PATH: a user-installed ripgrep should win, it may be newer.
  const names = process.platform === "win32" ? ["rg.exe", "rg"] : ["rg"];
  for (const name of names) {
    try {
      const probe = spawnSync(name, ["--version"], { encoding: "utf8", timeout: 5000, windowsHide: true });
      if (probe.status === 0) { ripgrepPath = name; return ripgrepPath; }
    } catch {
      // keep looking
    }
  }

  // 2) The bundled binary, as a sibling of the app. A compiled single-file
  //    build has no node_modules, so the path is resolved relative to the
  //    executable directory first and only then through require.resolve.
  const bundled = [
    join(dirname(process.execPath), "rg.exe"),
    join(dirname(process.execPath), "bin", "rg.exe"),
  ];
  for (const candidate of bundled) {
    try {
      if (existsSync(candidate)) {
        const probe = spawnSync(candidate, ["--version"], { encoding: "utf8", timeout: 5000, windowsHide: true });
        if (probe.status === 0) { ripgrepPath = candidate; return ripgrepPath; }
      }
    } catch {
      // keep looking
    }
  }

  // 3) The npm package, when running from source.
  try {
    const platformPkg = `@vscode/ripgrep-${process.platform}-${process.arch}`;
    const binName = process.platform === "win32" ? "rg.exe" : "rg";
    const resolved = require.resolve(`${platformPkg}/bin/${binName}`);
    const probe = spawnSync(resolved, ["--version"], { encoding: "utf8", timeout: 5000, windowsHide: true });
    if (probe.status === 0) { ripgrepPath = resolved; return ripgrepPath; }
  } catch {
    // package not installed
  }

  ripgrepPath = null;
  return ripgrepPath;
}

/**
 * Run a ripgrep search and shape its output like the JS fallback.
 *
 * @returns {{ok: boolean, content: string}|null} null when ripgrep is absent
 *   or failed in a way the fallback should handle instead.
 */
function ripgrepSearch({ pattern, path, glob, type, output_mode, i, n, o, A, B, C, max_results }) {
  const rg = findRipgrep();
  if (!rg) { return null; }

  const args = ["--no-heading", "--color", "never"];
  if (i) { args.push("-i"); }
  if (glob) { args.push("--glob", glob); }
  if (type) { args.push("--type", type); }
  const before = Math.max(B, C);
  const after = Math.max(A, C);
  if (before > 0) { args.push("-B", String(before)); }
  if (after > 0) { args.push("-A", String(after)); }
  if (output_mode === "files_with_matches") { args.push("--files-with-matches"); }
  else if (output_mode === "count") { args.push("--count"); }
  else {
    // -o（上游参数）：只输出匹配到的片段，而不是整行
    if (o) { args.push("--only-matching"); }
    else if (n) { args.push("--line-number"); }
  }
  args.push("--", pattern, path);

  let out;
  try {
    out = spawnSync(rg, args, { encoding: "utf8", timeout: 60000, windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
  } catch {
    return null;
  }
  // Exit 1 means "no matches" — a valid empty result, not a failure.
  if (out.status !== 0 && out.status !== 1) { return null; }
  const text = String(out.stdout || "").replace(/\r\n/g, "\n").trimEnd();
  if (!text) { return { ok: true, content: "(no matches)" }; }
  if (output_mode === "files_with_matches") {
    const files = text.split("\n").filter(Boolean);
    return { ok: true, content: truncate(files.slice(0, 500).join("\n")) };
  }
  if (output_mode === "count") {
    // --count prints "path:count"; sum them for a total line the model can read.
    const rows = text.split("\n").filter(Boolean);
    let total = 0;
    for (const row of rows) {
      const m = /:(\d+)$/.exec(row);
      if (m) { total += Number(m[1]); }
    }
    return { ok: true, content: truncate(`total ${total} matches in ${rows.length} file(s)\n` + rows.join("\n")) };
  }
  // ripgrep writes "path:line:content" while the JS fallback writes
  // "path:line: content". Normalise to the spaced form so callers (and the
  // tests) see one format regardless of which engine ran.
  const normalised = text.split("\n").map((row) => {
    const m = /^(.+?:\d+):(?! )/.exec(row);
    return m ? m[1] + ": " + row.slice(m[1].length + 1) : row;
  }).join("\n");
  const linesOut = normalised.split("\n");
  const capped = linesOut.slice(0, max_results).join("\n");
  const note = linesOut.length > max_results ? `\n… ${linesOut.length - max_results} more line(s)` : "";
  return { ok: true, content: truncate(capped + note) };
}

export const grepTool = {
  name: "Grep",
  description:
    "Search file contents with a regular expression. Default output is matching lines as file:line: text; " +
    "use output_mode=files_with_matches for paths only, or output_mode=count for per-file match counts. " +
    "-A/-B/-C add context lines around each match.",
  input_schema: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Regular expression (ripgrep syntax)" },
      path: { type: "string", description: "File or directory (default: cwd)" },
      glob: { type: "string", description: "Filename glob filter, e.g. *.js or **/*.ts" },
      type: { type: "string", description: "File type filter, e.g. js, ts, py, md, json" },
      output_mode: {
        type: "string",
        enum: ["content", "files_with_matches", "count"],
        description: "content (default), files_with_matches, or count",
      },
      i: { type: "boolean", description: "Case-insensitive search" },
      n: { type: "boolean", description: "Show line numbers (default true for content mode)" },
      A: { type: "number", description: "Lines of context after each match" },
      B: { type: "number", description: "Lines of context before each match" },
      C: { type: "number", description: "Lines of context before and after each match" },
      max_results: { type: "number", description: "Maximum matches to return (default 200)" },
    },
    required: ["pattern"],
  },
  async run(raw) {
    // 上游用 ripgrep 风格的短横线参数（-A/-B/-C/-n/-i/-o）与 head_limit；
    // MyClaude 历史上用 A/B/C/i/n/max_results。两套都收，上游优先。
    const a = raw || {};
    const badPattern = requireString("Grep", "pattern", a.pattern, "它是要搜索的正则表达式。");
    if (badPattern) return err(badPattern);
    if (a.path !== undefined && (typeof a.path !== "string" || !a.path.trim())) {
      return err(requireString("Grep", "path", a.path, "不传 path 时默认搜索当前工作目录。"));
    }
    const norm = {
      ...a,
      i: a["-i"] !== undefined ? a["-i"] : a.i,
      n: a["-n"] !== undefined ? a["-n"] : a.n,
      o: a["-o"] !== undefined ? a["-o"] : a.o,
      A: a["-A"] !== undefined ? a["-A"] : a.A,
      B: a["-B"] !== undefined ? a["-B"] : a.B,
      C: a["-C"] !== undefined ? a["-C"] : (a.context !== undefined ? a.context : a.C),
      max_results: a.head_limit !== undefined ? a.head_limit : a.max_results,
    };
    const {
      pattern,
      path = process.cwd(),
      glob,
      type,
      output_mode = "content",
      i = false,
      n = true,
      o = false,
      A = 0,
      B = 0,
      C = 0,
      max_results = 200,
    } = norm;
    // A non-number here would reach index arithmetic (before/after) or the
    // result cap; coerce before the search instead of failing inside it.
    const ctxA = positiveInt(A, 0);
    const ctxB = positiveInt(B, 0);
    const ctxC = positiveInt(C, 0);
    const cap = positiveInt(max_results, 200);
    try {
      // Prefer ripgrep when installed: it honours .gitignore and is far faster
      // on large trees. Falls through to the JS scan below when unavailable.
      const rgResult = ripgrepSearch({ pattern, path, glob, type, output_mode, i, n, o, A: ctxA, B: ctxB, C: ctxC, max_results: cap });
      if (rgResult) { return rgResult; }
      let flags = "m";
      if (i) flags += "i";
      const re = new RegExp(pattern, flags);
      const before = Math.max(ctxB, ctxC);
      const after = Math.max(ctxA, ctxC);
      const includeRe = glob ? globToRegExp(glob) : null;
      const typeRe = type ? typeToRegexp(type) : null;
      const results = [];
      const counts = new Map();
      const skip = new Set(["node_modules", ".git", "dist", "build", ".next", "__pycache__", ".venv", "target"]);

      async function scanFile(file) {
        let text;
        try {
          const st = await stat(file);
          if (st.size > 4 * 1024 * 1024) return;
          text = await readFile(file, "utf8");
        } catch {
          return;
        }
        const lines = text.split(/\r?\n/);
        /** @type {Set<number>} */
        const hitLines = new Set();
        const fileHits = [];
        for (let li = 0; li < lines.length; li++) {
          if (!re.test(lines[li])) continue;
          fileHits.push(li);
          counts.set(file, (counts.get(file) || 0) + 1);
          const lo = Math.max(0, li - before);
          const hi = Math.min(lines.length - 1, li + after);
          for (let k = lo; k <= hi; k++) hitLines.add(k);
          if (output_mode === "files_with_matches") break;
        }
        if (!fileHits.length) return;
        if (output_mode === "files_with_matches") {
          results.push(file);
          return;
        }
        if (output_mode === "count") return; // counts are aggregated below
        const sorted = [...hitLines].sort((a, b) => a - b);
        let prev = -2;
        for (const li of sorted) {
          if (li > prev + 1 && prev >= 0) results.push("--");
          const prefix = n ? `${file}:${li + 1}: ` : "";
          if (o) {
            // -o（上游参数）：只输出匹配片段本身，而不是整行
            const mm = lines[li].match(re);
            if (mm) { results.push(`${prefix}${mm[0].slice(0, 300)}`); }
          } else {
            results.push(`${prefix}${lines[li].slice(0, 300)}`);
          }
          prev = li;
          if (results.length >= cap) return;
        }
      }

      async function walk(dir) {
        if (results.length >= cap) return;
        let entries;
        try {
          entries = await readdir(dir, { withFileTypes: true });
        } catch {
          return;
        }
        for (const e of entries) {
          if (results.length >= cap) return;
          const full = join(dir, e.name);
          if (e.isDirectory()) {
            if (skip.has(e.name)) continue;
            await walk(full);
          } else {
            if (includeRe && !includeRe.test(e.name) && !includeRe.test(full)) continue;
            if (typeRe && !typeRe.test(e.name)) continue;
            await scanFile(full);
          }
        }
      }

      const st = await stat(path);
      if (st.isDirectory()) await walk(path);
      else await scanFile(path);

      if (output_mode === "files_with_matches") {
        if (!results.length) return ok("(no matches)");
        return ok(truncate(results.slice(0, 500).join("\n")));
      }
      if (output_mode === "count") {
        if (!counts.size) return ok("(no matches)");
        const lines = [...counts.entries()].map(([f, c]) => `${f}:${c}`);
        return ok(truncate(lines.join("\n")));
      }
      if (!results.length) return ok("(no matches)");
      return ok(truncate(results.join("\n")));
    } catch (e) {
      return err(`${e.code || "ERR"}: ${e.message}`);
    }
  },
};

const TYPE_EXTENSIONS = {
  js: ["js", "mjs", "cjs", "jsx"],
  ts: ["ts", "mts", "cts", "tsx"],
  py: ["py", "pyi"],
  md: ["md", "markdown"],
  json: ["json"],
  yaml: ["yaml", "yml"],
  rust: ["rs"],
  go: ["go"],
  java: ["java"],
  c: ["c", "h"],
  cpp: ["cpp", "cc", "cxx", "hpp"],
  rb: ["rb"],
  sh: ["sh", "bash", "zsh"],
  html: ["html", "htm"],
  css: ["css", "scss", "sass"],
};

function typeToRegexp(type) {
  const exts = TYPE_EXTENSIONS[type];
  if (!exts) return new RegExp(`\\.${type.replace(/^\./, "")}$`, "i");
  return new RegExp(`\\.(${exts.join("|")})$`, "i");
}

export const multiEditTool = {
  name: "MultiEdit",
  description:
    "Apply several exact-string replacements to one file atomically. All edits are validated first; if any fails, nothing is written.",
  input_schema: {
    type: "object",
    properties: {
      file_path: { type: "string" },
      edits: {
        type: "array",
        description: "Ordered list of {old_string, new_string, replace_all?}",
        items: {
          type: "object",
          properties: {
            old_string: { type: "string" },
            new_string: { type: "string" },
            replace_all: { type: "boolean" },
          },
          required: ["old_string", "new_string"],
        },
      },
    },
    required: ["file_path", "edits"],
  },
  async run(raw) {
    const a = raw || {};
    const badPath = requireString("MultiEdit", "file_path", a.file_path);
    if (badPath) return err(badPath);
    const { file_path, edits } = a;
    if (!Array.isArray(edits) || !edits.length) return err("edits must be a non-empty array");
    let text;
    try {
      const st = await stat(file_path);
      if (st.isDirectory()) return err(`${file_path} is a directory`);
      text = await readFile(file_path, "utf8");
    } catch (e) {
      return err(`${e.code || "ERR"}: ${e.message}`);
    }

    let work = text;
    const applied = [];
    for (let i = 0; i < edits.length; i++) {
      const { old_string, new_string, replace_all = false } = edits[i];
      if (typeof old_string !== "string" || typeof new_string !== "string") {
        return err(`edit[${i}]: old_string and new_string must be strings`);
      }
      const count = work.split(old_string).length - 1;
      if (count === 0) return err(`edit[${i}]: old_string not found (no changes written)`);
      if (count > 1 && !replace_all) {
        return err(`edit[${i}]: old_string appears ${count} times; add context or set replace_all (no changes written)`);
      }
      work = replace_all ? work.split(old_string).join(new_string) : work.replace(old_string, new_string);
      applied.push(replace_all ? `${count}x` : "1x");
    }

    await writeFile(file_path, work, "utf8");
    return ok(`applied ${edits.length} edits to ${file_path} (${applied.join(", ")})`);
  },
};

export const bashTool = {
  name: "Bash",
  description:
    "Execute a shell command. Use for builds, tests, git, and system inspection. " +
    "Set run_in_background=true for long-running commands (dev servers, watchers); poll with BashOutput and stop with KillShell.",
  input_schema: {
    type: "object",
    properties: {
      command: { type: "string", description: "Shell command to execute" },
      cwd: { type: "string", description: "Working directory (default: cwd)" },
      timeout_ms: { type: "number", description: "Timeout in ms (default 120000)" },
      run_in_background: { type: "boolean", description: "Run in the background and return a task id immediately" },
    },
    required: ["command"],
  },
  async run(raw) {
    // 上游用 timeout（毫秒）+ dangerouslyDisableSandbox；MyClaude 用 timeout_ms + cwd + signal。
    // timeout 优先（上游命名），dangerouslyDisableSandbox 无对应沙箱实现，忽略并说明。
    const a = raw || {};
    const timeout_ms = a.timeout !== undefined ? a.timeout : (a.timeout_ms !== undefined ? a.timeout_ms : 120000);
    const badCommand = requireString("Bash", "command", a.command, "它是要交给 shell 执行的命令文本。");
    if (badCommand) return err(badCommand);
    if (a.cwd !== undefined && (typeof a.cwd !== "string" || !a.cwd.trim())) {
      return err(requireString("Bash", "cwd", a.cwd, "不传 cwd 时默认使用当前工作目录。"));
    }
    const { command, cwd = process.cwd(), run_in_background = false, signal } = a;
    if (run_in_background) {
      const started = await startBackground({ command, cwd, timeout_ms: Math.max(timeout_ms, 60000) });
      if (!started.ok) return err(`failed to start background task: ${started.status}`);
      return ok(
        `started background task ${started.id} (pid ${started.pid})\noutput file: ${started.outputPath}\n` +
          `poll with BashOutput(task_id:"${started.id}") and stop with KillShell(task_id:"${started.id}")`
      );
    }
    return new Promise((resolvePromise) => {
      // Pass the command as one argv element: building a single string and
      // handing it to exec() makes the shell parse it twice, so a Windows
      // command containing quotes or "&" (git commit -m "fix: a & b") breaks
      // with "string is missing the terminator".
      // Windows: cmd.exe with windowsVerbatimArguments, not PowerShell.
      // - argv is passed through untouched, so a command containing quotes or
      //   "&" (git commit -m "fix: a & b") no longer breaks: building one
      //   string for exec() made the shell parse it twice.
      // - cmd.exe starts in ~80ms; powershell.exe takes 3-8s per call, which
      //   made every Bash tool invocation feel like a hang.
      const isWin = process.platform === "win32";
      const shell = isWin ? "cmd.exe" : "/bin/sh";
      const args = isWin ? ["/d", "/s", "/c", command] : ["-c", command];
      const child = spawn(shell, args, { cwd, windowsHide: true, windowsVerbatimArguments: isWin });
      // A user stop (or the per-turn abort) must reach running tools: without
      // this listener the child kept running to completion, so the stop button
      // looked dead while a long command was in flight.
      const killChild = () => {
        try {
          if (process.platform === "win32" && child.pid) {
            spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
          } else {
            child.kill("SIGKILL");
          }
        } catch {}
      };
      if (signal) {
        if (signal.aborted) killChild();
        else signal.addEventListener("abort", killChild, { once: true });
      }
      let stdout = "";
      let stderr = "";
      // Decode with the console code page, not blindly as UTF-8: see the
      // decoding helpers above. Each stream needs its own stateful decoder.
      const outDecoder = outputDecoder();
      const errDecoder = outputDecoder();
      let timedOut = false;
      let promotedTask = null;
      let settled = false;
      const timer = setTimeout(() => {
        timedOut = true;
        // Do NOT kill: a command that outlived its timeout is usually a test
        // suite or build that is still making progress. Killing it threw the
        // work away and the model just re-ran it until it gave up. Hand the
        // live child to the background registry instead, so the caller gets a
        // task id to poll and the work survives the turn.
        adoptProcess({
          command,
          cwd,
          child,
          initialOutput: stdout + (stderr ? "\n[stderr]\n" + stderr : ""),
          timeout_ms: Math.max(timeout_ms, 600000)
        }).then(({ id: taskId, outputPath }) => {
          promotedTask = { id: taskId, outputPath };
          finish(-1, true);
        }).catch(() => {
          try {
            if (process.platform === "win32" && child.pid) {
              spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
            } else {
              child.kill("SIGKILL");
            }
          } catch {}
        });
      }, Math.max(1000, timeout_ms));
      child.stdout.on("data", (c) => { stdout = appendDecoded(stdout, outDecoder, c); });
      child.stderr.on("data", (c) => { stderr = appendDecoded(stderr, errDecoder, c); });
      const finish = (code, promoted = false) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        // Flush what a stateful decoder is still holding and drop a partial
        // character that was cut off mid-sequence at EOF.
        stdout = decodeWholeOutput(outDecoder, stdout).replace(/\uFFFD+$/, "");
        stderr = decodeWholeOutput(errDecoder, stderr).replace(/\uFFFD+$/, "");
        const parts = [];
        if (promoted && promotedTask) {
          // The command is still running in the background: say so up front,
          // because the model must poll instead of re-running it.
          parts.push(
            `[timeout after ${Math.max(1000, timeout_ms)}ms — the command is still running as background task ${promotedTask.id}]` + "\n" +
            `poll it with BashOutput(task_id:"${promotedTask.id}"); stop it with KillShell(task_id:"${promotedTask.id}")` + "\n" +
            `output file: ${promotedTask.outputPath}` + "\n" +
            `do NOT re-run this command — it is already running.`
          );
        }
        if (stdout) parts.push(stdout);
        if (stderr) parts.push(`[stderr]\n${stderr}`);
        if (code !== 0 && !promoted) parts.push(`[exit ${code ?? "?"}]${timedOut ? " (timeout)" : ""}`);
        const raw = parts.join("\n") || "(no output)";
        // Big output goes to disk: a clipped tail hides the actual failure.
        const persisted = persistLargeOutput(raw);
        const result = { ok: code === 0 || promoted, content: persisted.content };
        if (persisted.persistedPath) {
          result.persistedOutputPath = persisted.persistedPath;
          result.persistedOutputSize = persisted.persistedSize;
        }
        resolvePromise(result);
      };
      child.on("error", (e) => {
        clearTimeout(timer);
        resolvePromise({ ok: false, content: `failed to start shell: ${e.message}` });
      });
      child.on("close", (code) => finish(code, false));
    });
  },
};

export const bashOutputTool = {
  name: "BashOutput",
  description:
    "Read new output from a background Bash task started with run_in_background=true. " +
    "Pass the same offset back as next_offset to read only newly produced bytes.",
  input_schema: {
    type: "object",
    properties: {
      task_id: { type: "string", description: "Task id returned by Bash" },
      offset: { type: "number", description: "Byte offset to resume from (default 0)" },
      limit: { type: "number", description: "Max bytes to return (default 60000)" },
      wait: { type: "boolean", description: "Block until the task exits (default false)" },
    },
    required: ["task_id"],
  },
  async run(raw) {
    const a = raw || {};
    const badTask = requireString("BashOutput", "task_id", a.task_id, "它是 Bash(run_in_background=true) 返回的任务 id。");
    if (badTask) return err(badTask);
    const { task_id } = a;
    const offset = positiveInt(a.offset, 0);
    const limit = positiveInt(a.limit, 60000);
    const wait = a.wait === true;
    if (wait) {
      const settled = await waitTask(task_id);
      if (!settled.ok) return err(settled.error);
    }
    const r = await readTaskOutput(task_id, { offset, limit });
    if (!r.ok) return err(r.error);
    const header =
      `[task ${r.id}] status=${r.status}${r.exitCode != null ? ` exit=${r.exitCode}` : ""} pid=${r.pid ?? "?"}\n` +
      `[command] ${r.command}\n`;
    if (!r.output) return ok(`${header}(no new output${r.hasMore ? `; ${r.totalBytes} bytes total, pass offset=${r.nextOffset}` : ""})`);
    return ok(
      `${header}\n${r.output}` +
        (r.hasMore ? `\n...[more bytes available; call again with offset=${r.nextOffset}]` : "")
    );
  },
};

export const killShellTool = {
  name: "KillShell",
  description: "Stop a background Bash task started with run_in_background=true.",
  input_schema: {
    type: "object",
    properties: {
      task_id: { type: "string", description: "Task id to terminate" },
    },
    required: ["task_id"],
  },
  async run(raw) {
    const task_id = raw ? raw.task_id : undefined;
    const badTask = requireString("KillShell", "task_id", task_id, "它是 Bash(run_in_background=true) 返回的任务 id。");
    if (badTask) return err(badTask);
    const r = killTask(task_id);
    if (!r.ok) return err(r.error);
    if (r.note) return ok(`${r.id}: ${r.note}`);
    return ok(`killed task ${r.id} (pid ${r.pid})`);
  },
};

export const ALL_TOOLS = [
  readTool,
  writeTool,
  editTool,
  multiEditTool,
  lsTool,
  globTool,
  grepTool,
  bashTool,
  bashOutputTool,
  killShellTool,
  ...GIT_TOOLS,
];

// The extended built-ins live in extra.js and are registered by the agent at
// startup; fold them into ALL_TOOLS so a bare import still exposes the full
// core surface to tests and /tools listings.
if (!ALL_TOOLS.some((t) => t.name === todoWriteTool.name)) ALL_TOOLS.push(todoWriteTool);
if (!ALL_TOOLS.some((t) => t.name === webFetchTool.name)) ALL_TOOLS.push(webFetchTool);

export { taskSummaries };

// Extended tool set registered by the agent at startup (MultiEdit, TodoWrite,
// WebFetch, Task, and MCP-bridged tools). Kept separate so ALL_TOOLS stays the
// stable core and tests can exercise it without the agent runtime.
export const EXTRA_TOOLS = [];

export function registerTools(tools) {
  for (const t of tools) {
    if (!EXTRA_TOOLS.find((x) => x.name === t.name)) {
      EXTRA_TOOLS.push(t);
      // A re-registered tool may have a different object behind the name.
      GUARDED_TOOLS.delete(t.name);
    }
  }
}

/**
 * Every registered tool, with its argument guard attached.
 *
 * The guard is applied here rather than on the exported tool objects, so a
 * caller that imports one tool directly keeps the old behaviour while every
 * path that resolves tools the way the agent does (findTool, the CLI, /tools)
 * validates the arguments first and answers with a readable error instead of a
 * TypeError out of fs.
 */
export function allRegisteredTools() {
  const seen = new Set();
  const out = [];
  for (const t of [...ALL_TOOLS, ...EXTRA_TOOLS]) {
    if (seen.has(t.name)) continue;
    seen.add(t.name);
    out.push(withArgumentGuard(t));
  }
  return out;
}

/**
 * 工具的参数面：采用上游 Claude Code 2.1.302 的契约（逐字，含属性级描述词）。
 * 上游没有同名工具、或该工具 schema 是运行时分支无法静态还原时，保留 MyClaude 自研 schema。
 * 决策表见 scripts/gen-upstream-schemas.mjs 的 DECISIONS。
 */
export function toolInputSchema(t) {
  return upstreamSchema(t.name) || t.input_schema;
}

/**
 * 工具描述词：优先用上游 Claude Code 2.1.302 的真实取值。
 *
 * 描述词直接决定模型怎么选工具、用什么参数 —— 上游的文案里有可执行的指引
 * （例：Grep 说「ALWAYS use Grep for search tasks. NEVER invoke `grep` or `rg` as a Bash command」，
 * Glob 说「open ended search 请改用 Agent 工具」），自研的一两句概括给不出这些。
 * 上游没有该工具、或描述词未提取到时，保留 MyClaude 自研描述词。
 */
export function toolDescription(t) {
  return upstreamDescription(t.name) || t.description;
}

export function toolSchemas(tools) {
  const list = tools || allRegisteredTools();
  return list.map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: toolDescription(t),
      parameters: toolInputSchema(t),
    },
  }));
}

export function findTool(name) {
  const n = String(name).toLowerCase();
  return allRegisteredTools().find((t) => t.name.toLowerCase() === n);
}

export { todoWriteTool, webFetchTool, getTodos, clearTodos, truncateOutput } from "./extra.js";

export const README_TOOLS = ALL_TOOLS;
