import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.MYCLAUDE_HOME = mkdtempSync(join(tmpdir(), 'myclaude-engperm-'));
process.env.MYCLAUDE_ENGINE_BUN = process.execPath;
process.env.MYCLAUDE_ENGINE_CLI = 'fake-cli';

const { buildEngineArgs, toEnginePermissionMode, describeDenials } = await import('../src/engines/claude-code.js');

after(() => { setTimeout(() => process.exit(0), 100).unref?.(); });

const modeOf = (args) => args[args.indexOf('--permission-mode') + 1];

// 权威模式集来自引擎自己的 --help:
//   --permission-mode <mode> (choices: "acceptEdits", "auto", "bypassPermissions", "manual", "dontAsk", "plan")
// 注意没有 "default" —— 旧代码把它当合法的，还把 ask/dontAsk 静默降级成了 acceptEdits。
test('every MyClaude mode maps to a real engine mode', () => {
  assert.equal(toEnginePermissionMode('ask'), 'manual', 'ask maps to the engine manual mode');
  assert.equal(toEnginePermissionMode('acceptEdits'), 'acceptEdits');
  assert.equal(toEnginePermissionMode('auto'), 'auto');
  assert.equal(toEnginePermissionMode('dontAsk'), 'dontAsk');
  assert.equal(toEnginePermissionMode('plan'), 'plan');
  assert.equal(toEnginePermissionMode('bypassPermissions'), 'bypassPermissions');
  assert.equal(toEnginePermissionMode('fullAccess'), 'bypassPermissions', 'MyClaude-only mode');
});

test('an unknown mode falls back to the safest one, never to a permissive one', () => {
  for (const bad of ['', null, undefined, 'default', 'yolo', 123]) {
    assert.equal(toEnginePermissionMode(bad), 'manual', JSON.stringify(bad) + ' must not open things up');
  }
});

test('the engine never receives a mode outside its own choices', () => {
  const allowed = new Set(['acceptEdits', 'auto', 'bypassPermissions', 'manual', 'dontAsk', 'plan']);
  for (const m of ['ask', 'acceptEdits', 'auto', 'dontAsk', 'plan', 'bypassPermissions', 'fullAccess', 'bogus']) {
    const got = modeOf(buildEngineArgs({ permissionMode: m }));
    assert.ok(allowed.has(got), m + ' produced an invalid engine mode: ' + got);
  }
});

// 引擎默认 --permission-prompts host: 它会把授权询问发给宿主，而 MyClaude 不实现该协议。
// 不显式设 none 询问会悬空; 设了之后「本来要问的」确定性被拒，并如实出现在
// result.permission_denials 里，由 describeDenials 讲给人听。
test('permission prompts are pinned to a deterministic answerer', () => {
  const args = buildEngineArgs({ permissionMode: 'ask' });
  assert.ok(args.includes('--permission-prompts'), 'must pin who answers prompts');
  assert.equal(args[args.indexOf('--permission-prompts') + 1], 'none');
});

test('additional directories are handed to the engine', () => {
  const none = buildEngineArgs({ permissionMode: 'auto' });
  assert.equal(none.includes('--add-dir'), false, 'no --add-dir when there are no extra dirs');
  const one = buildEngineArgs({ permissionMode: 'auto', additionalDirectories: ['E:\\work\\other'] });
  assert.ok(one.includes('--add-dir'));
  assert.equal(one[one.indexOf('--add-dir') + 1], 'E:\\work\\other');
  const two = buildEngineArgs({ permissionMode: 'auto', additionalDirectories: ['a', '', '  ', 'b'] });
  const i = two.indexOf('--add-dir');
  assert.deepEqual(two.slice(i + 1), ['a', 'b'], 'blank entries are dropped');
});

test('resume and model flags still work alongside the new ones', () => {
  const a = buildEngineArgs({ model: 'm/x', permissionMode: 'plan', resumeSessionId: 'sess-1', additionalDirectories: ['d'] });
  assert.equal(a[a.indexOf('--resume') + 1], 'sess-1');
  assert.equal(a[a.indexOf('--model') + 1], 'm/x');
  assert.equal(modeOf(a), 'plan');
  assert.equal(a[a.indexOf('--add-dir') + 1], 'd');
});

// 用户报「无法创建技能」: 上游把 .claude/skills|commands|agents 当硬保护目录
// (chunk-zvergrz0.js Ef()), print 模式下没人能授权 -> 静默失败。
// 这里保证失败被讲清楚，而不是只留一句「没装成」。
test('a denial inside the protected skill directory is explained with a way out', () => {
  const note = describeDenials(
    [{ tool_name: 'Write', tool_input: { file_path: 'E:\\p\\.claude\\skills\\beef\\SKILL.md' }, decision_reason: 'needs approval' }],
    { mode: 'manual' });
  assert.match(note, /拒绝了 1 次/);
  assert.match(note, /Write/);
  assert.match(note, /SKILL\.md/, 'the exact path must be shown');
  assert.match(note, /硬保护目录/, 'must name the real reason');
  assert.match(note, /全部放行/, 'must offer the first way out');
  assert.match(note, /add-dir/, 'must offer the second way out');
});

test('a denial outside the protected directory gets generic, honest advice', () => {
  const note = describeDenials([{ tool_name: 'Bash', tool_input: { command: 'rm -rf /tmp/x' } }], { mode: 'dontAsk' });
  assert.match(note, /Bash/);
  assert.match(note, /rm -rf/, 'the command is shown');
  assert.doesNotMatch(note, /硬保护目录/, 'must not claim the skill-directory reason');
  assert.match(note, /权限模式/, 'points at the mode');
});

test('no denials means no noise', () => {
  assert.equal(describeDenials([], { mode: 'auto' }), null);
  assert.equal(describeDenials(null), null);
  assert.equal(describeDenials(undefined), null);
});
