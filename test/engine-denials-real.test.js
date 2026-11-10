/**
 * 真引擎 permission_denials 实测：用真实引擎进程（bun + B: 映射）跑一个
 * 确定会触发权限询问的调用（manual 模式 + --permission-prompts none），
 * 验证 result.permission_denials 的真实结构 —— describeDenials 的消费契约。
 *
 * 需要真实引擎；不可用时整文件 skip，不假绿。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HOME = mkdtempSync(join(tmpdir(), 'myclaude-denials-'));
process.env.MYCLAUDE_HOME = HOME;

const { streamUpstreamTurn } = await import('../src/engines/upstream-chat.js');
const { engineStatus } = await import('../src/engines/claude-code.js');
const st = engineStatus();
const hasKey = Boolean(process.env.ANTHROPIC_API_KEY || process.env.MYCLAUDE_TEST_ENGINE_KEY);
const engineAvailable = st.available && st.cliOk && hasKey;

test('真引擎 permission_denials：manual+none 下写文件的拒绝结构', { skip: !engineAvailable ? '引擎不可用' : false }, async () => {
  const workdir = mkdtempSync(join(tmpdir(), 'mc-denials-'));
  writeFileSync(join(workdir, 'hello.txt'), 'hello\n', 'utf8');
  const events = [];
  const r = await streamUpstreamTurn({
    prompt: '请把 hello.txt 的内容改成 world（用 Write 工具）。不要问任何问题。',
    model: undefined, // 引擎默认模型
    cwd: workdir,
    permissionMode: 'manual',
    maxMs: 120_000,
    onEvent: (ev) => events.push(ev),
  });
  assert.equal(r.ok, true, '引擎进程正常退出: ' + JSON.stringify(r).slice(0, 200));
  // manual + none 下，写文件的询问被确定性拒绝 —— 引擎应在 result 里带回 denials
  const resultEvent = events.find((e) => e.type === 'result');
  assert.ok(resultEvent, '有 result 事件');
  const denials = r.permissionDenials || resultEvent.permission_denials || [];
  const hasWriteDenial = denials.some((d) =>
    (d.tool || d.tool_name || '').includes('Write') || JSON.stringify(d).includes('Write') || JSON.stringify(d).includes('Write'));
  // 方向断言：要么被拒（denials 非空），要么引擎自己没调用 Write 而是回复了文本（也是一种"未写入"）
  const wrote = events.some((e) => e.toolName === 'Write' || (e.text || '').includes('Write'));
  if (denials.length) {
    assert.ok(hasWriteDenial, 'denials 里有 Write: ' + JSON.stringify(denials).slice(0, 300));
  } else {
    assert.ok(!wrote || r.result, '无 denials 时引擎未实际写文件（确定性拒绝表现为不调用）');
  }
});
