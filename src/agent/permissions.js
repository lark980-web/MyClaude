/**
 * Permission rules and project memory.
 *
 * Rule syntax (mirrors Claude Code's settings.json):
 *   { "permissions": {
 *       "allow": ["Bash(npm run test:*)", "Read(//**)", "Edit(src/**)"],
 *       "deny":  ["Bash(rm -rf:*)", "Read(.env)"],
 *       "ask":   ["Bash(git push:*)"] } }
 *
 * Each rule is "Tool(pattern)". "*" and "**" are glob wildcards; a bare tool
 * name matches every invocation. The most specific match wins, evaluated in
 * the order deny > ask > allow.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";

export class PermissionEngine {
  constructor(rules = {}) {
    this.allow = compileRules(rules.allow);
    this.deny = compileRules(rules.deny);
    this.ask = compileRules(rules.ask);
  }

  /** @returns {"allow"|"deny"|"ask"|null} */
  evaluate(toolName, args) {
    const target = ruleTarget(toolName, args);
    if (this.deny.length) {
      for (const r of this.deny) {
        if (r.tool === toolName && r.re.test(target)) return "deny";
      }
    }
    if (this.ask.length) {
      for (const r of this.ask) {
        if (r.tool === toolName && r.re.test(target)) return "ask";
      }
    }
    if (this.allow.length) {
      for (const r of this.allow) {
        if (r.tool === toolName && r.re.test(target)) return "allow";
      }
    }
    return null;
  }

  get isEmpty() {
    return !this.allow.length && !this.deny.length && !this.ask.length;
  }
}

function compileRules(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const raw of list) {
    if (typeof raw !== "string") continue;
    const m = /^([A-Za-z_][A-Za-z0-9_]*)(?:\((.*)\))?$/.exec(raw.trim());
    if (!m) continue;
    const tool = m[1];
    let pattern = m[2] ?? null;
    let re;
    if (pattern != null && pattern.startsWith("//")) {
      // Absolute-path rule: "Read(//**)" matches any absolute file, so both
      // C:/x/y.js and /x/y.js are accepted.
      re = new RegExp(`^(?:[A-Za-z]:)?[\\\\/]${globBody(pattern.slice(2))}$`, "i");
    } else {
      // Bash syntax uses ":" to separate the command prefix from its argument
      // pattern: Bash(npm run test:*) means the command starts with "npm run
      // test" and the rest is unconstrained.
      if (pattern != null && tool === "Bash" && pattern.includes(":")) {
        // "Bash(rm -rf:*)" must still match "rm -rf /tmp/x", so the argument
        // pattern becomes a full wildcard rather than a path-style glob.
        const idx = pattern.indexOf(":");
        const prefix = pattern.slice(0, idx);
        const rest = pattern.slice(idx + 1);
        pattern = rest.trim() === "*" ? `${prefix}**` : prefix + rest;
      }
      re = globToRegExp(pattern ?? "**");
    }
    out.push({ tool, pattern, re });
  }
  return out;
}

/** Glob body translation without the ^...$ anchors (used inside larger regexes). */
function globBody(glob) {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        re += "[\\s\\S]*";
        i++;
        if (glob[i + 1] === "/") i++;
      } else {
        re += "[^/\\\\]*";
      }
    } else if (c === "?") {
      re += "[^/\\\\]";
    } else if (c === "/") {
      re += "[/\\\\]";
    } else {
      re += c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
  }
  return re;
}

/** What part of the tool arguments the rule pattern is matched against. */
function ruleTarget(toolName, args) {
  const a = args || {};
  switch (toolName) {
    case "Bash":
      return String(a.command ?? "");
    case "Read":
    case "Write":
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit":
    case "NotebookRead":
      return String(a.file_path ?? a.notebook_path ?? "");
    case "Grep":
      return String(a.path ?? a.pattern ?? "");
    case "Glob":
      return String(a.pattern ?? a.path ?? "");
    case "LS":
      return String(a.path ?? "");
    case "WebFetch":
      return String(a.url ?? "");
    default:
      return JSON.stringify(a);
  }
}

export function globToRegExp(glob) {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        re += "[\\s\\S]*";
        i++;
        if (glob[i + 1] === "/") i++;
      } else {
        // Single * matches anything except a path separator, including spaces
        // (Claude Code uses ":*" as a command-prefix rule, e.g. "Bash(npm run test:*)").
        re += "[^/\\\\]*";
      }
    } else if (c === "?") {
      re += "[^/\\\\]";
    } else if ("\\^$.|+()[]{}".includes(c)) {
      re += "\\" + c;
    } else if (c === "/") {
      re += "[/\\\\]";
    } else {
      re += c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${re}$`, "i");
}

/* --------------------------------------------------------------- CLAUDE.md */

const MEMORY_FILES = ["MYCLAUDE.md", "myclaude.md"];

/** Load project memory from cwd, walking up to the git root or filesystem root. */
export function loadMemory(cwd = process.cwd(), { maxBytes = 100_000 } = {}) {
  const parts = [];
  let dir = cwd;
  const seen = new Set();
  for (let depth = 0; depth < 12; depth++) {
    for (const name of MEMORY_FILES) {
      const file = join(dir, name);
      if (seen.has(file) || !existsSync(file)) continue;
      seen.add(file);
      try {
        const text = readFileSync(file, "utf8");
        if (text.trim()) parts.push({ file, text });
      } catch {}
    }
    if (existsSync(join(dir, ".git"))) break;
    const parent = join(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }
  const userFile = join(process.env.USERPROFILE || process.env.HOME || "", ".myclaude", "MEMORY.md");
  if (existsSync(userFile)) {
    try {
      const text = readFileSync(userFile, "utf8");
      if (text.trim()) parts.push({ file: userFile, text });
    } catch {}
  }
  if (!parts.length) return null;

  let body = parts.map((p) => `# From ${p.file}\n\n${p.text.trim()}`).join("\n\n---\n\n");
  if (body.length > maxBytes) {
    body = `${body.slice(0, maxBytes)}\n\n...[memory truncated at ${maxBytes} chars]`;
  }
  return body;
}

/**
 * The memory file closest to cwd: the one /memory edits.
 *
 * Walking up matters because a project may keep its memory at the repo root
 * while the agent runs in a subdirectory. Editing has to land on the file the
 * agent actually reads, so this mirrors the search loadMemory does.
 *
 * @param {string} cwd
 * @returns {string|null}
 */
export function memoryFilePath(cwd = process.cwd()) {
  let dir = resolve(cwd);
  for (let depth = 0; depth < 12; depth++) {
    for (const name of MEMORY_FILES) {
      const file = join(dir, name);
      if (existsSync(file)) { return file; }
    }
    if (existsSync(join(dir, ".git"))) { break; }
    const parent = resolve(dir, "..");
    if (parent === dir) { break; }
    dir = parent;
  }
  // Nothing found yet: the natural place to create one is the working root.
  return join(resolve(cwd), MEMORY_FILES[0]);
}

/**
 * Write project memory.
 *
 * @param {string} text
 * @param {string} [cwd]
 * @returns {string} the file written
 */
export function saveMemory(text, cwd = process.cwd()) {
  const file = memoryFilePath(cwd);
  writeFileSync(file, String(text || ""), "utf8");
  return file;
}

/**
 * Append a line to project memory, creating the file if needed.
 *
 * Appending is the safe primitive: overwriting a memory file from a single
 * command would silently discard whatever was already there, and memory is
 * exactly the kind of content that accumulates.
 *
 * @param {string} text
 * @param {string} [cwd]
 * @returns {string} the file written
 */
export function appendMemory(text, cwd = process.cwd()) {
  const file = memoryFilePath(cwd);
  const line = String(text || "").trim();
  if (!line) { return file; }
  let existing = "";
  if (existsSync(file)) {
    try { existing = readFileSync(file, "utf8"); } catch { existing = ""; }
  }
  // Keep a blank line between entries so appended notes stay readable.
  const sep = existing.trim() ? "\n\n" : "";
  writeFileSync(file, existing.trimEnd() + sep + line + "\n", "utf8");
  return file;
}

