/**
 * 技能：模型可自行取用的可复用能力。
 *
 * 命令由用户按名调用，技能则靠 description 被广告给模型、由模型自行判断
 * 是否适用。Claude Code 的布局是「一个技能一个目录，内含 SKILL.md」，
 * 这里照搬，技能文件因此可跨工具移植。
 *
 *   .myclaude/skills/review/SKILL.md          -> 项目级技能 "review"
 *   ~/.myclaude/skills/commit/SKILL.md        -> 用户级技能 "commit"
 *
 * 同名时项目级覆盖用户级。
 */
import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join, resolve, basename } from "node:path";
import { CONFIG_DIR } from "./config.js";
import { splitFrontMatter } from "./commands.js";
import { pluginComponentPaths } from "./plugins.js";

/** Claude 只认这一个文件名作为技能定义（claude-src 多处硬编码 "SKILL.md"）。 */
const SKILL_FILE = "SKILL.md";

/** 技能搜索目录，按优先级从低到高排列（后扫描的覆盖先扫描的）。 */
export function skillDirs(cwd = process.cwd()) {
  const dirs = [];
  const home = join(CONFIG_DIR, "skills");
  // 用户级：~/.myclaude/skills/<名>/SKILL.md，优先级最低
  if (existsSync(home)) { dirs.push({ dir: home, scope: "user" }); }
  // 项目级只认「项目根」一处：claude-src 的 chunk-j79ttfks.js 用
  // projectSettings 的 skills 路径 + 各附加目录拼 .claude/skills，
  // 并不存在逐级向上爬父目录的搜索。
  // 这里等价做法是定位 git 根（非仓库时退回 cwd），只在那一层找技能：
  // 无节制地向上爬会把 ~/.myclaude/skills 误判成 project 技能。
  const root = projectRootOf(cwd);
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
 *
 * 只用于把「项目级技能目录」钉在一个确定的位置，与 claude-src 里
 * projectSettings 给出单一 skills 路径的语义一致；它不会在每一层父目录
 * 都去找技能。
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

/**
 * 加载 cwd 可见的全部技能。
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
      // 技能必须是目录；散落的 SKILL.md 一律忽略 —— 既对齐 Claude 的布局，
      // 也避免把随手放的笔记误当成技能。
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
      // 后扫描的项目级覆盖先扫描的用户级同名技能
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

/** 正文首行，frontmatter 没写 description 时兜底用。 */
function firstLine(text) {
  const line = String(text || "")
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l && !l.startsWith("#"));
  return line ? line.slice(0, 100) : "";
}

/** 按名查找单个技能（大小写不敏感），找不到返回 null。 */
export function findSkill(name, cwd = process.cwd()) {
  const key = String(name || "").toLowerCase();
  return loadSkills(cwd).find((s) => s.name === key) || null;
}

/**
 * 供 system prompt 用的一行清单。
 *
 * 模型只需要 name 和 description 就能判断某个技能是否适用；正文按需加载，
 * 这样技能库再大也不会撑爆每次请求。
 * 对齐 claude-src 的 1369_unnamed.js：alwaysOn = 一行清单，onInvoke = 完整正文。
 */
export function skillCatalogue(cwd = process.cwd()) {
  return loadSkills(cwd).map((s) => ({ name: s.name, description: s.description }));
}

/**
 * 子代理定义文件：技能在 .myclaude/agents 下的对应物。
 *
 * 每个代理是一个 markdown 文件，可选 frontmatter（name、description），正文
 * 即该类型子代理的操作指令。用文件而非注册表，用户才能把定义和项目一起
 * 放进版本库。
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
