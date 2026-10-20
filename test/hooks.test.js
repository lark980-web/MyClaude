/**
 * Hook system tests.
 *
 * Hooks are real child processes reading JSON on stdin, so these exercise the
 * actual contract (exit codes, stdout JSON, stderr on block). Each hook body
 * lives in its own temp script file to keep quoting sane.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HookRunner, matcherMatches, interpret, HOOK_EVENTS } from "../src/hooks.js";
import { Agent } from "../src/agent/agent.js";
import { registerTools, readTool, writeTool } from "../src/tools/index.js";

registerTools([readTool, writeTool]);

const sandbox = mkdtempSync(join(tmpdir(), "mc-hooks-"));
let seq = 0;

/**
 * Write a hook as a Node script plus a .cmd wrapper, and return the wrapper.
 *
 * The wrapper is what makes this portable: it can reference node by absolute
 * path (so the suite does not depend on PATH) while the command the runner
 * executes stays a single token with no quoting to get wrong. cmd.exe is the
 * default Windows hook shell precisely because it forwards stdin to children.
 */
function script(body) {
  const n = seq++;
  const mjs = join(sandbox, "hook" + n + ".mjs");
  writeFileSync(mjs, "import fs from 'node:fs';\n" + body + "\n");
  const cmd = join(sandbox, "hook" + n + ".cmd");
  const Q = String.fromCharCode(34);
  const CR = String.fromCharCode(13, 10);
  writeFileSync(cmd, "@echo off" + CR + Q + process.execPath + Q + " " + Q + mjs + Q + CR);
  return cmd;
}

/** A hook body that reads the JSON payload from stdin. */
const READ_STDIN = "const payload = JSON.parse(fs.readFileSync(0, 'utf8'));\n";

/** Build a hook that writes an object to stdout, optionally using `payload`. */
function emit(objectExpression) {
  return script(READ_STDIN + "process.stdout.write(JSON.stringify(" + objectExpression + "))");
}

const DENY_VIA_STDERR = script("process.stderr.write('not allowed');process.exit(2)");
const BROKEN_HOOK = script("process.stderr.write('boom');process.exit(3)");
const HANGING_HOOK = script("setTimeout(() => {}, 30000)");
/* ------------------------------------------------------------------ units */

test("HOOK_EVENTS lists the supported events", () => {
  assert.deepEqual(HOOK_EVENTS, ["UserPromptSubmit", "PreToolUse", "PostToolUse", "Notification", "Stop"]);
});

test("matcherMatches: empty, star, regex and equality", () => {
  assert.equal(matcherMatches("", "Bash"), true);
  assert.equal(matcherMatches("*", "Bash"), true);
  assert.equal(matcherMatches("Bash", "Bash"), true);
  assert.equal(matcherMatches("Bash", "Read"), false);
  assert.equal(matcherMatches("Edit|Write", "Write"), true);
  assert.equal(matcherMatches("^Bash$", "Bash"), true);
  assert.equal(matcherMatches("^Bash$", "BashX"), false);
});

test("interpret maps exit codes to decisions", () => {
  assert.equal(interpret({ code: 0, stdout: "", stderr: "" }).block, false);
  assert.equal(interpret({ code: 2, stdout: "", stderr: "nope" }).block, true);
  assert.equal(interpret({ code: 2, stdout: "", stderr: "nope" }).reason, "nope");
  const broken = interpret({ code: 7, stdout: "", stderr: "crashed" });
  assert.equal(broken.block, false);
  assert.equal(broken.systemMessage, "crashed");
});

test("interpret reads the documented JSON shapes", () => {
  const deny = interpret({ code: 0, stdout: JSON.stringify({ hookSpecificOutput: { permissionDecision: "deny" } }), stderr: "" });
  assert.equal(deny.permission, "deny");
  const ctx = interpret({ code: 0, stdout: JSON.stringify({ hookSpecificOutput: { additionalContext: "extra" } }), stderr: "" });
  assert.equal(ctx.context, "extra");
  const stop = interpret({ code: 0, stdout: JSON.stringify({ continue: false, stopReason: "done here" }), stderr: "" });
  assert.equal(stop.block, true);
  assert.equal(stop.reason, "done here");
  const dec = interpret({ code: 0, stdout: JSON.stringify({ decision: "block", reason: "policy" }), stderr: "" });
  assert.equal(dec.block, true);
  assert.equal(dec.reason, "policy");
});

/* ----------------------------------------------------------------- runner */

test("HookRunner is a no-op with no configuration", async () => {
  const runner = new HookRunner({ config: {} });
  assert.equal(runner.has("PreToolUse", "Bash"), false);
  const out = await runner.run("PreToolUse", { tool_name: "Bash" });
  assert.equal(out.ran, 0);
  assert.equal(out.block, false);
});

test("a hook receives its payload on stdin", async () => {
  const command = emit("{ hookSpecificOutput: { additionalContext: 'tool=' + payload.tool_name } }");
  const runner = new HookRunner({ config: { hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command }] }] } } });
  const out = await runner.run("PreToolUse", { tool_name: "Bash", tool_input: { command: "ls" } });
  assert.equal(out.ran, 1);
  assert.match(out.context, /tool=Bash/);
});

test("exit code 2 blocks the action with the stderr reason", async () => {
  const runner = new HookRunner({ config: { hooks: { PreToolUse: [{ hooks: [{ type: "command", command: DENY_VIA_STDERR }] }] } } });
  const out = await runner.run("PreToolUse", { tool_name: "Write" });
  assert.equal(out.block, true);
  assert.match(out.reason, /not allowed/);
});

test("matcher limits which tools trigger a hook", async () => {
  const command = emit("{ hookSpecificOutput: { permissionDecision: 'deny' } }");
  const runner = new HookRunner({
    config: { hooks: { PreToolUse: [{ matcher: "^Write$", hooks: [{ type: "command", command }] }] } },
  });
  assert.equal(runner.has("PreToolUse", "Write"), true);
  assert.equal(runner.has("PreToolUse", "Read"), false);
  assert.equal((await runner.run("PreToolUse", { tool_name: "Read" })).permission, null);
  assert.equal((await runner.run("PreToolUse", { tool_name: "Write" })).permission, "deny");
});

test("a failing hook warns without blocking", async () => {
  const runner = new HookRunner({ config: { hooks: { Stop: [{ hooks: [{ type: "command", command: BROKEN_HOOK }] }] } } });
  const out = await runner.run("Stop", {});
  assert.equal(out.block, false);
  assert.match(out.systemMessage, /boom/);
});

test("a timing-out hook is killed rather than hanging the agent", async () => {
  const runner = new HookRunner({ config: { hookTimeoutMs: 800, hooks: { PreToolUse: [{ hooks: [{ type: "command", command: HANGING_HOOK }] }] } } });
  const started = Date.now();
  const out = await runner.run("PreToolUse", { tool_name: "Bash" });
  assert.ok(Date.now() - started < 10000, "returned promptly");
  assert.equal(out.ran, 1);
  assert.equal(out.block, false);
});

/* ------------------------------------------------------------ agent wiring */

function makeUi() {
  const log = { warn: [], info: [], toolStart: [] };
  return {
    log,
    streamText() {}, endStream() {}, success() {}, error() {},
    info: (m) => log.info.push(String(m)),
    warn: (m) => log.warn.push(String(m)),
    toolStart: (n) => log.toolStart.push(n),
    toolEnd() {},
    confirmTool: async () => true,
  };
}

function makeAgent(hooks, provider, permissionMode = "auto") {
  const config = { provider: "openai", baseUrl: "http://x/v1", apiKey: "k", model: "m",
    maxTokens: 100, temperature: 0, permissionMode, maxTurns: 4,
    contextWindow: 100000, compactThreshold: 0.8, vision: true, hooks };
  const ui = makeUi();
  const agent = new Agent({ provider, config, ui, tools: [] });
  return { agent, ui };
}

test("UserPromptSubmit can veto a turn before any model call", async () => {
  let called = 0;
  const provider = { async streamChat() { called++; return { text: "x", toolCalls: [] }; } };
  const block = script("process.stderr.write('policy says no');process.exit(2)");
  const { agent, ui } = makeAgent({ UserPromptSubmit: [{ hooks: [{ type: "command", command: block }] }] }, provider);
  const out = await agent.run("do something");
  assert.equal(out.blocked, true);
  assert.match(out.reason, /policy says no/);
  assert.equal(called, 0, "the model was never asked");
  assert.ok(ui.log.warn.some((w) => w.includes("prompt blocked")));
});

test("PreToolUse block skips the tool and reports the reason to the model", async () => {
  const provider = {
    async streamChat() {
      return { text: "", toolCalls: [{ id: "c1", name: "Write", arguments: { file_path: "nope.txt", content: "x" } }] };
    },
  };
  const block = script("process.stderr.write('blocked by hook');process.exit(2)");
  const { agent } = makeAgent({ PreToolUse: [{ matcher: "Write", hooks: [{ type: "command", command: block }] }] }, provider);
  await agent.run("write it");
  const toolMsg = agent.messages.find((m) => m.role === "tool");
  assert.match(toolMsg.content, /blocked by hook/);
  assert.ok(!/permission denied/.test(toolMsg.content), "permission prompt never ran");
});

test("PreToolUse allow bypasses a confirmTool that would deny", async () => {
  const provider = {
    async streamChat() {
      return { text: "", toolCalls: [{ id: "c1", name: "Write", arguments: { file_path: join(sandbox, "hooked.txt"), content: "hello" } }] };
    },
  };
  const command = emit("{ hookSpecificOutput: { permissionDecision: 'allow' } }");
  const ui = makeUi();
  ui.confirmTool = async () => false;   // the user would have said no
  const config = { provider: "openai", baseUrl: "http://x/v1", apiKey: "k", model: "m",
    maxTokens: 100, temperature: 0, permissionMode: "ask", maxTurns: 4,
    contextWindow: 100000, compactThreshold: 0.8, vision: true,
    hooks: { PreToolUse: [{ matcher: "Write", hooks: [{ type: "command", command }] }] } };
  const agent = new Agent({ provider, config, ui, tools: [] });
  await agent.run("write it");
  const toolMsg = agent.messages.find((m) => m.role === "tool");
  assert.ok(toolMsg && !/permission denied/.test(toolMsg.content), "hook approval was honoured");
});

test("PostToolUse context is injected after a tool result", async () => {
  const provider = {
    async streamChat() {
      return { text: "", toolCalls: [{ id: "c1", name: "Read", arguments: { file_path: "package.json" } }] };
    },
  };
  const command = emit("{ hookSpecificOutput: { additionalContext: 'lint says 2 issues' } }");
  const { agent } = makeAgent({ PostToolUse: [{ hooks: [{ type: "command", command }] }] }, provider);
  await agent.run("read it");
  assert.ok(agent.messages.some((m) => m.role === "user" && /lint says 2 issues/.test(String(m.content))));
});

test("Stop can extend the run once but not loop forever", async () => {
  let calls = 0;
  const provider = {
    async streamChat() {
      calls++;
      return { text: "answer " + calls, toolCalls: [] };
    },
  };
  const command = emit("{ continue: false, stopReason: 'run the tests' }");
  const { agent } = makeAgent({ Stop: [{ hooks: [{ type: "command", command }] }] }, provider);
  const out = await agent.run("go");
  assert.equal(calls, 2, "the Stop hook got exactly one extension");
  assert.equal(out.done, true);
});

test("cleanup", () => {
  rmSync(sandbox, { recursive: true, force: true });
  assert.equal(true, true);
});
