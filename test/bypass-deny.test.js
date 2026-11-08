import test from "node:test";
import assert from "node:assert/strict";
import { PermissionEngine } from "../src/agent/permissions.js";

// R5.5-b: upstream evaluates deny rules as hard blocks independent of mode;
// bypassPermissions only converts the residual ask/passthrough to allow.
// MyClaude must keep the same order: rule deny beats bypass mode.
test("deny rule blocks a call even under bypassPermissions (rule engine level)", () => {
  const engine = new PermissionEngine({ deny: ["Bash(rm -rf:*)"], allow: ["Bash(**)"] });
  assert.equal(engine.evaluate("Bash", { command: "rm -rf /tmp/x" }), "deny");
  assert.equal(engine.evaluate("Bash", { command: "ls" }), "allow");
});

test("askPermission evaluates deny before the bypass shortcut", async () => {
  const { Agent } = await import("../src/agent/agent.js");
  const warnings = [];
  const ui = { warn: (m) => warnings.push(m), confirmTool: async () => { throw new Error("must not prompt under bypass"); }, info() {}, error() {}, success() {}, streamText() {}, endStream() {}, toolStart() {}, toolEnd() {} };
  const agent = new Agent({
    provider: { async streamChat() { return { text: "", toolCalls: [] }; } },
    config: { provider: "openai", baseUrl: "http://x/v1", apiKey: "k", model: "m", maxTokens: 10, permissionMode: "bypassPermissions", maxTurns: 1, contextWindow: 1000, compactThreshold: 0.8 },
    ui, tools: [],
  });
  agent.permissions = new PermissionEngine({ deny: ["Bash(rm -rf:*)"] });
  const blocked = await agent.askPermission("Bash", { command: "rm -rf /" });
  assert.equal(blocked, false, "deny rule must block under bypassPermissions");
  assert.ok(warnings.some((w) => /denied by permission rule/.test(w)), "denial is surfaced");
  const allowed = await agent.askPermission("Bash", { command: "echo hi" });
  assert.equal(allowed, true, "non-denied call passes under bypass without prompting");
});
