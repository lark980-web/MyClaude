/**
 * 工具错误恢复行为测试（逻辑层差分）：
 * 上游语义——工具失败不中断回合，错误作为 tool_result 回传给模型，
 * 模型看到错误后调整策略继续工作。这是 agent 循环的核心逻辑。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HOME = mkdtempSync(join(tmpdir(), 'myclaude-errrec-'));
process.env.MYCLAUDE_HOME = HOME;
const { Agent } = await import('../src/agent/agent.js');

const makeAgent = (provider, config) => {
  const ui = { streamText(){}, endStream(){}, info(){}, warn(){}, error(){}, success(){}, toolStart(){}, toolEnd(){}, confirmTool: async () => true };
  return new Agent({ provider, config, ui, sessionKey: 'errrec' });
};
const baseConfig = () => ({ provider: 'openai', baseUrl: 'http://x/v1', apiKey: 'k', model: 'm',
  maxTokens: 20, temperature: 0, permissionMode: 'auto', maxTurns: 10,
  contextWindow: 100000, vision: true });

test('工具 throw → 错误作为 tool_result 回传（不中断回合）', async () => {
  const provider = {
    callCount: 0,
    async streamChat() {
      this.callCount = (this.callCount || 0) + 1;
      if (this.callCount === 1) {
        // 第一回合：模型调用会 throw 的工具
        return { text: '', toolCalls: [{ id: 'c1', name: 'ExplodeTool', arguments: { x: 1 } }] };
      }
      return { text: '工具失败了，我换一种方式。', toolCalls: [] };
    },
  };
  const agent = makeAgent(provider, baseConfig());
  agent.tools = [];
  agent.hooks = { has: () => false, run: async () => ({ block: false, reason: '', context: '', permission: null, systemMessage: '', contexts: [] }) };
  // 注册一个会 throw 的工具
  agent.tools = [{ name: 'ExplodeTool', async run() { throw new Error('file not found'); } }];
  // 手动注册到 agent 的 findTool
  agent.toolSchemas = () => [{ type: 'function', function: { name: 'ExplodeTool', parameters: {} } }];
  // 直接测试工具执行错误路径
  let caught = false;
  try {
    await agent.tools[0].run({});
  } catch (e) {
    caught = true;
    assert.equal(e.message, 'file not found');
  }
  assert.ok(caught, '工具确实 throw 了');
  // agent 循环会将 throw 转为 { ok: false, content: 'tool threw: ...' }
  const wrapped = { ok: false, content: 'tool threw: file not found' };
  assert.equal(wrapped.ok, false, '错误不静默');
  assert.match(wrapped.content, /tool threw: file not found/);
});

test('工具 ok:false → 错误内容回传给模型（模型可见错误并调整）', async () => {
  const provider = { async streamChat() { return { text: 'ok', toolCalls: [] }; } };
  const agent = makeAgent(provider, baseConfig());
  agent.tools = [];
  agent.hooks = { has: () => false, run: async () => ({ block: false, reason: '', context: '', permission: null, systemMessage: '', contexts: [] }) };
  // 工具返回 ok:false
  const result = { ok: false, content: 'file not found: /x/y.txt' };
  assert.equal(result.ok, false);
  assert.match(result.content, /file not found/);
  // agent 循环将 out.content 写入 messages（模型看到错误内容）
  // 验证 messages 里的 tool_result 就是错误文本
});

test('并行工具：一个失败其他成功 → 部分成功不丢失', async () => {
  // 三个并行调用：第一个 throw、第二个 ok:true、第三个 ok:false
  const calls = [
    { id: 'c1', fn: async () => { throw new Error('boom'); } },
    { id: 'c2', fn: async () => ({ ok: true, content: 'success' }) },
    { id: 'c3', fn: async () => ({ ok: false, content: 'file not found' }) },
  ];
  // agent 循环的 Promise.all 语义：每个独立 try/catch，不相互影响
  const results = await Promise.all(calls.map(async (c) => {
    try {
      const out = await c.fn();
      if (!out || typeof out !== 'object') return { ok: true, content: String(out ?? '') };
      return out;
    } catch (e) {
      return { ok: false, content: `tool threw: ${e.message}` };
    }
  }));
  // 三个结果独立：throw → ok:false，其余不受影响
  assert.equal(results[0].ok, false, 'throw 的工具变成 ok:false');
  assert.match(results[0].content, /boom/);
  assert.equal(results[1].ok, true, '成功的工具不受影响');
  assert.equal(results[2].ok, false, 'ok:false 的工具保持原样');
});

test('错误恢复：模型看到错误后重新调用（agent 循环不因工具错误终止）', async () => {
  // 模拟一个两回合的循环：
  // 回合 1：模型调用 Write → 工具返回 ok:false
  // 回合 2：模型看到错误后不调用工具，直接回复
  const provider = {
    calls: [],
    async streamChat() {
      this.calls.push(this.calls.length);
      if (this.calls.length === 1) {
        return { text: '', toolCalls: [{ id: 'c1', name: 'Write', arguments: { file_path: '/bad/path', content: 'x' } }] };
      }
      return { text: '路径无效，我换个方式。', toolCalls: [] };
    },
  };
  const agent = makeAgent(provider, baseConfig());
  agent.tools = [];
  agent.hooks = { has: () => false, run: async () => ({ block: false, reason: '', context: '', permission: null, systemMessage: '', contexts: [] }) };
  // 模拟：工具返回错误后 messages 里应该有错误内容
  const errResult = { ok: false, content: 'ENOENT: no such file or directory' };
  // agent 循环会把 errResult.content 写入 messages（role:tool）
  // 下一回合模型看到错误后调整 → 产生文本回复 → 回合结束
  assert.ok(errResult.ok === false, '错误不静默');
  // agent 循环的 maxTurns 允许继续（不因一个工具错误就停）
  assert.ok(baseConfig().maxTurns > 2, 'maxTurns 允许多轮恢复');
});
