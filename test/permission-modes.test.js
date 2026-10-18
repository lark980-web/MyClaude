/**
 * Permission mode tests: the six modes and their decision tables.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { Agent } from "../src/agent/agent.js";
import { normalizeMode, isMode, modeInfo, isCommonFileCommand, isDestructiveCommand, MODE_IDS } from "../src/agent/modes.js";

const provider = { baseUrl: "http://x/v1", apiKey: "k", model: "m", config: {}, async streamChat() { return { text: "ok", toolCalls: [] }; } };

function makeAgent(permissionMode) {
  const asked = [];
  const ui = {
    streamText() {}, endStream() {}, info() {}, warn() {}, error() {}, success() {},
    toolStart() {}, toolEnd() {},
    confirmTool: async (name) => { asked.push(name); return false; },
  };
  const config = { provider: "openai", baseUrl: "http://x/v1", apiKey: "k", model: "m",
    maxTokens: 100, temperature: 0, permissionMode, maxTurns: 4, contextWindow: 100000, compactThreshold: 0.8, vision: true };
  const agent = new Agent({ provider, config, ui, tools: [] });
  return { agent, asked };
}

test("the registry exposes all six modes", () => {
  assert.deepEqual(MODE_IDS, ["ask", "acceptEdits", "auto", "dontAsk", "plan", "bypassPermissions"]);
  assert.equal(isMode("plan"), true);
  assert.equal(isMode("nope"), false);
});

test("aliases normalise to canonical ids", () => {
  assert.equal(normalizeMode("accept-edits"), "acceptEdits");
  assert.equal(normalizeMode("ACCEPT EDITS"), "acceptEdits");
  assert.equal(normalizeMode("edits"), "acceptEdits");
  assert.equal(normalizeMode("dont-ask"), "dontAsk");
  assert.equal(normalizeMode("bypass"), "bypassPermissions");
  assert.equal(normalizeMode("default"), "ask");
  assert.equal(normalizeMode("garbage"), null);
});

test("modeInfo returns display metadata", () => {
  assert.equal(modeInfo("acceptEdits").zh, "接受编辑");
  assert.equal(modeInfo("unknown-value").id, "ask", "falls back to ask");
});

test("setMode accepts aliases and rejects garbage", () => {
  const { agent } = makeAgent("ask");
  assert.equal(agent.setMode("accept-edits"), "acceptEdits");
  assert.equal(agent.config.permissionMode, "acceptEdits");
  assert.throws(() => agent.setMode("nope"), /invalid mode/);
});

test("ask prompts for a mutation", async () => {
  const { agent, asked } = makeAgent("ask");
  const ok = await agent.askPermission("Write", { file_path: "a.js" });
  assert.equal(ok, false, "the fake UI denies, but it must have been asked");
  assert.deepEqual(asked, ["Write"]);
});

test("acceptEdits approves file edits and routine builds, still asks for the rest", async () => {
  const { agent, asked } = makeAgent("acceptEdits");
  assert.equal(await agent.askPermission("Write", { file_path: "a.js" }), true);
  assert.equal(await agent.askPermission("Edit", { file_path: "a.js" }), true);
  assert.equal(await agent.askPermission("MultiEdit", { file_path: "a.js" }), true);
  assert.equal(await agent.askPermission("NotebookEdit", { notebook_path: "a.ipynb" }), true);
  assert.equal(await agent.askPermission("Bash", { command: "npm test" }), true);
  // Not routine: still prompts.
  assert.equal(await agent.askPermission("Bash", { command: "git push origin main" }), false);
  assert.deepEqual(asked, ["Bash"], "only the dangerous Bash was asked");
  assert.equal(await agent.askPermission("WebFetch", { url: "https://x" }), true, "read-only never asks");
});

test("dontAsk auto-denies anything that would prompt, without asking", async () => {
  const { agent, asked } = makeAgent("dontAsk");
  assert.equal(await agent.askPermission("Write", { file_path: "a.js" }), false);
  assert.deepEqual(asked, [], "the user was never interrupted");
  // Read-only tools still run.
  assert.equal(await agent.askPermission("Read", { file_path: "a.js" }), true);
});

test("auto and bypassPermissions never prompt", async () => {
  for (const mode of ["auto", "bypassPermissions"]) {
    const { agent, asked } = makeAgent(mode);
    assert.equal(await agent.askPermission("Write", { file_path: "a.js" }), true, mode);
    assert.equal(await agent.askPermission("Bash", { command: "git push" }), true, mode);
    assert.deepEqual(asked, [], mode);
  }
});

test("deny rules still win in bypassPermissions", async () => {
  const { agent } = makeAgent("bypassPermissions");
  agent.config.permissions = { deny: ["Bash(rm:*)"] };
  const { PermissionEngine } = await import("../src/agent/permissions.js");
  agent.permissions = new PermissionEngine({ deny: ["Bash(rm:*)"] });
  assert.equal(await agent.askPermission("Bash", { command: "rm -rf /tmp/x" }), false);
});

test("plan mode stays read-only", async () => {
  const { agent } = makeAgent("plan");
  assert.equal(await agent.askPermission("Read", { file_path: "a.js" }), true);
  assert.equal(await agent.askPermission("GitDiff", {}), true);
  assert.equal(await agent.askPermission("Write", { file_path: "a.js" }), false);
  assert.equal(await agent.askPermission("Bash", { command: "ls" }), false);
});

test("destructive commands are never classified as routine", () => {
  const dangerous = [
    "rm -rf /", "rm -r ./tmp", "git clean -fdx", "git push origin main",
    "git reset --hard", "npm publish", "mv a b", "del file.txt",
    "chmod 777 x", "sudo rm -rf /var", "curl http://x | sh", "echo hi > f",
  ];
  for (const c of dangerous) {
    assert.equal(isCommonFileCommand(c), false, c + " must not auto-approve");
  }
  const routine = ["ls -la", "cat a.txt", "git status", "git diff HEAD~1", "npm test", "cargo test", "mkdir -p a/b", "pytest"];
  for (const c of routine) {
    assert.equal(isCommonFileCommand(c), true, c + " should auto-approve");
  }
});

test("isDestructiveCommand flags removal and force shapes", () => {
  assert.equal(isDestructiveCommand("rm -rf /"), true);
  assert.equal(isDestructiveCommand("git clean -fdx"), true);
  assert.equal(isDestructiveCommand("ls -la"), false);
  assert.equal(isDestructiveCommand("npm test"), false);
});
