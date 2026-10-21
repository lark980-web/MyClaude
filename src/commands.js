/**
 * Custom slash commands.
 *
 * A Markdown file under a `commands/` directory becomes a slash command:
 * the filename (minus extension) is the command name and the body is the
 * prompt sent to the model. `$ARGUMENTS` is replaced with whatever the user
 * typed after the command; a file with no placeholder gets the arguments
 * appended, so the common case needs no template syntax at all.
 *
 *   .myclaude/commands/review.md          -> /review
 *   ~/.myclaude/commands/commit.md        -> /commit
 *
 * Project commands override user commands of the same name.
 */
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, basename, resolve } from "node:path";
import { CONFIG_DIR } from "./config.js";
import { pluginComponentPaths } from "./plugins.js";

/**
 * The command directories that come from installed plugins.
 *
 * A plugin is a bundle, so its commands are ordinary commands that happen to
 * live in a plugin directory.
 *
 * @param {string} cwd
 * @returns {string[]}
 */
function pluginCommandDirs(cwd = process.cwd()) {
  try {
    return pluginComponentPaths(cwd).commands;
  } catch {
    // A broken plugin must not stop the ordinary commands from loading.
    return [];
  }
}

/** Directories scanned for command files, lowest precedence first. */
export function commandDirs(cwd = process.cwd()) {
  const dirs = [];
  const home = join(CONFIG_DIR, "commands");
  if (existsSync(home)) { dirs.push({ dir: home, scope: "user" }); }
  // Walk up from cwd so a monorepo root can also provide commands.
  let cur = resolve(cwd);
  for (let depth = 0; depth < 6 && cur; depth++) {
    const candidate = join(cur, ".myclaude", "commands");
    if (existsSync(candidate)) { dirs.push({ dir: candidate, scope: "project" }); }
    if (existsSync(join(cur, ".git"))) { break; }
    const parent = resolve(cur, "..");
    if (!parent || parent === cur) { break; }
    cur = parent;
  }
  // Plugins ship their own commands; they are searched after the direct ones
  // so a project command of the same name wins.
  for (const dir of pluginCommandDirs(cwd)) { dirs.push({ dir, scope: "plugin" }); }
  return dirs;
}

/**
 * Load every command definition visible from cwd.
 * @returns {Array<{name: string, description: string, body: string, file: string, scope: string}>}
 */
export function loadCommands(cwd = process.cwd()) {
  const out = new Map();
  for (const { dir, scope } of commandDirs(cwd)) {
    let entries = [];
    try { entries = readdirSync(dir); } catch { continue; }
    for (const file of entries) {
      if (!/\.mdx?$/i.test(file)) { continue; }
      const full = join(dir, file);
      let text;
      try {
        if (!statSync(full).isFile()) { continue; }
        text = readFileSync(full, "utf8");
      } catch { continue; }
      const name = basename(file).replace(/\.mdx?$/i, "").toLowerCase();
      if (!name) { continue; }
      const { front, body } = splitFrontMatter(text);
      // Later (project) scopes overwrite earlier (user) ones.
      out.set(name, {
        name,
        description: front.description || firstLine(body) || "自定义命令",
        argumentHint: front["argument-hint"] || "",
        model: front.model || "",
        allowedTools: front["allowed-tools"] || "",
        body: body.trim(),
        file: full,
        scope
      });
    }
  }
  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Pull the leading `---` YAML-ish block out of a command file. */
export function splitFrontMatter(text) {
  const lines = String(text || "").replace(/\r\n?/g, "\n").split("\n");
  if (lines[0]?.trim() !== "---") { return { front: {}, body: lines.join("\n") }; }
  const front = {};
  let i = 1;
  for (; i < lines.length; i++) {
    if (lines[i].trim() === "---") { i++; break; }
    const m = /^([\w-]+)\s*:\s*(.*)$/.exec(lines[i]);
    if (m) { front[m[1].toLowerCase()] = m[2].trim().replace(/^["']|["']$/g, ""); }
  }
  return { front, body: lines.slice(i).join("\n") };
}

function firstLine(text) {
  const line = String(text || "").split("\n").map((l) => l.trim()).find((l) => l && !l.startsWith("#"));
  return line ? line.slice(0, 100) : "";
}

/**
 * Expand a command body into the prompt to send.
 *
 * `$ARGUMENTS` (or `$1`..`$9` for positional use) is substituted; when the
 * template has no placeholder the arguments are appended so a plain prose
 * command still receives what the user typed.
 */
export function expandCommand(cmd, args = "") {
  const body = String(cmd.body || "");
  const value = String(args || "").trim();
  if (/\$ARGUMENTS?\b|\$\d/.test(body)) {
    return body
      .replace(/\$ARGUMENTS?/g, value)
      .replace(/\$(\d)/g, (_, n) => (value.split(/\s+/)[Number(n) - 1] || ""));
  }
  return value ? body + "\n\n" + value : body;
}

/** Find a command by name (case-insensitive), or null. */
export function findCommand(name, cwd = process.cwd()) {
  const n = String(name || "").toLowerCase();
  return loadCommands(cwd).find((c) => c.name === n) || null;
}

