/**
 * 技能端到端行为测试（逻辑层）：上游 chunk-e0x0xb6d.js 的三个附件契约 —
 *   skill_listing  可用技能清单（system-reminder，变化时重发 = 热发现）
 *   skill_mention  消息里的 /技能名 → 提示模型调用 Skill 工具
 *   invoked_skills 压缩后重放已调用技能（指南不丢，但不重执行一次性动作）
 * 加上 Skill 工具本体（安装 = 落盘 <dir>/SKILL.md，调用 = 返回正文）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.MYCLAUDE_HOME = mkdtempSync(join(tmpdir(), "myclaude-skills-e2e-"));
// main.js 被 import 时会自动跑 CLI（TUI/单实例锁）—— 测试只当库用，跳过。
process.env.MYCLAUDE_SKIP_MAIN = "1";
const { Agent } = await import("../src/agent/agent.js");
const { skillTool, EXTENDED_TOOLS } = await import("../src/tools/extended.js");
const { registerTools } = await import("../src/tools/index.js");
// 生产路径是 runtime.createAgent 里注册扩展工具；测试直接用裸 Agent，手动注册。
registerTools([...EXTENDED_TOOLS]);
const { handleCommand } = await import("../src/main.js");

const makeUi = () => ({ streamText(){}, endStream(){}, info(){}, warn(){}, error(){}, success(){}, toolStart(){}, toolEnd(){}, confirmTool: async () => true });

function makeAgent(script) {
  const calls = [];
  const seenRequests = [];
  const provider = {
    async streamChat({ messages }) {
      calls.push(1);
      seenRequests.push(messages);
      const step = script[calls.length - 1] || { text: "done", toolCalls: [] };
      return typeof step === "function" ? step() : step;
    },
    async complete() { return { text: "早期对话摘要：用户测试技能重放。" }; },
  };
  const config = { provider: "openai", baseUrl: "http://x/v1", apiKey: "k", model: "m",
    maxTokens: 64, temperature: 0, permissionMode: "auto", maxTurns: 4,
    contextWindow: 60, compactThreshold: 0.8, vision: true };
  const agent = new Agent({ provider, config, ui: makeUi(), sessionKey: "skills-e2e" });
  return { agent, calls, seenRequests };
}

test("skill_listing：首个请求注入清单（元消息不落历史），未变不重发", async () => {
  const { agent, seenRequests } = makeAgent([{ text: "ok", toolCalls: [] }, { text: "ok2", toolCalls: [] }]);
  await agent.run("hello");
  // 元消息在上游 attachment 语义里随请求走：请求里能看到，历史里不落盘
  const withListing = seenRequests[0].filter((m) => String(m.content).includes("The following skills are available for use with the Skill tool:"));
  assert.equal(withListing.length, 1, "首轮请求注入一次");
  assert.ok(String(withListing[0].content).includes("- verify:"), "内置 verify 技能在清单里");
  assert.ok(!agent.messages.some((m) => String(m.content).includes("The following skills are available")), "不落历史（标题/计数不被污染）");
  const userReq = seenRequests[0].filter((m) => m.role === "user");
  assert.ok(String(userReq[0].content).includes("The following skills"), "清单在用户正文之前（上游附件顺序）");
  // 清单未变 → 不重发
  await agent.run("again");
  const second = seenRequests[1].filter((m) => String(m.content).includes("The following skills are available for use with the Skill tool:"));
  assert.equal(second.length, 0, "去重：不每回合重发");
});

test("skill_listing：技能集变化（热发现）→ 重新注入", async () => {
  const { agent, seenRequests } = makeAgent([{ text: "ok", toolCalls: [] }]);
  await agent.run("hello");
  agent._skillCatalogue = () => [{ name: "brand-new", description: "freshly installed" }];
  await agent.run("hello2");
  const listings = seenRequests[1].filter((m) => String(m.content).includes("brand-new: freshly installed"));
  assert.equal(listings.length, 1, "新技能出现 → 清单重发");
});

test("skill_mention：/技能名 出现在消息里 → 请求注入 Skill 工具提示", async () => {
  const { agent, seenRequests } = makeAgent([{ text: "ok", toolCalls: [] }]);
  await agent.run("请 /verify 一下改动");
  const mention = seenRequests[0].find((m) => m.role === "user" && String(m.content).includes('call the Skill tool with skill: "verify"'));
  assert.ok(mention, "skill_mention 提醒已注入");
  assert.match(String(mention.content), /If they only mention it, do not run it/, "上游逐字语义");
  assert.ok(!agent.messages.some((m) => String(m.content).includes("skill: \"verify\"")), "元消息不落历史");
});

test("skill_mention：未知斜杠词与路径不误报", () => {
  const { agent } = makeAgent([]);
  assert.deepEqual(agent.matchSkillMentions("看看 /tmp/foo 和 /etc/hosts"), [], "路径不误报");
  assert.deepEqual(agent.matchSkillMentions("什么都没有"), []);
  assert.equal(agent.matchSkillMentions("帮我 /verify 这个").length, 1, "已知技能命中");
});

test("Skill 工具：安装（落盘）→ 调用返回正文；未知名报可用清单", async () => {
  const root = mkdtempSync(join(tmpdir(), "skills-e2e-proj-"));
  const prevCwd = process.cwd();
  try {
    mkdirSync(join(root, ".myclaude", "skills", "deploy-helper"), { recursive: true });
    writeFileSync(join(root, ".myclaude", "skills", "deploy-helper", "SKILL.md"),
      "---\ndescription: Ship the release\n---\n1. run tests\n2. tag the commit\n", "utf8");
    process.chdir(root);
    const out = await skillTool.run({ skill: "deploy-helper", args: "v2.0" });
    assert.equal(out.ok, true);
    assert.match(out.content, /skill: deploy-helper — Ship the release/);
    assert.match(out.content, /1\. run tests/);
    assert.match(out.content, /\[skill args\]: v2\.0/, "参数透传");
    const bad = await skillTool.run({ skill: "no-such-skill" });
    assert.equal(bad.ok, false);
    assert.match(bad.content, /unknown skill: no-such-skill/);
    assert.match(bad.content, /deploy-helper/, "错误里列出可用技能");
  } finally {
    process.chdir(prevCwd);
    rmSync(root, { recursive: true, force: true });
  }
});

test("invoked_skills：Skill 调用被记录，压缩后重放且不重执行", async () => {
  const { agent } = makeAgent([
    { text: "", toolCalls: [{ id: "t1", name: "Skill", arguments: { skill: "verify" } }] },
    { text: "按照 verify 指南做完了", toolCalls: [] },
  ]);
  // 预置一段旧历史：keepRecent 边界要保住尾部 6 条，压缩得有可丢弃的中段
  agent.messages = [
    { role: "user", content: "早前的问题一，讨论了项目结构和目标。" },
    { role: "assistant", content: "早前的回答一，确定了技术选型与改动范围。" },
    { role: "user", content: "早前的问题二，讨论了部署方式。" },
    { role: "assistant", content: "早前的回答二，决定用容器化部署并记录了端口。" },
  ];
  // 10 token 的窗口 + 这条历史 → 必然触发压缩（压缩由消费方在 run 之后调用）
  const res = await agent.run("触发技能与压缩");
  assert.ok(res.done || res.maxTurnsReached);
  assert.equal((agent.invokedSkills || []).length, 1, "Skill 调用已记录");
  const compacted = await agent.maybeCompact();
  assert.ok(compacted, "小窗口下确实压缩了");
  const replay = agent.messages.find((m) => m.role === "user" && String(m.content).includes("invoked EARLIER in this session"));
  assert.ok(replay, "压缩后重放已调用技能");
  assert.match(String(replay?.content || ""), /### Skill: verify/, "技能体在重放里");
  assert.match(String(replay?.content || ""), /Do NOT re-execute/, "不重执行一次性动作");
  assert.equal((agent.invokedSkills || []).length, 0, "重放后清空，避免重复重放");
  assert.equal(agent._sentSkillListing, null, "压缩后清单去重重置（下一回合重发清单）");
});

test("handleCommand：/技能名 passthrough，未知命令报错", async () => {
  const ui = { info(){}, warn(m){ ui.warns.push(String(m)); }, warns: [], error(){}, success(){}, streamText(){}, endStream(){}, toolStart(){}, toolEnd(){}, confirmTool: async () => true };
  const { agent } = makeAgent([]);
  const ctx = { agent, config: {}, provider: {}, ui, pendingAttachments: [], autoSaver: null };
  const sk = await handleCommand("/verify", ctx);
  assert.equal(sk.passthrough, true, "内置技能名 → passthrough 给模型");
  const unk = await handleCommand("/definitely-not-a-cmd-xyz", ctx);
  assert.ok(!unk.passthrough, "未知命令不 passthrough");
  assert.ok(ui.warns.some((w) => w.includes("definitely-not-a-cmd-xyz")), "未知命令有提示");
});

test("/skills 命令：列出全部技能（含作用域）", async () => {
  const lines = [];
  const ui = { info(m){ lines.push(String(m)); }, warn(){}, error(){}, success(){}, streamText(){}, endStream(){}, toolStart(){}, toolEnd(){}, confirmTool: async () => true };
  const { agent } = makeAgent([]);
  await handleCommand("/skills", { agent, config: {}, provider: {}, ui, pendingAttachments: [], autoSaver: null });
  const out = lines.join("\n");
  assert.match(out, /verify/, "列出内置 verify");
  assert.match(out, /内置|builtin/, "标注作用域");
});
