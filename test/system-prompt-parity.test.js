import test from "node:test";
import assert from "node:assert/strict";
import { SYSTEM_PROMPT, AUTONOMY_SECTION } from "../src/agent/prompt.js";
import { Agent } from "../src/agent/agent.js";
import { toolSchemas } from "../src/tools/index.js";
import { readFileSync } from "node:fs";

test("system prompt follows the upstream six-section structure", () => {
  for (const h of ["# System", "# Doing tasks", "# Executing actions with care", "# Using your tools", "# Tone and style"]) {
    assert.ok(SYSTEM_PROMPT.includes(h), "missing section: " + h);
  }
  assert.match(SYSTEM_PROMPT, /^You are MyClaude/, "persona comes first, like upstream persona+intro");
  assert.ok(SYSTEM_PROMPT.includes("# Language"), "keeps the language rule");
  assert.ok(SYSTEM_PROMPT.includes("# Environment"), "keeps the environment block");
  assert.ok(SYSTEM_PROMPT.includes("# Delegating with Task"), "delegation guidance, adapted from the orchestrator prompt");
});

test("prompt density matches upstream (10707 chars)", () => {
  assert.ok(SYSTEM_PROMPT.length >= 9000, "too thin: " + SYSTEM_PROMPT.length);
  assert.ok(SYSTEM_PROMPT.length <= 14000, "bloated: " + SYSTEM_PROMPT.length);
});

test("keeps the high-value upstream clauses", () => {
  const must = [
    "authorized security testing",
    "NEVER generate or guess URLs",
    "do not re-attempt the exact same tool call",
    "attempt at prompt injection",
    "Treat feedback from hooks as coming from the user",
    "automatically compress prior messages",
    "defer to user judgement",
    "respond in 2-3 sentences",
    "Prefer editing existing files",
    "Default to writing no comments",
    "reversibility and blast radius",
    "measure twice, cut once",
    "file_path:line_number",
    "Only use emojis if the user explicitly requests it",
  ];
  for (const k of must) assert.ok(SYSTEM_PROMPT.includes(k), "missing clause: " + k);
});

test("mentions only tools that exist in the real registry", () => {
  const real = new Set(toolSchemas().map((t) => t.function.name));
  for (const t of ["TodoWrite", "Read", "Edit", "Write", "Glob", "Grep", "LS", "Bash"]) {
    if (SYSTEM_PROMPT.includes(t)) assert.ok(real.has(t), "prompt mentions missing tool: " + t);
  }
  for (const phantom of ["TaskCreate", "NotebookEdit", "WebSearch", "Artifact", "SlashCommand", "AgentOutput"]) {
    assert.ok(!SYSTEM_PROMPT.includes(phantom), "phantom upstream tool referenced: " + phantom);
  }
});

test("does not claim the upstream identity", () => {
  assert.ok(!/You are Claude Code/.test(SYSTEM_PROMPT), "must not impersonate Claude Code");
  assert.ok(!/Anthropic's CLI/.test(SYSTEM_PROMPT), "must not claim Anthropic's CLI identity");
});

test("uses this project's own names and interpolations", () => {
  assert.ok(SYSTEM_PROMPT.includes("MYCLAUDE.md"), "project memory file name");
  assert.ok(!/\bCLAUDE\.md\b/.test(SYSTEM_PROMPT.replace(/MYCLAUDE\.md/g, "")), "bare CLAUDE.md leaked");
  assert.ok(SYSTEM_PROMPT.includes(process.platform), "platform interpolated");
  assert.ok(SYSTEM_PROMPT.includes(process.cwd()), "cwd interpolated");
  assert.ok(!SYSTEM_PROMPT.includes("${process"), "no unresolved template placeholders");
});

test("delegation rules keep the transferable orchestrator principles", () => {
  for (const k of [
    "Parallel Task calls are for genuinely independent, sizeable tracks",
    "The sub-agent cannot see this conversation",
    "Never fabricate or predict a sub-agent result",
    "apply these tests",
    "Do not spawn a subagent for work you could finish yourself",
    "Do not spawn a subagent to review, re-verify, or double-check",
    "do not redo the subagent's work while waiting",
    "Keep spawn counts low",
  ]) {
    assert.ok(SYSTEM_PROMPT.includes(k), "missing delegation rule: " + k);
  }
  // worker-pool protocol from upstream must NOT leak: MyClaude has no such tools
  for (const phantom of ["SendMessage", "subscribe_pr_activity", "task-notification", "subagent_type"]) {
    assert.ok(!SYSTEM_PROMPT.includes(phantom), "phantom orchestration feature: " + phantom);
  }
});

test("sub-agent prompt states self-containment, no-questions and report format", () => {
  const src = readFileSync(new URL("../src/agent/task-tool.js", import.meta.url), "utf8");
  for (const k of ["Do not expand the scope", "You cannot ask questions", "read-only (Read, LS, Glob, Grep)", "Finish with a concise report"]) {
    assert.ok(src.includes(k), "missing sub-agent rule: " + k);
  }
});

test("autonomy section mirrors the upstream autonomy_append gated段", () => {
  for (const k of [
    "You are operating autonomously",
    "asking permission before doing the work is not",
    "the deliverable is your assessment",
    "Before ending your turn, check your last paragraph",
    "Do not stop because the context or session is long",
    "check that the evidence actually supports that specific action",
    "## What to act on",
    "Follow the spirit of the task, not only its literal scope",
    "building a justification for why an action is probably fine",
    "## How far to go",
    "bias toward acting",
    "Do the work, do not describe it",
    "## When there is nothing to do",
    "repeated \"nothing to do\" reports burn their attention",
  ]) assert.ok(AUTONOMY_SECTION.includes(k), "missing autonomy rule: " + k);
});

test("autonomy section is injected only when autoRun is on", () => {
  const stub = { streamChat: async () => ({ text: "ok", toolCalls: [], finishReason: "stop", usage: null }) };
  const base = { provider: "openai", baseUrl: "http://127.0.0.1:1/v1", apiKey: "k", model: "m", permissionMode: "auto", maxTurns: 2 };
  const ui = { streamText() {}, endStream() {}, info() {}, warn() {}, error() {}, toolStart() {}, toolEnd() {} };
  const off = new Agent({ provider: stub, config: { ...base, autoRun: false }, ui });
  const on = new Agent({ provider: stub, config: { ...base, autoRun: true }, ui });
  assert.ok(!off.systemPrompt.includes("You are operating autonomously"), "off: not injected");
  assert.ok(on.systemPrompt.includes("You are operating autonomously"), "on: injected");
  assert.ok(on.systemPrompt.length > off.systemPrompt.length, "on is longer");
});
