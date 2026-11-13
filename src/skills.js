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
import { readdirSync, readFileSync, existsSync, statSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve, basename } from "node:path";
import { CONFIG_DIR } from "./config.js";
import { splitFrontMatter } from "./commands.js";
import { pluginComponentPaths } from "./plugins.js";
import { BUILTIN_SKILLS } from "./skills-builtin.js";

/** The only file name Claude recognises as a skill definition. */
const SKILL_FILE = "SKILL.md";

/**
 * Directories scanned for skills, lowest precedence first.
 *
 * 两种布局同时读：MyClaude 自己的 `.myclaude/skills` 与上游 Claude Code 的
 * `.claude/skills`（原生引擎「原生 Claude」后端只认后者）。不兼容的后果：
 * GUI 建的技能上游引擎看不见、上游装的技能自研层看不见——用户主诉的
 * 「无法使用技能/无法创建技能」正是这个断层。
 */
export function skillDirs(cwd = process.cwd()) {
  const dirs = [];
  const home = join(CONFIG_DIR, "skills");
  // 用户级：~/.myclaude/skills/<名>/SKILL.md，优先级最低
  if (existsSync(home)) { dirs.push({ dir: home, scope: "user" }); }
  // 项目级只认「项目根」一处，不逐级向上爬：从 Temp 之类目录向上找，会把
  // ~/.myclaude/skills 误判成 project 技能，同一个技能被加载两次且作用域错误。
  const root = projectRootOf(cwd);
  // 上游 Claude Code 布局在前：同名时让 .myclaude（后扫）覆盖它
  const claudeCandidate = join(root, ".claude", "skills");
  if (existsSync(claudeCandidate)) { dirs.push({ dir: claudeCandidate, scope: "project" }); }
  const candidate = join(root, ".myclaude", "skills");
  if (existsSync(candidate) && resolve(candidate) !== resolve(home)) {
    dirs.push({ dir: candidate, scope: "project" });
  }
  // 插件也可能带技能；放在直读目录之后，让同名项目技能优先
  try {
    for (const dir of pluginComponentPaths(cwd).skills) { dirs.push({ dir, scope: "plugin" }); }
  } catch {
    // A broken plugin must not stop the ordinary skills from loading.
  }
  return dirs;
}

/**
 * 定位项目根：从 cwd 向上找到最近的 `.git`，找不到就用 cwd 本身。
 * 只用于把「项目级技能目录」钉在一个确定的位置，不会在每一层父目录都找技能。
 */
function projectRootOf(cwd) {
  let cur = resolve(cwd);
  for (let depth = 0; depth < 6; depth++) {
    if (existsSync(join(cur, ".git"))) { return cur; }
    const parent = resolve(cur, "..");
    if (!parent || parent === cur) { break; }
    cur = parent;
  }
  return resolve(cwd);
}

export function loadSkills(cwd = process.cwd(), opts = {}) {
  const out = new Map();
  const withBuiltin = opts.builtin !== false;
  // 内置技能先铺底：单文件 exe 里没有可读的 skills 目录，随包携带才能保证可用；
  // 磁盘上的用户级/项目级同名技能随后覆盖，用户总能替换内置版本。
  if (withBuiltin) {
    for (const b of BUILTIN_SKILLS) {
      out.set(b.name, { ...b, file: "(builtin)", scope: "builtin" });
    }
  }
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
 * Create (or, with overwrite, replace) a project-level skill.
 *
 * The GUI's skill manager and any script that "installs" a skill land here so
 * the layout always matches what loadSkills reads: one directory per skill
 * containing SKILL.md, under the project root — files stay portable and
 * version-controllable, the same way Claude Code stores them.
 *
 * @param {{cwd?: string, name: string, description?: string, body: string, overwrite?: boolean}} opts
 * @returns {{ok: true, file: string, name: string} | {ok: false, error: string}}
 */
export function createSkill({ cwd = process.cwd(), name, description = "", body = "", overwrite = false }) {
  // 名字规范化：空格转连字符、剔除非法字符 —— 用户输入「Bridge Skill」也能得到合法目录名
  const clean = String(name || "").trim().toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9_-]/g, "")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(clean)) {
    return { ok: false, error: "技能名只能用小写字母、数字、连字符或下划线（1-64 字符）" };
  }
  if (!String(body || "").trim()) { return { ok: false, error: "技能正文（SKILL.md 内容）不能为空" }; }
  const root = projectRootOf(cwd);
  // 双布局落盘：.myclaude/skills（自研层）+ .claude/skills（上游原生引擎）。
  // 只写一处，另一个引擎就看不见——「创建的技能用不了」的根源。
  const targets = [
    join(root, ".myclaude", "skills", clean),
    join(root, ".claude", "skills", clean),
  ];
  for (const dir of targets) {
    const file = join(dir, SKILL_FILE);
    if (!overwrite && existsSync(file)) {
      return { ok: false, error: "技能 " + clean + " 已存在 — 再次提交并勾选覆盖可更新它" };
    }
  }
  let written = null;
  try {
    const desc = String(description || "").replace(/\s*\r?\n\s*/g, " ").trim().slice(0, 200);
    const front = ["---", "name: " + clean, "description: " + desc, "---", ""].join("\n");
    const text = String(body).replace(/\r\n/g, "\n").trim();
    for (const dir of targets) {
      mkdirSync(dir, { recursive: true });
      const file = join(dir, SKILL_FILE);
      writeFileSync(file, front + "\n" + text + "\n", "utf8");
      if (!written) { written = file; }
    }
  } catch (err) {
    return { ok: false, error: "写入失败：" + (err && err.message ? err.message : err) };
  }
  return { ok: true, file: written, name: clean };
}

/**
 * Delete a user- or project-level skill directory by name. Plugin skills are
 * owned by their plugin and builtins live in code, so neither is touched.
 *
 * @returns {{ok: true, scope: string} | {ok: false, error: string}}
 */
export function deleteSkill(name, cwd = process.cwd()) {
  const clean = String(name || "").trim().toLowerCase();
  if (!clean) { return { ok: false, error: "缺少技能名" }; }
  let removed = null;
  for (const { dir, scope } of skillDirs(cwd)) {
    if (scope === "plugin") { continue; }
    const target = join(dir, clean);
    try {
      if (existsSync(join(target, SKILL_FILE))) {
        rmSync(target, { recursive: true, force: true });
        removed = scope;
      }
    } catch { /* 下一个候选 */ }
  }
  // 上游布局目录可能没进 skillDirs（不存在时被跳过）：按名直查一遍，
  // 保证「删除」对 .claude/skills 里的同名技能同样生效。
  const claudeTarget = join(projectRootOf(cwd), ".claude", "skills", clean);
  try {
    if (existsSync(join(claudeTarget, SKILL_FILE))) {
      rmSync(claudeTarget, { recursive: true, force: true });
      removed = removed || "project";
    }
  } catch { /* 已尽力 */ }
  return removed
    ? { ok: true, scope: removed }
    : { ok: false, error: "没有可删除的技能 " + clean + "（内置技能不可删除）" };
}

/**
 * One-line catalogue for the system prompt.
 *
 * The model only needs the name and description to decide whether a skill
 * applies; the body is loaded on demand so a large skill library does not
 * bloat every request.
 */
export function skillCatalogue(cwd = process.cwd(), opts = {}) {
  return loadSkills(cwd, opts).map((s) => ({ name: s.name, description: s.description }));
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
