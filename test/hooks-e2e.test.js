/**
 * hooks 端到端测试：真实 cmd shell + 真实 stdin/stdout JSON 契约。
 * Windows 下用 .cmd 脚本文件（路径不加引号，避免 cmd 引号陷阱）。
 * 注意：fs import 放文件尾部（cmd 脚本在 makeCmdHook 里同步写文件）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const { mkdtempSync, mkdirSync, writeFileSync, readFileSync } = await import('node:fs');
const { tmpdir } = await import('node:os');
const { join } = await import('node:path');

const HOME = mkdtempSync(join(tmpdir(), 'myclaude-hooke2e-'));
const { HookRunner } = await import('../src/hooks.js');

let scriptN = 0;
const makeCmdHook = (obj) => {
  scriptN++;
  const f = join(HOME, `hook-${scriptN}.cmd`);
  const json = JSON.stringify(obj);
  writeFileSync(f, `@echo off\r\necho ${json}\r\n`, 'utf8');
  return f;
};
const exit2Hook = () => {
  scriptN++;
  const f = join(HOME, `hook-exit2-${scriptN}.cmd`);
  writeFileSync(f, '@echo off\r\necho blocked by policy 1>&2\r\nexit /b 2\r\n', 'utf8');
  return f;
};
const timeoutHook = () => {
  scriptN++;
  const f = join(HOME, `hook-timeout-${scriptN}.cmd`);
  writeFileSync(f, '@echo off\r\nping -n 10 127.0.0.1 > nul 2>&1\r\n', 'utf8');
  return f;
};
const noMatchHook = () => {
  scriptN++;
  const f = join(HOME, `hook-nomatch-${scriptN}.cmd`);
  writeFileSync(f, '@echo off\r\necho should-not-run\r\n', 'utf8');
  return f;
};

const makeRunner = (hooksConfig, opts = {}) => new HookRunner({ config: { hooks: hooksConfig, hookShell: 'cmd', ...opts }, cwd: process.cwd() });

test('E2E: PreToolUse hook 阻断（exit 2 + stderr）', async () => {
  const runner = makeRunner({
    PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: exit2Hook() }] }],
  });
  const r = await runner.run('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'rm -rf /' } });
  assert.equal(r.block, true, 'exit 2 阻断');
  assert.match(r.reason, /blocked by policy/, 'stderr 作为 reason');
});

test('E2E: PreToolUse hook JSON stdout 放行', async () => {
  const runner = makeRunner({
    PreToolUse: [{ matcher: 'Read', hooks: [{ type: 'command', command: makeCmdHook({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', permissionDecisionReason: 'hook allow' },
    }) }] }],
  });
  const r = await runner.run('PreToolUse', { tool_name: 'Read', tool_input: { file_path: 'safe.txt' } });
  assert.equal(r.permission, 'allow', 'JSON 放行');
  assert.equal(r.permissionReason, 'hook allow', 'reason 传递');
});

test('E2E: PreToolUse hook updatedInput 修改工具入参', async () => {
  const runner = makeRunner({
    PreToolUse: [{ matcher: 'Write', hooks: [{ type: 'command', command: makeCmdHook({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', updatedInput: { content: 'hook modified' } },
    }) }] }],
  });
  const r = await runner.run('PreToolUse', { tool_name: 'Write', tool_input: { file_path: 'x.txt', content: 'original' } });
  assert.deepEqual(r.updatedInput, { content: 'hook modified' }, 'updatedInput 传递');
});

test('E2E: PostToolUse hook additionalContexts 注入', async () => {
  const runner = makeRunner({
    PostToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: makeCmdHook({
      hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContexts: ['lint result: 2 warnings'] },
    }) }] }],
  });
  const r = await runner.run('PostToolUse', { tool_name: 'Bash', tool_input: {}, tool_response: 'command output' });
  assert.deepEqual(r.contexts, ['lint result: 2 warnings'], 'additionalContexts 收集');
});

test('E2E: stdin JSON 契约（hook 收到完整事件载荷）', async () => {
  scriptN++;
  const captureFile = join(HOME, `captured-${scriptN}.json`);
  const script = join(HOME, `capture-${scriptN}.cmd`);
  writeFileSync(script, `@echo off\r\nnode -e "let b='';process.stdin.on('data',c=>b+=c);process.stdin.on('end',()=>{require('fs').writeFileSync('${captureFile.replace(/\\/g, '\\\\')}',b,'utf8');console.log(JSON.stringify({hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:'allow'}}))})"\r\n`, 'utf8');
  const runner = makeRunner({
    PreToolUse: [{ matcher: '', hooks: [{ type: 'command', command: script }] }],
  });
  const r = await runner.run('PreToolUse', { tool_name: 'TestTool', tool_input: { x: 1 }, tool_use_id: 't-123' });
  assert.equal(r.permission, 'allow', 'hook 正常运行');
  const captured = JSON.parse(readFileSync(captureFile, 'utf8'));
  assert.equal(captured.hook_event_name, 'PreToolUse', 'hook_event_name 正确');
  assert.equal(captured.tool_name, 'TestTool', 'tool_name 正确');
  assert.equal(captured.tool_use_id, 't-123', 'tool_use_id 传递');
  assert.ok(captured.tool_input, 'tool_input 存在');
});

test('E2E: 多 hook 合并 —— 最严者赢', async () => {
  const runner = makeRunner({
    PreToolUse: [
      { matcher: 'Bash', hooks: [{ type: 'command', command: makeCmdHook({
        hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' },
      }) }] },
      { matcher: 'Bash', hooks: [{ type: 'command', command: makeCmdHook({
        hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'second hook wins with deny' },
      }) }] },
    ],
  });
  const r = await runner.run('PreToolUse', { tool_name: 'Bash', tool_input: {} });
  assert.equal(r.permission, 'deny', 'deny 压过 allow（最严者赢）');
  assert.match(r.permissionReason, /second hook wins/, 'reason 来自最严裁决');
});

test('E2E: matcher 不匹配 → hook 不运行', async () => {
  const runner = makeRunner({
    PreToolUse: [{ matcher: 'Write', hooks: [{ type: 'command', command: noMatchHook() }] }],
  });
  const r = await runner.run('PreToolUse', { tool_name: 'Read', tool_input: {} });
  assert.equal(r.permission, null, 'matcher 不匹配 → hook 不运行');
  assert.equal(r.ran, 0, '0 个 hook 运行');
});

test('E2E: hook 超时 → 非阻断系统警告', async () => {
  const runner = makeRunner({
    PreToolUse: [{ matcher: '', hooks: [{ type: 'command', command: timeoutHook() }] }],
  });
  runner.timeoutMs = 1500;
  const r = await runner.run('PreToolUse', { tool_name: 'Bash', tool_input: {} });
  assert.equal(r.block, false, '超时不阻断');
  assert.ok(r.systemMessage.includes('timed out'), '超时警告可见');
});

test('E2E: UserPromptSubmit additionalContexts 注入', async () => {
  const runner = makeRunner({
    UserPromptSubmit: [{ matcher: '', hooks: [{ type: 'command', command: makeCmdHook({
      additionalContexts: ['injected by UserPromptSubmit hook'],
    }) }] }],
  });
  const r = await runner.run('UserPromptSubmit', { prompt: 'my question' });
  assert.deepEqual(r.contexts, ['injected by UserPromptSubmit hook'], '上下文注入');
});
test('E2E: Notification 事件 stdin 载荷用 snake_case notification_type（上游契约）', async () => {
  scriptN++;
  const captureFile = join(HOME, `notif-${scriptN}.json`);
  const script = join(HOME, `notif-${scriptN}.cmd`);
  const esc = captureFile.replace(/\\/g, '\\\\');
  writeFileSync(script, `@echo off\r\nnode -e "let b='';process.stdin.on('data',c=>b+=c);process.stdin.on('end',()=>{require('fs').writeFileSync('${esc}',b,'utf8')})"\r\n`, 'utf8');
  const runner = makeRunner({ Notification: [{ hooks: [{ type: 'command', command: script }] }] });
  const r = await runner.run('Notification', { message: 'needs confirmation: Write', notification_type: 'permission_request' });
  assert.equal(r.ran, 1, 'hook 运行');
  const captured = JSON.parse(readFileSync(captureFile, 'utf8'));
  assert.equal(captured.hook_event_name, 'Notification', 'hook_event_name 契约');
  assert.equal(captured.notification_type, 'permission_request', '上游契约：snake_case（chunk-e0x0b6d.js @3565860）');
  assert.equal(captured.notificationType, undefined, '不得回落到 camelCase');
  assert.equal(captured.message, 'needs confirmation: Write', 'message 透传');
});
test('E2E: hook 命令带引号路径（含空格）在 cmd 下可用 —— 回归：cmd /s 引号陷阱', async () => {
  // 上游/用户场景：hook 命令写带引号的绝对路径（路径含空格时必须引号）。此前 spawn 未经
  // windowsVerbatimArguments 传参，Node 会把内层引号转义成 \",cmd /s 剥首尾引号后 \",原样
  // 留在命令里 → 子进程收到带字面引号的路径 → MODULE_NOT_FOUND。
  scriptN++;
  const dirWithSpaces = join(HOME, 'dir with spaces');
  mkdirSync(dirWithSpaces, { recursive: true });
  const dumper = join(dirWithSpaces, `dump-${scriptN}.mjs`);
  writeFileSync(dumper, "import { writeFileSync } from 'node:fs';\nlet b = '';\nprocess.stdin.on('data', (c) => (b += c));\nprocess.stdin.on('end', () => writeFileSync(process.env.OUT_FILE, b));\n");
  const captureFile = join(HOME, `quoted-${scriptN}.json`);
  process.env.OUT_FILE = captureFile;
  const runner = makeRunner({ Notification: [{ hooks: [{ type: 'command', command: 'node "' + dumper + '"' }] }] });
  const r = await runner.run('Notification', { message: 'quoted path test', notification_type: 'permission_request' });
  delete process.env.OUT_FILE;
  assert.equal(r.ran, 1, 'hook 命令运行（带引号路径不再是 MODULE_NOT_FOUND）');
  const captured = JSON.parse(readFileSync(captureFile, 'utf8'));
  assert.equal(captured.hook_event_name, 'Notification', '子进程真正执行并收到 stdin 载荷');
  assert.equal(captured.notification_type, 'permission_request');
});
