/**
 * Notification hook stdin 契约对照测试（逻辑层）：
 * 上游 stdin JSON（chunk-e0x0xb6d.js:3565811）:
 *   {hook_event_name:"Notification", message, title, notification_type}
 * notification_type 用作 matcher（与 tool_name 在 PreToolUse 中的角色相同）。
 * 触发条件：permission_request / input_needed / task_complete。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HOME = mkdtempSync(join(tmpdir(), 'myclaude-notifc-'));
process.env.MYCLAUDE_HOME = HOME;
const { Agent } = await import('../src/agent/agent.js');
const { HookRunner, matcherMatches } = await import('../src/hooks.js');
const { outputStyleTurnReminder } = await import('../src/output-style.js');

const makeAgent = (provider, config, hooks) => {
  const ui = { streamText(){}, endStream(){}, info(){}, warn(){}, error(){}, success(){}, toolStart(){}, toolEnd(){}, confirmTool: async () => true };
  const agent = new Agent({ provider, config, ui, sessionKey: 'notif-contract' });
  if (hooks) { agent.hooks = hooks; }
  return agent;
};

test('契约：notification_type 用 snake_case（上游 chunk-e0x0xb6d.js 契约）', async () => {
  const provider = { async streamChat() { return { text: 'ok', toolCalls: [] }; } };
  const config = { provider: 'openai', baseUrl: 'http://x/v1', apiKey: 'k', model: 'm',
    maxTokens: 64, temperature: 0, permissionMode: 'ask', maxTurns: 4,
    contextWindow: 100000, vision: true };
  let payload = null;
  const hooks = new HookRunner({ config: {} });
  hooks.has = () => true;
  hooks.run = async (event, p) => { payload = p; return { block: false, reason: "", context: "", permission: null, systemMessage: "", contexts: [] }; };
  const agent = makeAgent(provider, config, hooks);
  await agent.askPermission('Write', { file_path: 'a.txt' });
  assert.ok(payload, 'hook 收到 payload');
  assert.equal(payload.notification_type, 'permission_request', 'notification_type = snake_case');
  // hook_event_name 由 HookRunner.run() 添加 —— mock 绕过了它所以不在此层
  assert.equal(payload.notification_type, "permission_request");
  assert.ok(payload.message, 'message 存在');
});

test('契约：matcher 按 notification_type 匹配（与 tool_name 同角色）', () => {
  assert.equal(matcherMatches('permission_request', 'permission_request'), true);
  assert.equal(matcherMatches('task_complete', 'task_complete'), true);
  assert.equal(matcherMatches('permission_request', 'task_complete'), false);
});

test('契约：outputStyleTurnReminder 四态', () => {
  assert.equal(outputStyleTurnReminder('default'), '');
  assert.ok(outputStyleTurnReminder('proactive').includes('Execute autonomously'));
  assert.ok(outputStyleTurnReminder('proactive', { waiting: true }).includes('Do not poll'));
  assert.equal(outputStyleTurnReminder('proactive', { waiting: true }), outputStyleTurnReminder('proactive', { waiting: true }), '确定性');
  assert.equal(outputStyleTurnReminder('learning'), '', '上游 Learning 无 turnReminder');
  assert.ok(outputStyleTurnReminder('concise').includes('Be concise'));
});
