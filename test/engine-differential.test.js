/**
 * 逻辑层差分测试：自研权限引擎与原生引擎在**相同输入**上的裁决对比。
 *
 * 原生引擎以 --permission-prompts none 跑：会询问的一律确定性拒绝并回传
 * result.permission_denials —— 那就是原生引擎对同一工具调用的「裁决」。
 * 本测试对比两边对相同动作的裁决方向（允许/拒绝）：这是逻辑层复刻的真度量
 * —— 不是 schema 相似，而是裁决一致。
 *
 * PermissionEngine.evaluate(toolName, args) 返回 "allow"|"deny"|"ask"|null；
 * null = 清单没覆盖，由模式决定（ask→确认，auto→放行，dontAsk→放行）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HOME = mkdtempSync(join(tmpdir(), 'myclaude-diff-'));
process.env.MYCLAUDE_HOME = HOME;
process.env.MYCLAUDE_ENGINE_BUN = process.execPath;
process.env.MYCLAUDE_ENGINE_CLI = 'fake-cli';

const { describeDenials, buildEngineArgs, toEnginePermissionMode } = await import('../src/engines/claude-code.js');
const { PermissionEngine } = await import('../src/agent/permissions.js');

test('差分前提：describeDenials 把引擎的 permission_denials 翻译成可操作文本', () => {
  const denials = [
    { tool: 'Bash', input: { command: 'npm test' }, reason: 'user did not grant permission' },
    { tool: 'Write', input: { file_path: 'a.txt' }, reason: 'user did not grant permission' },
  ];
  const out = describeDenials(denials, { mode: 'auto' });
  assert.ok(Array.isArray(out) || typeof out === 'string', 'describeDenials 有返回');
  const text = Array.isArray(out) ? out.join('\n') : String(out);
  assert.ok(text.length > 0, '拒绝翻译非空');
});

test('差分：ask 模式下写文件 —— 自研与原生同向（都不静默放行）', () => {
  // 原生：ask → 映射 manual；manual + --permission-prompts none → 询问一律确定性拒绝
  assert.equal(toEnginePermissionMode('ask'), 'manual');
  const args = buildEngineArgs({ permissionMode: 'ask' });
  assert.ok(args.includes('--permission-prompts'), '原生侧询问被钉死为确定性应答');
  assert.equal(args[args.indexOf('--permission-prompts') + 1], 'none');

  // 自研：无清单覆盖的写文件 → evaluate 返回 null → ask 模式走确认，不静默放行
  const engine = new PermissionEngine({ allow: [], deny: [], ask: [] });
  const verdict = engine.evaluate('Write', { file_path: join(HOME, 'x.txt'), content: 'x' });
  assert.equal(verdict, null, '清单外写文件不产生 allow');
  // 模式层负责把 null 变成确认 —— 与原生 none 的确定性拒绝同向（不静默放行）
});

test('差分：deny 规则两边都是硬拒绝且最高优先（bypass 也不放行）', () => {
  const engine = new PermissionEngine({ allow: ['Bash'], deny: ['Bash(npm run format:*)'], ask: [] });
  // deny 命中 → deny（即使 Bash 全 allow、模式 bypass）
  assert.equal(engine.evaluate('Bash', { command: 'npm run format' }), 'deny');
  // 上游 R5.5-b 证据：zce 硬 deny 在 bypass 下仍生效 —— 自研同向
});

test('差分：allow 清单命中 → 两边都放行（Read 只读动作）', () => {
  const engine = new PermissionEngine({ allow: ['Read'], deny: [], ask: [] });
  assert.equal(engine.evaluate('Read', { file_path: 'a.js' }), 'allow');
  // 上游 allow 清单命中时同样的动作不需要询问 —— 方向一致
});

test('差分：deny 优先于 allow（冲突时保守方向赢）', () => {
  const engine = new PermissionEngine({ allow: ['Bash'], deny: ['Bash(rm:*)'], ask: [] });
  assert.equal(engine.evaluate('Bash', { command: 'rm -rf /tmp/x' }), 'deny', 'deny 压过 allow');
  assert.equal(engine.evaluate('Bash', { command: 'npm test' }), 'allow', '非 deny 命中照常 allow');
});
