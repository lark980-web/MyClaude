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

