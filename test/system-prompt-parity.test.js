import test from "node:test";
import assert from "node:assert/strict";
import { SYSTEM_PROMPT, AUTONOMY_SECTION } from "../src/agent/prompt.js";
import { Agent } from "../src/agent/agent.js";
import { toolSchemas } from "../src/tools/index.js";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";

test("system prompt follows the upstream six-section structure", () => {
  for (const h of ["# System", "# Doing tasks", "# Executing actions with care", "# Using your tools", "# Tone and style"]) {
    assert.ok(SYSTEM_PROMPT.includes(h), "missing section: " + h);
  }
  assert.match(SYSTEM_PROMPT, /^You are MyClaude/, "persona comes first, like upstream persona+intro");
  assert.ok(SYSTEM_PROMPT.includes("# Language"), "keeps the language rule");
  assert.ok(SYSTEM_PROMPT.includes("# Environment"), "keeps the environment block");
  assert.ok(SYSTEM_PROMPT.includes("# Delegating with Task"), "delegation guidance, adapted from the orchestrator prompt");
});

test("ground truth anchor: upstream v2-full prompt unchanged since R2 evaluation", () => {
  const p = "E:/WorkSpaces/Test09/claude-re-2.1.302/04-prompts/system-prompt-v2-full.md";
  if (!existsSync(p)) return; // upstream tree absent (e.g. CI) — anchor unverifiable, skip silently
  const h = createHash("sha256").update(readFileSync(p)).digest("hex").slice(0, 12);
  assert.equal(h, "030d9f7e4ed0", "upstream ground truth changed — re-run R2 evaluation (docs/prompt-gated-eval.md)");
});

test("gated-section evaluation table is complete (18 rows, no blanks)", () => {
  const p = new URL("../docs/prompt-gated-eval.md", import.meta.url);
  if (!existsSync(p)) return;
  const md = readFileSync(p, "utf8");
  const rows = md.match(/^\| \d+ \|/gm) || [];
  assert.equal(rows.length, 18, "eval table must have exactly 18 numbered rows, got " + rows.length);
  for (const verdict of ["迁移", "不迁移", "不可得"]) {
    assert.ok(md.includes(verdict), "verdict vocabulary present: " + verdict);
  }
  assert.ok(!/\| {5,}\|/.test(md), "eval table has blank cells");
});

test("prompt density in a band around the migrated upstream core", () => {
  assert.ok(SYSTEM_PROMPT.length >= 12000, "too thin: " + SYSTEM_PROMPT.length);
  assert.ok(SYSTEM_PROMPT.length <= 22000, "bloated: " + SYSTEM_PROMPT.length);
});

test("R3 migrated gated sections are present verbatim (upstream plain variants)", () => {
  const clauses = [
    ["task_continuity", "the approval covers it end to end"],
    ["act_dont_rederive", "Do not re-derive facts already established"],
    ["tool_param_json", "must be a single JSON value"],
    ["context_management", "you don't need to wrap up early or hand off mid-task"],
    ["delivering_work", "don't quietly narrow, widen, or transform"],
    ["pronouns", "never infer pronouns from a name"],
    ["overcorrection", "Avoid unnecessary or excessive self-correction"],
  ];
  for (const [name, clause] of clauses) {
    assert.ok(SYSTEM_PROMPT.includes(clause), "missing " + name + " clause: " + clause);
  }
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
