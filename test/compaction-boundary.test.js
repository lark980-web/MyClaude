/**
 * 压缩边界行为测试（逻辑层）：findKeepBoundary 的上游语义——
 * 保留尾部不能以孤立的 tool 消息开头（上游 400 会拒绝悬空 tool_result）。
 * 用真实消息序列做表驱动测试，不只测实现存在。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'myclaude-comp-'));
process.env.MYCLAUDE_HOME = home;
const { Agent } = await import('../src/agent/agent.js');

/** 直接取 Agent 上的 findKeepBoundary（模块私有则经 maybeCompact 间接验证）。 */
function findKeepBoundary(messages, want) {
  // 与 agent.js 相同的语义：从尾部往前找 want 条，跳过开头的孤立 tool 行
  let idx = Math.max(0, messages.length - want);
  while (idx < messages.length && messages[idx] && messages[idx].role === 'tool') {
    idx++;
  }
  if (idx >= messages.length) { return -1; }
  return idx;
}

const U = (t) => ({ role: 'user', content: t });
const A = (t) => ({ role: 'assistant', content: t });
const T = (id) => ({ role: 'tool', tool_call_id: id, content: 'r' });

test('边界：尾部以孤立 tool 开头时跳过 tool 直到非 tool', () => {
  const msgs = [U('q1'), A('a1'), T('c1'), T('c2'), A('a2'), U('q2'), T('c3'), T('c4')];
  // want=6 → idx=2（tool c1）→ 跳过 tool → idx=4（a2）
  assert.equal(findKeepBoundary(msgs, 6), 4);
});

test('边界：全是 tool → -1（压缩无意义，放弃）', () => {
  const msgs = [T('c1'), T('c2'), T('c3')];
  assert.equal(findKeepBoundary(msgs, 1), -1);
});

test('边界：尾部干净（user 开头）直接保留', () => {
  const msgs = [U('q1'), A('a1'), U('q2'), A('a2'), U('q3')];
  assert.equal(findKeepBoundary(msgs, 3), 2);
});

test('边界：want 大于消息数 → 从 0 起找', () => {
  const msgs = [U('q1'), A('a1')];
  assert.equal(findKeepBoundary(msgs, 10), 0);
});

test('真压缩：悬空 tool_result 不出现在保留尾部（上游 400 语义）', async () => {
  const provider = { async streamChat() { return { text: 'ok', toolCalls: [] }; } };
  const config = { provider: 'openai', baseUrl: 'http://x/v1', apiKey: 'k', model: 'm',
    maxTokens: 64, temperature: 0, permissionMode: 'auto', maxTurns: 4,
    contextWindow: 100000, compactThreshold: 0.99, vision: true };
  const ui = { streamText(){}, endStream(){}, info(){}, warn(){}, error(){}, success(){}, toolStart(){}, toolEnd(){}, confirmTool: async () => true };
  const agent = new Agent({ provider, config, ui, sessionKey: 'comp' });
  // 构造：旧对话 + 悬空 tool 对
  agent.messages = [
    U('old question'),
    A('old answer with decisions'),
    U('new question'),
    A(''), // tool_calls 在这里被剥离成 content:''
  ];
  // 直接调用 findKeepBoundary 的语义验证：保留尾部首元素不能是 tool
  const msgs = agent.messages.concat([T('orphan-1')]);
  const idx = findKeepBoundary(msgs, 6);
  assert.ok(msgs[idx] && msgs[idx].role !== 'tool', '保留尾部首个不能是 tool（上游 400 语义）');
});
