/**
 * Sub-agent definition files and the extra working directories.
 *
 * /agents and /add-dir both exist only to feed two consumers: the Task tool
 * accepts a .myclaude/agents definition as a subagent_type, and the system
 * prompt tells the model where the extra directories are.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadAgents } from "../src/skills.js";
import { createTaskTool } from "../src/agent/task-tool.js";
import { Agent } from "../src/agent/agent.js";

function makeUi() {
  return { streamText(){}, endStream(){}, info(){}, warn(){}, error(){}, success(){}, toolStart(){}, toolEnd(){}, confirmTool: async () => true };
}

test("loadAgents reads .myclaude/agents definitions", () => {
  const cwd = mkdtempSync(join(tmpdir(), "mc-agents-"));
  mkdirSync(join(cwd, ".myclaude", "agents"), { recursive: true });
  writeFileSync(join(cwd, ".myclaude", "agents", "reviewer.md"),
    "---\nname: reviewer\ndescription: reviews diffs\n---\nYou review code.");
  const agents = loadAgents(cwd);
  assert.equal(agents.length, 1);
  assert.equal(agents[0].name, "reviewer");
  assert.equal(agents[0].description, "reviews diffs");
  assert.match(agents[0].body, /You review code\./);
});

test("a missing agents directory yields an empty list", () => {
  assert.deepEqual(loadAgents(mkdtempSync(join(tmpdir(), "mc-agents2-"))), []);
});

test("Task accepts a defined agent type and briefs the sub-agent", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "mc-agents3-"));
  mkdirSync(join(cwd, ".myclaude", "agents"), { recursive: true });
  writeFileSync(join(cwd, ".myclaude", "agents", "reviewer.md"),
    "---\nname: reviewer\ndescription: reviews diffs\n---\nYou review code.");
  process.chdir(cwd);
  try {
    let seenPrompt = "";
    const provider = { async streamChat({ messages }) {
      seenPrompt = messages.map((m) => typeof m.content === "string" ? m.content : "").join("\n");
      return { text: "done", toolCalls: [] };
    } };
    const config = { provider: "openai", baseUrl: "http://x/v1", apiKey: "k", model: "m", maxTokens: 64, temperature: 0, permissionMode: "auto", maxTurns: 2, contextWindow: 100000, compactThreshold: 0.8, vision: true };
    const tool = createTaskTool({ provider, config, ui: makeUi() });
    const res = await tool.run({ description: "d", prompt: "review the diff", subagent_type: "reviewer" });
    assert.equal(res.ok, true, JSON.stringify(res).slice(0, 120));
    assert.match(seenPrompt, /You review code\./, "the definition briefs the sub-agent");
    assert.match(seenPrompt, /review the diff/);
  } finally { process.chdir(cwd); process.chdir(".."); }
});

test("an undefined agent type is refused with the known list", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "mc-agents4-"));
  mkdirSync(join(cwd, ".myclaude", "agents"), { recursive: true });
  process.chdir(cwd);
  try {
    const provider = { async streamChat() { return { text: "x", toolCalls: [] }; } };
    const config = { provider: "openai", baseUrl: "http://x/v1", apiKey: "k", model: "m", maxTokens: 64, temperature: 0, permissionMode: "auto", maxTurns: 2, contextWindow: 100000, compactThreshold: 0.8, vision: true };
    const tool = createTaskTool({ provider, config, ui: makeUi() });
    const res = await tool.run({ description: "d", prompt: "p", subagent_type: "nope" });
    assert.equal(res.ok, false);
    assert.match(res.content, /unknown subagent_type/);
  } finally { process.chdir(".."); }
});

test("additionalDirectories reach the system prompt", () => {
  const config = { provider: "openai", baseUrl: "http://x/v1", apiKey: "k", model: "m", maxTokens: 64, temperature: 0, permissionMode: "auto", maxTurns: 2, contextWindow: 100000, compactThreshold: 0.8, vision: true, additionalDirectories: ["E:/somewhere/else"] };
  const agent = new Agent({ provider: { async streamChat() {} }, config, ui: makeUi(), sessionKey: "t" });
  assert.match(agent.systemPrompt, /Additional working directories/);
  assert.match(agent.systemPrompt, /E:\/somewhere\/else/);
});
