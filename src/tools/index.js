import { readFile, writeFile, mkdir, readdir, stat, access } from "node:fs/promises";
import { exec, spawn } from "node:child_process";
import { basename, dirname, extname, resolve, join, relative, isAbsolute } from "node:path";
import { constants } from "node:fs";
import { createRequire } from "node:module";
import { startBackground, killTask, readTaskOutput, waitTask, taskSummaries } from "./tasks.js";
import { todoWriteTool, webFetchTool } from "./extra.js";
import { GIT_TOOLS } from "./git.js";

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
  async run({ file_path, offset = 1, limit = 2000, pages }) {
    try {
      const st = await stat(file_path);
      if (st.isDirectory()) return err(`EISDIR: ${file_path} is a directory (use LS)`);
      if (st.size > MAX_READ_BYTES * 5) return err(`file too large: ${st.size} bytes`);

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
  async run({ file_path, old_string, new_string, replace_all = false }) {
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
  async run({ path = process.cwd() }) {
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
  async run({ pattern, path = process.cwd() }) {
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
  async run({
    pattern,
    path = process.cwd(),
    glob,
    type,
    output_mode = "content",
    i = false,
    n = true,
    A = 0,
    B = 0,
    C = 0,
    max_results = 200,
  }) {
    try {
      let flags = "m";
      if (i) flags += "i";
      const re = new RegExp(pattern, flags);
      const before = Math.max(B, C);
      const after = Math.max(A, C);
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
          results.push(`${prefix}${lines[li].slice(0, 300)}`);
          prev = li;
          if (results.length >= max_results) return;
        }
      }

      async function walk(dir) {
        if (results.length >= max_results) return;
        let entries;
        try {
          entries = await readdir(dir, { withFileTypes: true });
        } catch {
          return;
        }
        for (const e of entries) {
          if (results.length >= max_results) return;
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
  async run({ file_path, edits }) {
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
  async run({ command, cwd = process.cwd(), timeout_ms = 120000, run_in_background = false }) {
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
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        try {
          if (process.platform === "win32" && child.pid) {
            spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
          } else {
            child.kill("SIGKILL");
          }
        } catch {}
      }, Math.max(1000, timeout_ms));
      child.stdout.on("data", (c) => {
        if (stdout.length < 10 * 1024 * 1024) { stdout += c; }
      });
      child.stderr.on("data", (c) => {
        if (stderr.length < 10 * 1024 * 1024) { stderr += c; }
      });
      const finish = (code) => {
        clearTimeout(timer);
        const parts = [];
        if (stdout) parts.push(stdout);
        if (stderr) parts.push(`[stderr]\n${stderr}`);
        if (code !== 0) parts.push(`[exit ${code ?? "?"}]${timedOut ? " (timeout)" : ""}`);
        resolvePromise({ ok: code === 0, content: truncate(parts.join("\n") || "(no output)") });
      };
      child.on("error", (e) => {
        clearTimeout(timer);
        resolvePromise({ ok: false, content: `failed to start shell: ${e.message}` });
      });
      child.on("close", (code) => finish(code));
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
  async run({ task_id, offset = 0, limit = 60000, wait = false }) {
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
  async run({ task_id }) {
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
    if (!EXTRA_TOOLS.find((x) => x.name === t.name)) EXTRA_TOOLS.push(t);
  }
}

export function allRegisteredTools() {
  const seen = new Set();
  const out = [];
  for (const t of [...ALL_TOOLS, ...EXTRA_TOOLS]) {
    if (seen.has(t.name)) continue;
    seen.add(t.name);
    out.push(t);
  }
  return out;
}

export function toolSchemas(tools) {
  const list = tools || allRegisteredTools();
  return list.map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description,
      parameters: t.input_schema,
    },
  }));
}

export function findTool(name) {
  const n = String(name).toLowerCase();
  return allRegisteredTools().find((t) => t.name.toLowerCase() === n);
}

export { todoWriteTool, webFetchTool, getTodos, clearTodos, truncateOutput } from "./extra.js";

export const README_TOOLS = ALL_TOOLS;
