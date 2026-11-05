/**
 * 系统提示词体检：不看源码，只看真实组装出来的提示词。
 *
 * 为什么需要它：567 个测试全绿时，「同一份项目内存被加载两遍」仍然活了很久 ——
 * 没有任何测试去检查组装结果长什么样。读源码加断言只能证明「写了什么」，
 * 只有看真实输出才能证明「系统实际在做什么」。
 *
 * 用法：
 *   node scripts/inspect-prompt.mjs
 *   node scripts/inspect-prompt.mjs --json
 *   node scripts/inspect-prompt.mjs --dump out.txt
 *
 * 退出码：有 error 级发现时为 1，否则 0。
 */

import { writeFileSync } from "node:fs";
import { Agent } from "../src/agent/agent.js";
import { loadConfig } from "../src/config.js";
import { loadSkills } from "../src/skills.js";

const REQUIRED_SECTIONS = [
  "# System",
  "# Doing tasks",
  "# Executing actions with care",
  "# Using your tools",
  "# Tone and style",
  "# Environment",
];

const SIZE_BUDGET = 24000;

const STUB = { streamChat: async () => ({ text: "", toolCalls: [], finishReason: "stop", usage: null }) };
const QUIET_UI = { streamText() {}, endStream() {}, info() {}, warn() {}, error() {}, success() {}, toolStart() {}, toolEnd() {} };

export function buildPrompt({ autoRun = false } = {}) {
  const config = { ...loadConfig(), autoRun };
  const agent = new Agent({ provider: STUB, config, ui: QUIET_UI });
  return agent.systemPrompt;
}

function headingsOf(prompt) {
  return (prompt.match(/^# .+$/gm) || []).map((x) => x.trim());
}

export function auditPrompt(prompt, { autoRun = false, skills = [] } = {}) {
  const findings = [];
  const add = (level, code, message) => findings.push({ level, code, message });

  const memoryFiles = (prompt.match(/^# From (.+)$/gm) || []).map((x) => x.replace("# From ", "").trim());
  const memCount = new Map();
  for (const f of memoryFiles) {
    const key = f.toLowerCase();
    memCount.set(key, (memCount.get(key) || 0) + 1);
  }
  for (const [key, n] of memCount) {
    if (n > 1) add("error", "memory-duplicate", "项目内存被加载 " + n + " 次: " + key);
  }

  const heads = headingsOf(prompt);
  const headCount = new Map();
  // "# From <path>" 是内存文件的分隔符，不是真段落标题，两处检查都跳过它。
  const realHeads = heads.filter((h) => !h.startsWith("# From "));
  for (const h of realHeads) headCount.set(h, (headCount.get(h) || 0) + 1);
  for (const [h, n] of headCount) {
    if (n > 1) add("error", "section-duplicate", "段落出现 " + n + " 次: " + h);
  }

  for (const need of REQUIRED_SECTIONS) {
    if (!heads.includes(need)) add("error", "section-missing", "缺少必需段落: " + need);
  }

  const hasAutonomy = prompt.includes("You are operating autonomously");
  if (autoRun && !hasAutonomy) add("error", "autonomy-missing", "autoRun 已开启但缺少自主模式段");
  if (!autoRun && hasAutonomy) add("error", "autonomy-leak", "autoRun 已关闭却注入了自主模式段");

  const hasSkillsSection = heads.includes("# Available skills");
  if (skills.length > 0 && !hasSkillsSection) add("error", "skills-missing", "有 " + skills.length + " 个技能但没有 Available skills 段");
  if (skills.length === 0 && hasSkillsSection) add("warn", "skills-empty", "没有技能却输出了 Available skills 段");

  const lines = prompt.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (!/^# /.test(lines[i])) continue;
    if (lines[i].startsWith("# From ")) continue;
    let j = i + 1;
    while (j < lines.length && !lines[j].trim()) j++;
    if (j < lines.length && /^# /.test(lines[j])) add("warn", "section-empty", "空段: " + lines[i].trim());
  }

  if (prompt.length > SIZE_BUDGET) {
    add("warn", "size", "提示词 " + prompt.length + " 字符，超过预算 " + SIZE_BUDGET);
  }

  return findings;
}

export function inspect({ dump = null } = {}) {
  const skills = loadSkills().map((s) => s.name);
  const reports = [];
  for (const autoRun of [false, true]) {
    const prompt = buildPrompt({ autoRun });
    reports.push({
      autoRun,
      chars: prompt.length,
      sections: headingsOf(prompt).length,
      memoryFiles: (prompt.match(/^# From /gm) || []).length,
      findings: auditPrompt(prompt, { autoRun, skills }),
      prompt,
    });
  }
  if (dump) {
    writeFileSync(dump, reports.map((r) => "===== autoRun=" + r.autoRun + " (" + r.chars + " chars) =====\n\n" + r.prompt).join("\n\n"), "utf8");
  }
  const findings = reports.flatMap((r) => r.findings);
  return { reports, errors: findings.filter((f) => f.level === "error").length, findings };
}

const isMain = process.argv[1] && process.argv[1].replace(/\\/g, "/").endsWith("inspect-prompt.mjs");
if (isMain) {
  const di = process.argv.indexOf("--dump");
  const res = inspect({ dump: di > 0 ? process.argv[di + 1] : null });
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify({ reports: res.reports.map((r) => ({ autoRun: r.autoRun, chars: r.chars, sections: r.sections, memoryFiles: r.memoryFiles, findings: r.findings })), errors: res.errors }, null, 2));
  } else {
    for (const r of res.reports) {
      console.log("autoRun=" + r.autoRun + "  " + r.chars + " 字符  " + r.sections + " 段  内存文件 " + r.memoryFiles + " 个");
      for (const f of r.findings) console.log("  " + (f.level === "error" ? "ERROR" : "warn ") + "  [" + f.code + "] " + f.message);
      if (!r.findings.length) console.log("  ok   无异常");
    }
    console.log("");
    console.log("发现: " + res.errors + " 个 error");
  }
  process.exit(res.errors > 0 ? 1 : 0);
}
