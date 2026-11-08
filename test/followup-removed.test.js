/**
 * 追问卡移除锁 (followup removal lock).
 *
 * MyClaude 曾有一套「继续追问」卡：buildFollowupPrompts(rawText, bodyEl) 只看
 * 有没有 artifact / 代码块，就返回三套**写死文案**，与对话内容零关系；并在每个
 * 回合结束时由 renderFollowupForLastAnswer() 渲染到最后一条 AI 回复上。
 *
 * 上游 Claude Code 2.1.302 的 2429 个模块里没有这个功能（nextSteps /
 * suggestedFollowUp / suggestionChips、"what would you like to do next"、
 * "try asking|you could also ask" 三个定向探针全部 0 命中），所以它是本项目自己
 * 造的装饰性功能；且用户点写死的「展开说说实现方案和步骤」后会触发连续的
 * 「上一条回复只有思考过程、没有正文」补救轮。
 *
 * 本文件锁定移除结果：源码、样式、DOM 三处都不许再出现该功能，避免它被
 * 再次引入。功能已不存在，因此这些断言全部是**负面断言**。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname, extname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const APP = join(ROOT, "src", "ui", "web", "js", "app.js");
const CSS = join(ROOT, "src", "ui", "web", "css", "styles.css");

const app = readFileSync(APP, "utf8");
const css = readFileSync(CSS, "utf8");

/** 所有已经移除的标识符：函数名、DOM 类名、可见文案。 */
const REMOVED_SYMBOLS = [
  "buildFollowupPrompts",
  "renderFollowupForLastAnswer",
  "followup-row",
  "followup-head",
  "followup-head-label",
  "followup-head-en",
  "followup-head-rule",
  "followup-card",
  "fc-top",
  "fc-num",
  "fc-arrow",
  "fc-rule",
  "fc-title",
  "fc-desc",
];

test("app.js no longer defines or calls the follow-up machinery", () => {
  for (const sym of ["buildFollowupPrompts", "renderFollowupForLastAnswer"]) {
    assert.ok(!app.includes(sym), sym + " must be gone from app.js");
  }
  // 不再有用 followup 命名的 DOM 类
  assert.ok(!/followup/i.test(app), "app.js must contain no followup identifier");
  // 不再出现卡片式标记的英文组标
  assert.ok(!app.includes("FOLLOW-UPS"), "app.js must not render the FOLLOW-UPS label");
  assert.ok(!app.includes("继续追问"), "app.js must not render the 继续追问 label");
});

test("the hard-coded suggestion strings are gone too", () => {
  // 三套写死文案的代表句：任何一条回来都说明功能被重新引入。
  const canned = [
    "展开说说实现方案和步骤",
    "总结 3 个行动项和验证方法",
    "分析边界情况和替代方案",
    "补上边界情况的单元测试",
    "再优化一下视觉细节和配色",
  ];
  for (const s of canned) {
    assert.ok(!app.includes(s), "hard-coded suggestion must be gone: " + s);
  }
});

test("styles.css has no .followup-* / .fc-* rules left", () => {
  assert.ok(!/\.followup/i.test(css), "styles.css must contain no .followup rule");
  for (const sym of REMOVED_SYMBOLS) {
    assert.ok(!css.includes(sym), "styles.css must not mention " + sym);
  }
  // .fc-* 是一组短选择器，按词边界匹配，避免误伤同前缀的其它类名。
  assert.ok(!/(^|[\s,{])[.a-z-]*\bfc-(top|num|arrow|rule|title|desc)\b/m.test(css),
    "no .fc-* card rules may remain");
  assert.ok(!css.includes("--fc-min-h"), "the card height variable must be gone");
});

test("no other file in src/ui/web still references the removed feature", () => {
  // 只能盯住 Web UI 目录：仓库根上有 2.8GB apk 与 14.5GB mitm-logs，
  // 递归整仓扫描既慢又无意义。src/ui/assets.js 是 bundle-gui 的生成产物，
  // 由 Lead 重新打包后刷新，不在本测试的断言范围内。
  const hits = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) { walk(full); continue; }
      if (extname(full) !== ".js" && extname(full) !== ".css" && extname(full) !== ".html") { continue; }
      if (full === APP || full === CSS) { continue; }
      const text = readFileSync(full, "utf8");
      if (/followup|FOLLOW-UPS/i.test(text)) { hits.push(full); }
    }
  };
  walk(join(ROOT, "src", "ui", "web"));
  assert.deepEqual(hits, [], "no web UI file may reference followups: " + hits.join(", "));
});

test("the removed function is not reachable from the done handler", () => {
  // done 事件里原本紧跟着 renderFollowupForLastAnswer()；移除后该处只剩
  // 回合收束逻辑，必须确认没有留下悬空调用或残留注释。
  const doneAt = app.indexOf('if (ev.type === "done")');
  assert.ok(doneAt >= 0, "the done handler still exists");
  const doneBlock = app.slice(doneAt, doneAt + 1200);
  assert.ok(!/followup/i.test(doneBlock), "the done handler must not mention followups");
  assert.ok(!/renderFollowup/.test(doneBlock), "no dangling renderFollowup call in done");
});
