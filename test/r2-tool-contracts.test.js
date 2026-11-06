import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.MYCLAUDE_HOME = process.env.MYCLAUDE_HOME || mkdtempSync(join(tmpdir(), "mc-r2-"));

const { UPSTREAM_TOOL_SCHEMAS, upstreamSchema, upstreamDescription } = await import("../src/tools/upstream-schemas.js");
const { enterPlanModeTool, skillTool, exitPlanModeTool } = await import("../src/tools/extended.js");
const { toolSchemas, registerTools } = await import("../src/tools/index.js");
const { EXTENDED_TOOLS } = await import("../src/tools/extended.js");
registerTools(EXTENDED_TOOLS); // 镜像 runtime.js 的注册，让 toolSchemas() 覆盖 extended 面
const { createResourceTools } = await import("../src/mcp/resource-tools.js");

test("R2 契约接入：17 个工具采用上游契约（含新 5 个）", () => {
  const names = Object.keys(UPSTREAM_TOOL_SCHEMAS.tools);
  for (const n of ["EnterPlanMode", "ExitPlanMode", "ListMcpResources", "ReadMcpResource", "Skill"]) {
    assert.ok(names.includes(n), n + " 已接入，实际: " + names.join(","));
  }
});

test("EnterPlanMode：上游空参数契约逐字 + 交互确认后切 plan 模式", async () => {
  assert.equal(upstreamDescription("EnterPlanMode"),
    "Requests permission to enter plan mode for complex tasks requiring exploration and design");
  assert.deepEqual(upstreamSchema("EnterPlanMode"), { type: "object", properties: {}, required: [], additionalProperties: false });
  assert.equal(enterPlanModeTool.description, upstreamDescription("EnterPlanMode"));
  assert.deepEqual(enterPlanModeTool.input_schema, upstreamSchema("EnterPlanMode"));

  // 非交互（无 presenter）→ 如实拒绝
  const r0 = await enterPlanModeTool.run({});
  assert.equal(r0.ok, false);
  assert.match(r0.content, /interactive session/);

  // 有 presenter 且批准 → modeController("plan")
  const { setQuestionPresenter, setModeController } = await import("../src/tools/extended.js");
  const modes = [];
  setModeController((m) => modes.push(m));
  setQuestionPresenter(async (qs) => ["Enter plan mode"]);
  const r1 = await enterPlanModeTool.run({});
  assert.equal(r1.ok, true);
  assert.match(r1.content, /entered plan mode/);
  assert.deepEqual(modes, ["plan"]);

  // 拒绝 → 不切
  setQuestionPresenter(async () => ["Stay"]);
  const r2 = await enterPlanModeTool.run({});
  assert.equal(r2.ok, false);
  assert.deepEqual(modes, ["plan"], "拒绝后不切模式");
  setQuestionPresenter(null);
  setModeController(null);
});

test("Skill：上游 {skill, args} 契约逐字 + findSkill 注入正文", async () => {
  assert.deepEqual(upstreamSchema("Skill").properties.skill,
    { type: "string", description: "The name of a skill from the available-skills list. Do not guess names." });
  assert.deepEqual(upstreamSchema("Skill").required, ["skill"]);

  // 未知名 → 列出可用项
  const bad = await skillTool.run({ skill: "no-such-skill-xyz" });
  assert.equal(bad.ok, false);
  assert.match(bad.content, /unknown skill/);

  // 真实技能（用户级：<MYCLAUDE_HOME>/skills/<名>/SKILL.md）→ 正文注入
  const home = process.env.MYCLAUDE_HOME;
  mkdirSync(join(home, "skills", "r2-probe"), { recursive: true });
  writeFileSync(join(home, "skills", "r2-probe", "SKILL.md"), "---\nname: r2-probe\ndescription: R2 探针技能\n---\n\n技能正文内容在这里。\n", "utf8");
  const good = await skillTool.run({ skill: "r2-probe", args: "some-arg" });
  assert.equal(good.ok, true, JSON.stringify(good));
  assert.match(good.content, /skill: r2-probe/);
  assert.match(good.content, /技能正文内容在这里/);
  assert.match(good.content, /\[skill args\]: some-arg/);
});

test("ExitPlanMode：merge 上游 allowedPrompts + 本地 plan 扩展别名", () => {
  // 叠加发生在 toolSchemas() 导出处（原始工具对象保留自研 schema 作 fallback）
  const merged = toolSchemas().find((t) => t.function.name === "ExitPlanMode");
  assert.ok(merged, "toolSchemas 导出包含 ExitPlanMode");
  assert.ok(merged.function.parameters.properties.allowedPrompts, "上游 allowedPrompts 已并入");
  assert.ok(merged.function.parameters.properties.plan, "本地 plan 扩展保留");
});

test("MCP 资源工具：上游契约逐字覆盖（server/server+uri）", () => {
  // 资源工具由 createResourceTools 动态创建、配置了 MCP 才注册 —— 这里注册到全局注册表验证叠加
  registerTools(createResourceTools({ allResources: () => [], readResource: async () => ({ ok: false, content: "" }) }));
  const list = toolSchemas().find((t) => t.function.name === "ListMcpResources");
  assert.ok(list, "ListMcpResources 在导出中");
  assert.deepEqual(list.function.parameters.properties.server,
    { type: "string", description: "Optional server name to filter resources by" });
  assert.match(list.function.description, /Lists available resources from configured MCP servers/);
  const read = toolSchemas().find((t) => t.function.name === "ReadMcpResource");
  assert.ok(read);
  assert.deepEqual(read.function.parameters.required, ["server", "uri"]);
});
