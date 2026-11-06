/**
 * /output-style parity: built-in fragments, custom markdown styles, and the
 * agent-side system prompt injection.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "myclaude-os-"));
process.env.MYCLAUDE_HOME = home;
const { listOutputStyles, outputStyleFragment, BUILTIN_STYLES } = await import("../src/output-style.js");
const { Agent } = await import("../src/agent/agent.js");

test("built-in styles expose fragments; default is empty", () => {
  assert.equal(BUILTIN_STYLES.default.fragment, "");
  assert.match(outputStyleFragment("explanatory"), /Output style: Explanatory/);
  assert.match(outputStyleFragment("learning"), /TODO\(human\)/);
  assert.equal(outputStyleFragment("default"), "");
  assert.equal(outputStyleFragment("no-such-style"), "", "unknown style must degrade to empty, not throw");
});

test("R7: 上游四样式逐字接入（Proactive/Concise/Explanatory/Learning）", () => {
  // 2.1.302 内置五态：default(无片段) + 四个带正文的样式（chunk-e0x0xb6d.js l9）
  const names = Object.keys(BUILTIN_STYLES).sort();
  assert.deepEqual(names, ["concise", "default", "explanatory", "learning", "proactive"]);
  assert.match(outputStyleFragment("proactive"), /# Proactive Style Active/);
  assert.match(outputStyleFragment("proactive"), /Execute immediately/);
  assert.match(outputStyleFragment("concise"), /Lead with the result/);
  assert.match(outputStyleFragment("explanatory"), /Insights/);
  assert.match(outputStyleFragment("learning"), /Learn by Doing/);
  assert.match(outputStyleFragment("learning"), /TODO\(human\)/);
  // 描述词身份改写：不冒用 Claude（本地适配，见文件头注释）
  for (const n of ["proactive", "concise", "explanatory", "learning"]) {
    assert.ok(!/(^|\s)Claude\b/.test(BUILTIN_STYLES[n].description), n + " 描述词不单独引用 Claude（MyClaude 除外）");
  }
});

test("custom styles load from output-styles/<name>.md with frontmatter stripped", () => {
  const dir = join(home, "output-styles");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "concise-cn.md"), "---\nname: concise-cn\ndescription: 更简的中文输出\n---\n\n回答控制在三句话以内。");
  const list = listOutputStyles();
  assert.ok(list.some((s) => s.name === "concise-cn"), "custom style listed");
  const frag = outputStyleFragment("concise-cn");
  assert.match(frag, /回答控制在三句话以内/);
  assert.doesNotMatch(frag, /description:/, "frontmatter stripped");
});

test("agent.setOutputStyle rebuilds the system prompt", () => {
  const provider = { async streamChat() { return { text: "ok", toolCalls: [] }; } };
  const config = { provider: "openai", baseUrl: "http://x/v1", apiKey: "k", model: "m",
    maxTokens: 64, temperature: 0, permissionMode: "auto", maxTurns: 4,
    contextWindow: 100000, compactThreshold: 0.8, vision: true };
  const ui = { streamText(){}, endStream(){}, info(){}, warn(){}, error(){}, success(){}, toolStart(){}, toolEnd(){}, confirmTool: async () => true };
  const agent = new Agent({ provider, config, ui, sessionKey: "os" });
  const before = agent.systemPrompt;
  agent.setOutputStyle("explanatory");
  assert.notEqual(agent.systemPrompt, before, "prompt rebuilt");
  assert.match(agent.systemPrompt, /Output style: Explanatory/);
  agent.setOutputStyle("default");
  assert.doesNotMatch(agent.systemPrompt, /Output style:/);
});

