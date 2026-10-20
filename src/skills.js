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
