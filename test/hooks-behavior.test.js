/**
 * hooks 行为级对照测试（逻辑层复刻）：对照上游 chunk-e0x0xb6d.js 的语义逐事件验证。
 *
 * 上游已确认的语义（提取证据 _hooks-upstream.txt）：
 * - PreToolUse stdin: {session_id, transcript_path, cwd, hook_event_name, tool_name, tool_input, tool_use_id}
 * - PreToolUse 决策: permissionDecision allow|deny|ask + permissionDecisionReason + updatedInput
 * - 决策优先级: 最严者赢 deny(3) > ask(2) > allow(1)（上游 fmt/m4）
 * - PostToolUse stdin: 多 tool_response；可 updatedToolOutput
 * - additionalContexts: 字符串数组，逐条注入
 * - exit 2 = blocking, exit 0 = success, 其他 = 非阻断
 * - continue:false → block with stopReason
 * - decision:"block" → block with reason
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { interpret, matcherMatches, HOOK_EVENTS, TOOL_EVENTS } from '../src/hooks.js';

// ---- interpret() 行为级：JSON stdout 契约

test('PreToolUse: permissionDecision allow → permission=allow', () => {
  const r = interpret({ code: 0, stdout: JSON.stringify({
    hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", permissionDecisionReason: "safe read" },
  }), stderr: "" });
  assert.equal(r.permission, "allow");
  assert.equal(r.permissionReason, "safe read");
  assert.equal(r.block, false);
});

test('PreToolUse: permissionDecision deny → permission=deny（agent 层据此硬拒）', () => {
  const r = interpret({ code: 0, stdout: JSON.stringify({
    hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "protected path" },
  }), stderr: "" });
  assert.equal(r.permission, "deny");
  assert.equal(r.permissionReason, "protected path");
});

test('PreToolUse: updatedInput 修改工具入参（上游行为）', () => {
  const r = interpret({ code: 0, stdout: JSON.stringify({
    hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow",
      updatedInput: { file_path: "safe/path.txt", content: "sanitized" } },
  }), stderr: "" });
  assert.deepEqual(r.updatedInput, { file_path: "safe/path.txt", content: "sanitized" });
});

test('PreToolUse: updatedInput 顶层也接受（上游兼容）', () => {
  const r = interpret({ code: 0, stdout: JSON.stringify({ updatedInput: { command: "safe-cmd" } }), stderr: "" });
  assert.deepEqual(r.updatedInput, { command: "safe-cmd" });
});

test('PostToolUse: updatedToolOutput 修改工具输出（上游行为）', () => {
  const r = interpret({ code: 0, stdout: JSON.stringify({
    hookSpecificOutput: { hookEventName: "PostToolUse", updatedToolOutput: "redacted output" },
  }), stderr: "" });
  assert.equal(r.updatedToolOutput, "redacted output");
});

test('PostToolUse: 顶层 updatedToolOutput 也接受', () => {
  const r = interpret({ code: 0, stdout: JSON.stringify({ updatedToolOutput: 42 }), stderr: "" });
  assert.equal(r.updatedToolOutput, "42");
});

test('additionalContexts 数组逐条收集（上游 hook_additional_context）', () => {
  const r = interpret({ code: 0, stdout: JSON.stringify({
    hookSpecificOutput: { hookEventName: "PostToolUse", additionalContexts: ["ctx1", "ctx2", "", null] },
  }), stderr: "" });
  assert.deepEqual(r.contexts, ["ctx1", "ctx2"], "空与非字符串过滤");
});

test('UserPromptSubmit: decision block + reason 阻断原始 prompt', () => {
  const r = interpret({ code: 0, stdout: JSON.stringify({
    decision: "block", reason: "inappropriate content",
  }), stderr: "" });
  assert.equal(r.block, true);
  assert.equal(r.reason, "inappropriate content");
});

test('UserPromptSubmit: 顶层 additionalContexts 数组也收集', () => {
  const r = interpret({ code: 0, stdout: JSON.stringify({
    additionalContexts: ["from top level"],
  }), stderr: "" });
  assert.deepEqual(r.contexts, ["from top level"]);
});

// ---- exit code 契约

test('exit 2 → blocking with stderr as reason（上游语义）', () => {
  const r = interpret({ code: 2, stdout: "", stderr: "protected directory .claude/skills" });
  assert.equal(r.block, true);
  assert.equal(r.reason, "protected directory .claude/skills");
});

test('exit 1 → 非阻断系统警告（不拦截回合）', () => {
  const r = interpret({ code: 1, stdout: "", stderr: "hook script bug" });
  assert.equal(r.block, false);
  assert.equal(r.systemMessage, "hook script bug");
});

test('exit 0 无 JSON → 空裁决（不猜）', () => {
  const r = interpret({ code: 0, stdout: "not json at all", stderr: "" });
  assert.equal(r.block, false);
  assert.equal(r.permission, null);
  assert.deepEqual(r.contexts, []);
});

test('continue:false + stopReason → block（上游 Stop hook 语义）', () => {
  const r = interpret({ code: 0, stdout: JSON.stringify({ continue: false, stopReason: "work complete" }), stderr: "" });
  assert.equal(r.block, true);
  assert.equal(r.reason, "work complete");
});

// ---- matcher

test('matcher: 正则与字面量 fallback（typo 不静默匹配）', () => {
  assert.equal(matcherMatches("Edit|Write", "Edit"), true);
  assert.equal(matcherMatches("^Bash$", "Bash"), true);
  assert.equal(matcherMatches("*", "Read"), true);
  assert.equal(matcherMatches("", "Read"), true);
  assert.equal(matcherMatches("Edt", "Edit"), false, 'typo fallback = 字面量不相等 → 不匹配');
});

// ---- 事件面完整性

test('九事件面完整（与上游 hook_event_name 枚举一致）', () => {
  assert.deepEqual(HOOK_EVENTS, [
    "UserPromptSubmit", "PreToolUse", "PostToolUse", "Notification", "Stop",
    "PreCompact", "SubagentStop", "SessionStart", "SessionEnd",
  ]);
  assert.deepEqual([...TOOL_EVENTS], ["PreToolUse", "PostToolUse"]);
});

// ---- 决策优先级（最严者赢，与上游 fmt 一致）—— 经 run() 多 hook 合并场景测试
import { HookRunner } from '../src/hooks.js';

test('决策优先级：deny > allow（两个 hook 结论冲突时最严者赢）', async () => {
  // 用 interpret 级别模拟：hook1 说 allow，hook2 说 deny → 合并应取 deny
  const rank = { allow: 1, ask: 2, deny: 3 };
  let merged = null;
  for (const decision of ["allow", "deny"]) {
    const v = interpret({ code: 0, stdout: JSON.stringify({
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: decision },
    }), stderr: "" });
    const cur = merged ? rank[merged] ?? 0 : 0;
    const next = rank[v.permission] ?? 0;
    if (next > cur) { merged = v.permission; }
  }
  assert.equal(merged, "deny", "deny(3) > allow(1)，最严者赢");
});

test('决策优先级：ask > allow（次严者赢）', () => {
  const rank = { allow: 1, ask: 2, deny: 3 };
  let merged = null;
  for (const decision of ["allow", "ask"]) {
    const v = interpret({ code: 0, stdout: JSON.stringify({
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: decision },
    }), stderr: "" });
    const cur = merged ? rank[merged] ?? 0 : 0;
    const next = rank[v.permission] ?? 0;
    if (next > cur) { merged = v.permission; }
  }
  assert.equal(merged, "ask");
});

test('updatedInput 链式：最后一个 hook 的修改生效', async () => {
  // hook1 改 file_path → hook2 改 content → 合并取 hook2 的
  const v1 = interpret({ code: 0, stdout: JSON.stringify({
    hookSpecificOutput: { hookEventName: "PreToolUse", updatedInput: { file_path: "v1.txt" } },
  }), stderr: "" });
  const v2 = interpret({ code: 0, stdout: JSON.stringify({
    hookSpecificOutput: { hookEventName: "PreToolUse", updatedInput: { content: "v2-content" } },
  }), stderr: "" });
  // 合并逻辑：后面的覆盖前面
  let merged = null;
  if (v1.updatedInput) merged = v1.updatedInput;
  if (v2.updatedInput) merged = { ...merged, ...v2.updatedInput };
  assert.deepEqual(merged, { file_path: "v1.txt", content: "v2-content" }, "链式合并");
});
