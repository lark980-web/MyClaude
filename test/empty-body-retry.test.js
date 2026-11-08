/**
 * 空正文补救的配额与文案（会话审计 §1.2 / §1.3 R1+R2）。
 *
 * 两个上限并存：
 *  - 每回合 2 次 —— 保持原有补救节奏（催两次不成，就用 reasoning 尾段兜底）。
 *  - 每会话 60 秒窗口 4 次 —— **不随回合归零**，这才是病灶所在：
 *    旧写法只有每回合上限，用户每发一条消息就重新拿到 2 条**逐字节相同**的提示。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { OpenAIProvider } from '../src/providers/openai.js';
import { Agent } from '../src/agent/agent.js';

/** 永远只回 reasoning、content 留空的假后端（复现「只有思考过程」）。 */
function reasoningOnlyBackend() {
  const state = { bodies: [] };
  const server = createServer((req, res) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      state.bodies.push(JSON.parse(data || '{}'));
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: ' + JSON.stringify({ choices: [{ delta: { reasoning_content: 'thinking hard' } }] }) + '\n\n');
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  return { server, state };
}

async function listen(server) {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return 'http://127.0.0.1:' + server.address().port + '/v1';
}

const ui = {
  streamText() {}, endStream() {}, info() {}, warn() {}, error() {}, success() {},
  toolStart() {}, toolEnd() {}, confirmTool: async () => true,
};

const baseConfig = {
  provider: 'openai', apiKey: 'k', model: 'm',
  maxTokens: 100, temperature: 0, permissionMode: 'auto',
  maxTurns: 20, contextWindow: 100000, compactThreshold: 0.8, vision: true,
};

/** 只看**最后一个**请求体：每个请求都携带完整历史，逐请求累加会重复计数。 */
function injections(bodies) {
  const last = bodies[bodies.length - 1];
  if (!last) return [];
  return (last.messages || [])
    .filter((m) => m.role === 'user' && typeof m.content === 'string' && m.content.includes('只有思考过程'))
    .map((m) => m.content);
}

function makeAgent(baseUrl) {
  const provider = new OpenAIProvider({ ...baseConfig, baseUrl });
  return new Agent({ provider, config: { ...baseConfig, baseUrl }, ui, tools: [] });
}

test('the window cap spans turns: two per turn, four per session window', async () => {
  const b = reasoningOnlyBackend();
  const baseUrl = await listen(b.server);
  try {
    const agent = makeAgent(baseUrl);
    await agent.run('first');
    assert.equal(injections(b.state.bodies).length, 2, 'per-turn cap is still 2 (nudge, nudge, fall back)');

    await agent.run('second');
    assert.equal(injections(b.state.bodies).length, 4, 'a second turn in the same window may add up to the window cap');

    await agent.run('third');
    assert.equal(injections(b.state.bodies).length, 4, 'once the window is spent, a new turn grants nothing');
  } finally {
    await new Promise((r) => b.server.close(r));
  }
});

test('the injected reminder is never byte-identical twice', async () => {
  const b = reasoningOnlyBackend();
  const baseUrl = await listen(b.server);
  try {
    const agent = makeAgent(baseUrl);
    await agent.run('first');
    await agent.run('second');
    const seen = injections(b.state.bodies);
    assert.equal(seen.length, 4, 'expected the full window, got ' + seen.length);
    assert.equal(new Set(seen).size, seen.length, 'every reminder must differ; identical repeats are the bug');
    for (let i = 0; i < seen.length; i++) {
      assert.match(seen[i], new RegExp('本会话第 ' + (i + 1) + ' 次'), 'labels count up across turns');
    }
  } finally {
    await new Promise((r) => b.server.close(r));
  }
});
