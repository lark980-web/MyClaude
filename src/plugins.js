/**
 * Plugins: a directory that bundles commands, agents, skills and hooks.
 *
 * The layout follows Claude Code, whose plugin manifest is plugin.json and
 * whose component directories are commands/, agents/, skills/, hooks/ and
 * lspServers/ (extracted from claude-src modules 1001-1003). A plugin is
 * therefore not a new kind of thing: it is a bundle of the things MyClaude
 * already knows how to load, plus the manifest that says which ones it
 * provides.
 *
 *   <plugin-root>/
 *     plugin.json          manifest
 *     commands/            slash commands
 *     skills/              skills, one directory each with SKILL.md
 *     hooks/               hook scripts
 *     agents/              agent definitions
 *
 * A plugin without a readable manifest is not loaded: a broken bundle must
 * not be able to inject half of its components.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve, basename } from "node:path";
import { CONFIG_DIR } from "./config.js";

/** The file that marks a directory as a plugin. */
export const PLUGIN_MANIFEST = "plugin.json";

/**
 * The component directories Claude looks for inside a plugin.
 *
 * Each one maps to something MyClaude already loads on its own, so a plugin
 * is a bundle rather than a new mechanism.
 */
export const PLUGIN_COMPONENT_DIRS = Object.freeze([
  "commands",
  "skills",
  "hooks",
  "agents",
  "lspServers",
]);

/**
 * Directories that are never scanned for components.
 *
 * These hold build output, dependencies or test fixtures, and treating them
 * as components would load files nobody meant to ship.
 */
export const PLUGIN_SKIP_DIRS = new Set([
  "node_modules",
  ".claude",
  ".git",
  "results",
  "mocks",
]);

/**
 * Why a plugin was not usable.
 *
 * These names match the codes Claude reports for a plugin that failed to
 * load, so the reason reads the same in both tools.
 */
export const PLUGIN_PROBLEM = Object.freeze({
  MANIFEST_INVALID: "manifest_invalid",
  DISABLED_BY_DEFAULT: "disabled_by_default",
  WILL_NOT_LOAD: "will_not_load",
});

/**
 * Read and check a plugin manifest.
 *
 * @param {string} root
 * @returns {{ok: true, manifest: object} | {ok: false, problem: string, reason: string}}
 */
export function readManifest(root) {
  const file = join(root, PLUGIN_MANIFEST);
  if (!existsSync(file)) {
    return {
      ok: false,
      problem: PLUGIN_PROBLEM.MANIFEST_INVALID,
      reason: "no " + PLUGIN_MANIFEST + " in " + root,
    };
  }
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    return {
      ok: false,
      problem: PLUGIN_PROBLEM.MANIFEST_INVALID,
      reason: PLUGIN_MANIFEST + " is not valid JSON: " + (e && e.message),
    };
  }
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    return {
      ok: false,
      problem: PLUGIN_PROBLEM.MANIFEST_INVALID,
      reason: PLUGIN_MANIFEST + " must contain an object",
    };
  }
  if (!manifest.name || typeof manifest.name !== "string") {
    return {
      ok: false,
      problem: PLUGIN_PROBLEM.MANIFEST_INVALID,
      reason: PLUGIN_MANIFEST + " has no name",
    };
  }
  return { ok: true, manifest };
}

/**
 * The component directories a plugin actually provides.
 *
 * @param {string} root
 * @returns {string[]}
 */
export function pluginComponents(root) {
  const out = [];
  for (const dir of PLUGIN_COMPONENT_DIRS) {
    const full = join(root, dir);
    try {
      if (existsSync(full) && statSync(full).isDirectory()) { out.push(dir); }
    } catch {
      // A directory that cannot be read is simply not a component.
    }
  }
  return out;
}

/**
 * Where plugins are looked for.
 *
 * A plugin is a directory with a manifest and component directories. The
 * user-level directory holds plugins the user installed; the project-level
 * one holds plugins a repository ships with its team.
 *
 * @param {string} cwd
 * @returns {Array<{dir: string, scope: string}>}
 */
export function pluginRoots(cwd = process.cwd()) {
  const out = [];
  const userDir = join(CONFIG_DIR, "plugins");
  if (existsSync(userDir)) { out.push({ dir: userDir, scope: "user" }); }
  // A project may ship its plugins in .myclaude/plugins, the same place it
  // keeps its commands and skills.
  let cur = resolve(cwd);
  for (let depth = 0; depth < 6 && cur; depth++) {
    const candidate = join(cur, ".myclaude", "plugins");
    if (existsSync(candidate)) { out.push({ dir: candidate, scope: "project" }); }
    if (existsSync(join(cur, ".git"))) { break; }
    const parent = resolve(cur, "..");
    if (!parent || parent === cur) { break; }
    cur = parent;
  }
  return out;
}

/**
 * Every plugin that can be loaded, with the reason when it cannot.
 *
 * A plugin whose manifest is broken is reported, not silently skipped: the
 * user needs to know their plugin is not doing anything.
 *
 * @param {string} cwd
 * @returns {Array<{name: string, root: string, scope: string, manifest: object, components: string[], problem: string|null, reason: string}>}
 */
export function loadPlugins(cwd = process.cwd()) {
  const out = [];
  for (const { dir, scope } of pluginRoots(cwd)) {
    let entries = [];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (!entry.isDirectory()) { continue; }
      if (PLUGIN_SKIP_DIRS.has(entry.name)) { continue; }
      const root = join(dir, entry.name);
      const read = readManifest(root);
      if (!read.ok) {
        out.push({
          name: entry.name,
          root,
          scope,
          manifest: {},
          components: [],
          problem: read.problem,
          reason: read.reason,
        });
        continue;
      }
      const manifest = read.manifest;
      const disabled = manifest.enabled === false;
      out.push({
        name: String(manifest.name || entry.name),
        root,
        scope,
        manifest,
        components: pluginComponents(root),
        problem: disabled ? PLUGIN_PROBLEM.DISABLED_BY_DEFAULT : null,
        reason: disabled ? "the manifest sets enabled to false" : "",
      });
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * The component directories of the plugins that are actually usable.
 *
 * The command, skill and hook loaders take these as extra search paths, so
 * a plugin contributes exactly what it ships.
 *
 * @param {string} cwd
 * @returns {{commands: string[], skills: string[], hooks: string[]}}
 */
export function pluginComponentPaths(cwd = process.cwd()) {
  const out = { commands: [], skills: [], hooks: [] };
  for (const plugin of loadPlugins(cwd)) {
    if (plugin.problem) { continue; }
    for (const dir of plugin.components) {
      if (dir === "commands") { out.commands.push(join(plugin.root, "commands")); }
      else if (dir === "skills") { out.skills.push(join(plugin.root, "skills")); }
      else if (dir === "hooks") { out.hooks.push(join(plugin.root, "hooks")); }
    }
  }
  return out;
}

/**
 * One line per plugin, for the /plugin listing.
 *
 * @param {string} cwd
 * @returns {string[]}
 */
export function pluginSummaries(cwd = process.cwd()) {
  return loadPlugins(cwd).map((p) => {
    const desc = p.manifest.description ? p.manifest.description : "";
    const comps = p.components.length ? p.components.join(",") : "no components";
    if (p.problem) {
      return `  ${p.name}  [${p.problem}] ${p.reason}`;
    }
    return `  ${p.name}  ${p.scope}  ${comps}${desc ? "  — " + desc : ""}`;
  });
}
