/**
 * Skills: reusable capabilities the model can pick up on its own.
 *
 * Unlike a command, which the user invokes by name, a skill is advertised to
 * the model through its description and used when the model judges it
 * relevant. Claude Code stores one directory per skill containing SKILL.md,
 * and that layout is mirrored here so skill files stay portable.
 *
 *   .myclaude/skills/review/SKILL.md          -> project skill "review"
 *   ~/.myclaude/skills/commit/SKILL.md        -> user skill "commit"
 *
 * Project skills override user skills of the same name.
 */
import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join, resolve, basename } from "node:path";
import { CONFIG_DIR } from "./config.js";
import { splitFrontMatter } from "./commands.js";
import { pluginComponentPaths } from "./plugins.js";

/** The only file name Claude recognises as a skill definition. */
const SKILL_FILE = "SKILL.md";

/** Directories scanned for skills, lowest precedence first. */
export function skillDirs(cwd = process.cwd()) {
  const dirs = [];
  const home = join(CONFIG_DIR, "skills");
  if (existsSync(home)) { dirs.push({ dir: home, scope: "user" }); }
  // Walk up so a monorepo root can provide skills too.
  let cur = resolve(cwd);
  for (let depth = 0; depth < 6 && cur; depth++) {
    const candidate = join(cur, ".myclaude", "skills");
    if (existsSync(candidate)) { dirs.push({ dir: candidate, scope: "project" }); }
    if (existsSync(join(cur, ".git"))) { break; }
    const parent = resolve(cur, "..");
    if (!parent || parent === cur) { break; }
    cur = parent;
  }
  // Plugins may ship skills; they come after the direct ones so a project
  // skill of the same name wins.
  try {
    for (const dir of pluginComponentPaths(cwd).skills) { dirs.push({ dir, scope: "plugin" }); }
  } catch {
    // A broken plugin must not stop the ordinary skills from loading.
  }
  return dirs;
}

/**
 * Load every skill visible from cwd.
 *
 * @returns {Array<{name: string, description: string, body: string, file: string,
 *   scope: string, allowedTools: string}>}
 */
export function loadSkills(cwd = process.cwd()) {
  const out = new Map();
  for (const { dir, scope } of skillDirs(cwd)) {
    let entries = [];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      // A skill is a directory; loose SKILL.md files are ignored so the
      // layout matches Claude and cannot be mistaken for stray notes.
      if (!entry.isDirectory()) { continue; }
      const skillDir = join(dir, entry.name);
      const file = join(skillDir, SKILL_FILE);
      try {
        if (!statSync(file).isFile()) { continue; }
      } catch { continue; }
      let text;
      try { text = readFileSync(file, "utf8"); } catch { continue; }
      const { front, body } = splitFrontMatter(text);
      const name = String(front.name || entry.name).toLowerCase();
      if (!name) { continue; }
      // Later (project) scopes overwrite earlier (user) ones.
      out.set(name, {
        name,
        description: front.description || firstLine(body) || "(no description)",
        allowedTools: front["allowed-tools"] || "",
        body: body.trim(),
        file,
        scope,
      });
    }
  }
  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** First meaningful line of a body, used when frontmatter omits a description. */
function firstLine(text) {
  const line = String(text || "")
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l && !l.startsWith("#"));
  return line ? line.slice(0, 100) : "";
}

/** Find one skill by name (case-insensitive), or null. */
export function findSkill(name, cwd = process.cwd()) {
  const key = String(name || "").toLowerCase();
  return loadSkills(cwd).find((s) => s.name === key) || null;
}

/**
 * One-line catalogue for the system prompt.
 *
 * The model only needs the name and description to decide whether a skill
 * applies; the body is loaded on demand so a large skill library does not
 * bloat every request.
 */
export function skillCatalogue(cwd = process.cwd()) {
  return loadSkills(cwd).map((s) => ({ name: s.name, description: s.description }));
}

/**
 * Sub-agent definition files: the .myclaude/agents counterpart of skills.
 *
 * Each agent is a markdown file with optional frontmatter (name, description)
 * and a body that becomes the operating instructions of that sub-agent type.
 * Files instead of a registry, so users can keep definitions in version
 * control alongside the project.
 *
 * @param {string} cwd
 * @returns {Array<{name: string, description: string, body: string, file: string}>}
 */
export function loadAgents(cwd = process.cwd()) {
  const dir = join(cwd, ".myclaude", "agents");
  const out = [];
  let entries = [];
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) { continue; }
    const file = join(dir, entry.name);
    let rawText = "";
    try { rawText = readFileSync(file, "utf8"); } catch { continue; }
    const fm = /^---[\r\n]([\s\S]*?)[\r\n]---[\r\n]?/.exec(rawText);
    const meta = {};
    if (fm) {
      for (const line of fm[1].split(/[\r\n]+/)) {
        const m = /^([\w-]+)\s*:\s*(.+)$/.exec(line.trim());
        if (m) { meta[m[1].toLowerCase()] = m[2].trim(); }
      }
    }
    const body = rawText.replace(/^---[\r\n][\s\S]*?[\r\n]---[\r\n]?/, "").trim();
    out.push({
      name: meta.name || entry.name.replace(/\.md$/, ""),
      description: meta.description || "",
      body,
      file,
    });
  }
  return out;
}
