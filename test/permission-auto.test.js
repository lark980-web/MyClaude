/**
 * The permission gate, driven the way the agent drives it.
 *
 * Unit tests on isDestructiveCommand only prove the classifier works; what
 * matters is that auto mode actually asks before running something that can
 * wipe a tree. These tests call the real agent.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";

import { createAgent } from "../src/agent/runtime.js";

const HOME = mkdtempSync(join(process.env.TEMP || ".", "mc-perm-"));
process.env.MYCLAUDE_HOME = HOME;

/** A provider that never talks, so no network is needed. */
const provider = { async streamChat() { return { text: "", toolCalls: [] }; } };

async function agentIn(mode, permissions = {}) {
  const log = [];
  const ui = {
    streamText() {}, endStream() {}, info(m) { log.push("INFO:" + m); },
    warn(m) { log.push("WARN:" + m); }, error() {}, success() {},
    toolStart() {}, toolEnd() {},
    confirmTool: async (name, args) => { log.push("ASK:" + (args.command || name)); return true; },
  };
  const config = {
    provider: "openai", baseUrl: "http://127.0.0.1:1/v1", apiKey: "k",
    model: "qoder-cn/gfmodel", maxTokens: 100, temperature: 0,
    permissionMode: mode, maxTurns: 4, contextWindow: 100000,
    compactThreshold: 0.8, vision: true,
    permissions,
  };
  const agent = await createAgent({ provider, config, ui, sessionKey: "perm-" + mode });
  return { agent, log };
}

test("auto mode runs a routine command without asking", async () => {
  const { agent, log } = await agentIn("auto");
  const allowed = await agent.askPermission("Bash", { command: "npm test" });
  assert.equal(allowed, true);
  assert.deepEqual(log, [], "nothing was asked");
});

test("auto mode keeps its promise and does not ask by default", async () => {
  // Auto means "do not ask me". Changing that silently would break setups that
  // rely on it, so the stricter behaviour is opt-in.
  const { agent, log } = await agentIn("auto");
  const allowed = await agent.askPermission("Bash", { command: "rm -rf /" });
  assert.equal(allowed, true);
  assert.deepEqual(log, [], "nothing was asked");
});

test("auto mode asks before a destructive command when the user opted in", async () => {
  const { agent, log } = await agentIn("auto", { askOnDestructive: true });
  await agent.askPermission("Bash", { command: "rm -rf /" });
  assert.ok(log.some((l) => l.startsWith("ASK:")), "the user was asked");
  assert.ok(log.some((l) => l.includes("destructive")), "the reason was explained");
});

test("the opt-in does not change auto mode for routine commands", async () => {
  const { agent, log } = await agentIn("auto", { askOnDestructive: true });
  const allowed = await agent.askPermission("Bash", { command: "npm test" });
  assert.equal(allowed, true);
  assert.deepEqual(log, [], "a routine command still runs unattended");
});

test("fullAccess still runs anything", async () => {
  const { agent, log } = await agentIn("fullAccess");
  const allowed = await agent.askPermission("Bash", { command: "rm -rf /" });
  assert.equal(allowed, true);
  assert.deepEqual(log, [], "the explicit choice of fullAccess is honoured");
});

test("bypassPermissions also runs anything", async () => {
  const { agent, log } = await agentIn("bypassPermissions");
  const allowed = await agent.askPermission("Bash", { command: "rm -rf /" });
  assert.equal(allowed, true);
  assert.deepEqual(log, []);
});

test("plan mode still blocks Bash outright", async () => {
  const { agent, log } = await agentIn("plan");
  const allowed = await agent.askPermission("Bash", { command: "npm test" });
  assert.equal(allowed, false);
});

test("cleanup", () => {
  rmSync(HOME, { recursive: true, force: true });
});
