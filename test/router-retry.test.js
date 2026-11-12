/**
 * 同候选退避重试（逻辑层）：上游对 429/5xx/断流先在同一端点做指数退避重试，
 * 重试耗尽才走 fallback 切换。单 provider 配置下一次瞬时抖动就把整轮任务
 * 打死（"任务中断"主诉）—— 现在同候选先重试，且退避等待受 failover 预算约束。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.MYCLAUDE_HOME = mkdtempSync(join(tmpdir(), 'myclaude-router-retry-'));
const { ProviderRouter } = await import('../src/providers/router.js');

test('同候选重试：两次 429 后成功，不切换、onRetry 通知', async () => {
  const calls = [];
  const provider = {
    model: 'primary',
    async streamChat() {
      calls.push(1);
      if (calls.length <= 2) {
        const e = new Error('429 too many requests');
        e.status = 429;
        throw e;
      }
      return { text: 'ok', toolCalls: [] };
    },
  };
  const retries = [];
  const router = new ProviderRouter({
    config: { model: 'primary' },
    provider,
    retryBaseMs: 10, // 测试里退避要快
    onRetry: (msg) => retries.push(msg),
  });
  const r = await router.streamChat({ messages: [] });
  assert.equal(r.text, 'ok');
  assert.equal(calls.length, 3, '2 次失败 + 1 次成功，全在同一个候选上');
  assert.equal(router.switches, 0, '没有切换');
  assert.equal(retries.length, 2, '每次重试都有通知');
  assert.match(retries[0], /retrying in/);
});

test('不可重试错误（400）不重试、立即上报', async () => {
  const calls = [];
  const provider = {
    model: 'primary',
    async streamChat() {
      calls.push(1);
      const e = new Error('bad request');
      e.status = 400;
      throw e;
    },
  };
  const router = new ProviderRouter({ config: { model: 'primary' }, provider, retryBaseMs: 10 });
  await assert.rejects(() => router.streamChat({ messages: [] }), /bad request/);
  assert.equal(calls.length, 1, '400 只尝试一次');
});

test('AbortError 永不重试', async () => {
  const calls = [];
  const provider = {
    model: 'primary',
    async streamChat() {
      calls.push(1);
      const e = new Error('aborted');
      e.name = 'AbortError';
      throw e;
    },
  };
  const router = new ProviderRouter({ config: { model: 'primary' }, provider, retryBaseMs: 10 });
  await assert.rejects(() => router.streamChat({ messages: [] }), (e) => e.name === 'AbortError');
  assert.equal(calls.length, 1);
});

test('重试耗尽后仍走 fallback 切换', async () => {
  // fallback 候选由 createProvider 从配置构建 —— 用本地 HTTP 后端冒充备用端点
  const http = await import('node:http');
  const backend = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok from backup' } }] }));
  });
  await new Promise((r) => backend.listen(0, '127.0.0.1', r));
  const baseUrl = `http://127.0.0.1:${backend.address().port}/v1`;
  const calls = [];
  const failing = {
    model: 'primary',
    async complete() {
      calls.push('primary');
      const e = new Error('503 overloaded');
      e.status = 503;
      throw e;
    },
  };
  const router = new ProviderRouter({
    config: { model: 'primary' },
    provider: failing,
    fallbacks: [{ model: 'backup', baseUrl }],
    retryBaseMs: 10,
  });
  try {
    const r = await router.complete({ messages: [] });
    assert.equal(r.text, 'ok from backup');
    assert.equal(calls.filter((c) => c === 'primary').length, 3, '主候选 1 + 重试 2');
    assert.equal(router.switches, 1, '恢复后记一次切换');
  } finally {
    backend.close();
  }
});

test('已吐过内容的流（noRetry）绝不重试', async () => {
  const calls = [];
  const provider = {
    model: 'primary',
    async streamChat() {
      calls.push(1);
      const e = new Error('stream closed');
      e.noRetry = true;
      throw e;
    },
  };
  const router = new ProviderRouter({ config: { model: 'primary' }, provider, retryBaseMs: 10 });
  await assert.rejects(() => router.streamChat({ messages: [] }), /stream closed/);
  assert.equal(calls.length, 1, '重发会重复输出 —— 不重试');
});
