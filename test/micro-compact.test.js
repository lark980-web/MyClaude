/**
 * micro-compaction 行为测试：移除旧 tool_result 内容保留对话结构。
 * 上游语义：比全量压缩更轻——先移除旧 tool_result 正文（保留 tool_use/tool_result 对），
 * 只有 micro-compaction 后仍超阈值才做全量压缩。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HOME = mkdtempSync(join(tmpdir(), 'myclaude-micro-'));
process.env.MYCLAUDE_HOME = HOME;
const { Agent } = await import('../src/agent/agent.js');

const makeAgent = (config) => {
  const provider = { async streamChat() { return { text: 'ok', toolCalls: [] }; } };
  const ui = { streamText(){}, endStream(){}, info(){}, warn(){}, error(){}, success(){}, toolStart(){}, toolEnd(){}, confirmTool: async () => true };
  return new Agent({ provider, config, ui, sessionKey: 'micro' });
};
const cfg = () => ({ provider: 'openai', baseUrl: 'http://x/v1', apiKey: 'k', model: 'm',
  maxTokens: 64, temperature: 0, permissionMode: 'auto', maxTurns: 4,
  contextWindow: 100, compactThreshold: 0.5, vision: true });

test('microCompact: 旧 tool_result 正文替换为占位符，保留 tool_use/tool_result 对', () => {
  const agent = makeAgent(cfg());
  // 构造：5 轮工具链（10 条 tool_use/tool_result 消息）
  for (let i = 0; i < 5; i++) {
    agent.messages.push({ role: 'assistant', content: '', tool_calls: [{ id: `c${i}`, type: 'function', function: { name: 'Read', arguments: '{}' } }] });
    agent.messages.push({ role: 'tool', tool_call_id: `c${i}`, content: `tool output ${i} ${'x'.repeat(500)}` });
  }
  agent.messages.push({ role: 'user', content: '最后的问题' });

  const before = agent.messages.length;
  const freed = agent.microCompact();
  // 消息数量不变（结构保留，只是内容清了）
  assert.equal(agent.messages.length, before, '消息数量不变');
  assert.ok(freed > 0, `释放了字符（freed=${freed}）`);
  // 旧的 tool 消息被清了
  const toolMsgs = agent.messages.filter((m) => m.role === 'tool');
  const cleared = toolMsgs.filter((m) => m.content.includes('[tool output removed'));
  assert.ok(cleared.length > 0, '有 tool_result 被替换为占位符');
  // 最后一个 tool_result 保持完整（最近的上下文最相关）
  const lastTool = toolMsgs[toolMsgs.length - 1];
  assert.ok(lastTool.content.includes('tool output 4'), '最近的 tool_result 保持完整');
});

test('microCompact: 最近 N 个 tool_result 保持完整（可配置）', () => {
  const agent = makeAgent(cfg());
  for (let i = 0; i < 6; i++) {
    agent.messages.push({ role: 'assistant', content: '', tool_calls: [{ id: `c${i}`, type: 'function', function: { name: 'Bash', arguments: '{}' } }] });
    agent.messages.push({ role: 'tool', tool_call_id: `c${i}`, content: `result ${i} ${'y'.repeat(300)}` });
  }
  // microCompact 保留最近 2 个 tool_result
  const freed = agent.microCompact(2);
  const toolMsgs = agent.messages.filter((m) => m.role === 'tool');
  // 最后 2 个保持完整
  assert.ok(toolMsgs[toolMsgs.length - 1].content.includes('result 5'), '最近一个完整');
  assert.ok(toolMsgs[toolMsgs.length - 2].content.includes('result 4'), '倒数第二个完整');
  // 前面的被清了
  assert.ok(toolMsgs[0].content.includes('[tool output removed'), '旧的被清');
});

test('microCompact: 无 tool 消息时返回 0（无事可做）', () => {
  const agent = makeAgent(cfg());
  agent.messages = [
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: 'hi' },
  ];
  assert.equal(agent.microCompact(), 0, '无 tool 消息无事可做');
});

test('microCompact: 已清理的 tool_result 不重复清理', () => {
  const agent = makeAgent(cfg());
  for (let i = 0; i < 3; i++) {
    agent.messages.push({ role: 'assistant', content: '', tool_calls: [{ id: `c${i}`, type: 'function', function: { name: 'Read', arguments: '{}' } }] });
    agent.messages.push({ role: 'tool', tool_call_id: `c${i}`, content: `[tool output removed: 100 chars]` });
  }
  const freed = agent.microCompact();
  assert.equal(freed, 0, '已清理的不重复清理');
});
