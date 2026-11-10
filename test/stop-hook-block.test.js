/**
 * Stop hook 阻断行为测试（逻辑层）：
 * 上游语义——Stop hook 可以阻止 agent 停止，把 reason 作为新上下文让 agent 继续工作。
 * 只允许一次（防止 hook 无限循环）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HOME = mkdtempSync(join(tmpdir(), 'myclaude-stopblock-'));
process.env.MYCLAUDE_HOME = HOME;
const { Agent } = await import('../src/agent/agent.js');

const makeAgent = (provider, config) => {
  const ui = { streamText(){}, endStream(){}, info(){}, warn(){}, error(){}, success(){}, toolStart(){}, toolEnd(){}, confirmTool: async () => true };
  return new Agent({ provider, config, ui, sessionKey: 'stop-block' });
};
const baseConfig = () => ({ provider: 'openai', baseUrl: 'http://x/v1', apiKey: 'k', model: 'm',
  maxTokens: 64, temperature: 0, permissionMode: 'auto', maxTurns: 10,
  contextWindow: 100000, vision: true });

test('Stop hook 阻断 → agent 继续工作（reason 作为新上下文），只阻断一次', async () => {
  let stopCount = 0;
  const provider = {
    callCount: 0,
    async streamChat() {
      this.callCount = (this.callCount || 0) + 1;
      return { text: '回复 ' + this.callCount, toolCalls: [] };
    },
  };
  const agent = makeAgent(provider, baseConfig());
  agent.hooks.has = (event) => event === 'Stop';
  agent.hooks.run = async (event, payload) => {
    if (event === 'Stop') {
      stopCount++;
      if (stopCount === 1) {
        return { block: true, reason: 'tests still failing', context: '', permission: null, systemMessage: '', contexts: [] };
      }
      return { block: false, reason: '', context: '', permission: null, systemMessage: '', contexts: [] };
    }
    return { block: false, reason: '', context: '', permission: null, systemMessage: '', contexts: [] };
  };
  // 运行一个回合 → Stop hook 阻止 → agent 继续工作
  const r = await agent.run('做一件事');
  // stopHookUsed 防循环：只阻断一次（上游语义），第二次回合不再调 Stop hook
  assert.equal(stopCount, 1, 'Stop hook 只触发一次（防循环）');
  // 最终回复
  assert.ok(r.text.includes('回复') || r.done, '回合完成');
  // reason 被注入为用户消息
  const hookMsg = agent.messages.find((m) => m.role === 'user' && m.content.startsWith('[hook]'));
  assert.ok(hookMsg, 'hook reason 注入为用户消息');
  assert.match(hookMsg.content, /tests still failing/, 'reason 内容正确');
});

test('Stop hook 只阻断一次（防 hook 无限循环）', async () => {
  const provider = { async streamChat() { return { text: 'always stopping', toolCalls: [] }; } };
  const agent = makeAgent(provider, baseConfig());
  let stopCount = 0;
  agent.hooks.has = (event) => event === 'Stop';
  agent.hooks.run = async (event) => {
    if (event === 'Stop') { stopCount++; return { block: true, reason: 'always block', context: '', permission: null, systemMessage: '', contexts: [] }; }
    return { block: false, reason: '', context: '', permission: null, systemMessage: '', contexts: [] };
  };
  await agent.run('一次');
  assert.equal(stopCount, 1, 'Stop hook 只触发一次（防循环）');
});

test('Stop hook 非阻断 → 正常结束', async () => {
  const provider = { async streamChat() { return { text: '正常结束', toolCalls: [] }; } };
  const agent = makeAgent(provider, baseConfig());
  agent.hooks.has = (event) => event === 'Stop';
  agent.hooks.run = async (event) => ({ block: false, reason: '', context: '', permission: null, systemMessage: '', contexts: [] });
  const r = await agent.run('正常任务');
  assert.ok(r.done, '正常结束');
  assert.match(r.text, /正常结束/, '最终回复正确');
});
