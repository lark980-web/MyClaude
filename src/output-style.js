/**
 * Output styles (Claude Code parity for /output-style).
 *
 * "default" is the normal concise coding-agent voice. The built-in
 * alternatives reshape how the assistant communicates; custom styles are
 * markdown files in <CONFIG_DIR>/output-styles/<name>.md whose body is
 * appended to the system prompt under "# Output style".
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR } from "./config.js";

export const OUTPUT_STYLE_DIR = join(CONFIG_DIR, "output-styles");

export const BUILTIN_STYLES = {
  default: { label: "默认", description: "简洁的工程助手语气（Claude Code 默认）", fragment: "" },
  explanatory: {
    label: "解释型",
    description: "在完成任务的同时讲解实现思路与设计取舍",
    fragment: [
      "# Output style: Explanatory（解释型）",
      "",
      "在完成用户任务的同时，穿插简短的「实现说明」：",
      "- 关键改动后用 1-3 句话说明为什么这样设计、有哪些取舍；",
      "- 涉及不常见的技术决策时，给出该领域的惯例对比；",
      "- 保持讲解精炼，不要喧宾夺主——任务本身仍是第一优先级。",
    ].join("\n"),
  },
  learning: {
    label: "学习型",
    description: "协作式学习：小步实现，留出让你动手的部分",
    fragment: [
      "# Output style: Learning（学习型）",
      "",
      "以协作学习为目标工作：",
      "- 把任务拆成小步，每步先说明要做什么再动手；",
      "- 每完成一个阶段，留出 1 个有明确目标的练习点（用 TODO(human) 标记），让用户自己实现，并等待确认后再继续；",
      "- 不要一次写完所有代码——控制节奏，保证用户跟得上。",
    ].join("\n"),
  },
};

/** 列出可用风格：内置 + 自定义目录扫描。 */
export function listOutputStyles() {
  const list = Object.entries(BUILTIN_STYLES).map(([name, s]) => ({
    name, label: s.label, description: s.description, builtin: true,
  }));
  try {
    if (existsSync(OUTPUT_STYLE_DIR)) {
      for (const f of readdirSync(OUTPUT_STYLE_DIR)) {
        if (!f.endsWith(".md")) continue;
        const name = f.replace(/\.md$/, "");
        if (BUILTIN_STYLES[name]) continue;
        let desc = "";
        try {
          const body = readFileSync(join(OUTPUT_STYLE_DIR, f), "utf8");
          desc = (body.match(/^description:\s*(.+)$/m) || [, ""])[1] || body.split("\n").find((l) => l.trim() && !l.startsWith("#") && !l.startsWith("name:") && !l.startsWith("---")) || "";
        } catch {}
        list.push({ name, label: name, description: String(desc).trim(), builtin: false });
      }
    }
  } catch {}
  return list;
}

/** 取某风格的系统提示片段；未知/默认返回空串。 */
export function outputStyleFragment(name) {
  const key = String(name || "default").trim();
  if (!key || key === "default") return "";
  if (BUILTIN_STYLES[key]) return BUILTIN_STYLES[key].fragment;
  const file = join(OUTPUT_STYLE_DIR, key + ".md");
  if (existsSync(file)) {
    try {
      // 自定义文件允许 frontmatter：去掉 --- 包裹的头。
      const body = readFileSync(file, "utf8").replace(/^---[\s\S]*?---\s*/, "");
      return "# Output style: " + key + "\n\n" + body.trim();
    } catch {}
  }
  return "";
}
