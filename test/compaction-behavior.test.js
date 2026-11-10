/**
 * 压缩行为测试（逻辑层）：阈值触发 + 边界保留 + 摘要/截断降级。
 * 用足够多的消息让 findKeepBoundary > 0，验证压缩真的发生。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'myclaude-comp-behavior-'));
process.env.MYCLAUDE_HOME = home;
const { Agent } = await import('../src/agent/agent.js');

const makeAgent = (provider, config) => {
  const ui = { streamText(){}, endStream(){}, info(){}, warn(){}, error(){}, success(){}, toolStart(){}, toolEnd(){}, confirmTool: async () => true };
  return new Agent({ provider, config, ui, sessionKey: 'comp-behavior' });
};

test('压缩：阈值触发 + 摘要替换旧历史 + 保留尾部', async () => {
  const provider = { async streamChat() { return { text: 'ok', toolCalls: [] }; } };
  const config = { provider: 'openai', baseUrl: 'http://x/v1', apiKey: 'k', model: 'm',
    maxTokens: 64, temperature: 0, permissionMode: 'auto', maxTurns: 4,
    contextWindow: 100, compactThreshold: 0.5, vision: true };
  const agent = makeAgent(provider, config);
  // mock router.complete 让摘要走通（provider 只有 streamChat，router 需要显式 complete）
  agent.router.complete = async () => ({ text: "压缩摘要：用户做了三件事，修改了两个文件，创建了一个测试脚本，运行了全部测试确认无回归，最终结论是通过。剩余工作已移交后续处理。" });
  // 10 条消息（want=6 → keepFrom>0 才有东西可压缩）
  for (let i = 0; i < 5; i++) {
    agent.messages.push({ role: 'user', content: 'q ' + i + ' ' + 'x'.repeat(60) });
    agent.messages.push({ role: 'assistant', content: 'a ' + i + ' ' + 'x'.repeat(60) });
  }
  const before = agent.messages.length;
  const r = await agent.maybeCompact();
  assert.ok(r, '压缩触发');
  assert.ok(r.dropped > 0, '有消息被移除');
  assert.equal(r.summarised, true, '摘要模式');
  assert.ok(agent.messages.length < before, '消息数减少');
  assert.match(agent.messages[0].content, /earlier conversation summarised/);
  assert.match(agent.messages[0].content, /压缩摘要/);
});

test('压缩：摘要失败降级为截断（不因 provider 崩而炸）', async () => {
  const provider = {
    async streamChat() { return { text: 'ok', toolCalls: [] }; },
    async complete() { throw new Error('provider down'); },
  };
  const config = { provider: 'openai', baseUrl: 'http://x/v1', apiKey: 'k', model: 'm',
    maxTokens: 64, temperature: 0, permissionMode: 'auto', maxTurns: 4,
    contextWindow: 100, compactThreshold: 0.5, vision: true };
  const agent = makeAgent(provider, config);
  for (let i = 0; i < 5; i++) {
    agent.messages.push({ role: 'user', content: 'q ' + i + ' ' + 'x'.repeat(60) });
    agent.messages.push({ role: 'assistant', content: 'a ' + i + ' ' + 'x'.repeat(60) });
  }
  const r = await agent.maybeCompact();
  assert.ok(r, '压缩触发');
  assert.equal(r.summarised, false, '摘要失败 → 截断降级');
  assert.match(agent.messages[0].content, /context compacted/);
});

test('压缩：PreCompact hook 可阻断', async () => {
  const provider = { async streamChat() { return { text: 'ok', toolCalls: [] }; } };
  const config = { provider: 'openai', baseUrl: 'http://x/v1', apiKey: 'k', model: 'm',
    maxTokens: 64, temperature: 0, permissionMode: 'auto', maxTurns: 4,
    contextWindow: 100, compactThreshold: 0.5, vision: true,
    hooks: { PreCompact: [{ matcher: '', hooks: [{ type: 'command', command: 'echo block' }] }] } };
  const agent = makeAgent(provider, config);
  // 覆盖 hooks.has 走阻断路径
  agent.hooks.has = () => true;
  agent.hooks.run = async () => ({ block: true, reason: 'no compaction allowed', systemMessage: '' });
  for (let i = 0; i < 5; i++) {
    agent.messages.push({ role: 'user', content: 'q ' + i + ' ' + 'x'.repeat(60) });
    agent.messages.push({ role: 'assistant', content: 'a ' + i + ' ' + 'x'.repeat(60) });
  }
  const r = await agent.maybeCompact();
  assert.equal(r, null, 'PreCompact 阻断 → 不压缩');
  assert.ok(agent.messages.length > 4, '历史未被修改');
});

test('压缩：turn boundary 保证保留尾部不以孤立 tool 开头', async () => {
  const provider = { async streamChat() { return { text: 'ok', toolCalls: [] }; } };
  const config = { provider: 'openai', baseUrl: 'http://x/v1', apiKey: 'k', model: 'm',
    maxTokens: 64, temperature: 0, permissionMode: 'auto', maxTurns: 4,
    contextWindow: 100, compactThreshold: 0.5, vision: true };
  const agent = makeAgent(provider, config);
  // 8 条正常对话 + 尾部追加 tool 消息对
  for (let i = 0; i < 5; i++) {
    agent.messages.push({ role: 'user', content: 'q ' + i + ' ' + 'x'.repeat(60) });
    agent.messages.push({ role: 'assistant', content: 'a ' + i + ' ' + 'x'.repeat(60) });
  }
  agent.messages.push({ role: 'tool', tool_call_id: 'c1', content: 'r' });
  agent.messages.push({ role: 'tool', tool_call_id: 'c2', content: 'r' });
  const r = await agent.maybeCompact();
  assert.ok(r, '压缩触发');
  // findKeepBoundary 保证保留尾部**首元素**不是 tool（上游 400 语义：悬空 tool_result 被拒）
  // opening 在 messages[0]，第一个保留消息在 messages[1]
  assert.ok(agent.messages.length > 1);
  assert.notEqual(agent.messages[1]?.role, 'tool', '保留尾部首元素不能是 tool（悬空 tool_result 上游 400）');
});
