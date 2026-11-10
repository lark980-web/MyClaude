/**
 * Notification 事件行为级对照测试（逻辑层）：
 * 上游在三个时机触发 Notification hook：
 * 1. permission_request — 工具需要用户确认时
 * 2. input_needed — Agent 需要用户回答问题时
 * 3. task_complete — 回合完成时
 * MyClaude 对应接线：agent.js 的 askPermission/Stop hook 路径。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HOME = mkdtempSync(join(tmpdir(), 'myclaude-notif-'));
process.env.MYCLAUDE_HOME = HOME;
const { Agent } = await import('../src/agent/agent.js');
const { HookRunner, interpret } = await import('../src/hooks.js');
const { outputStyleTurnReminder } = await import('../src/output-style.js');

const makeAgent = (provider, config, hooks) => {
  const ui = { streamText(){}, endStream(){}, info(){}, warn(){}, error(){}, success(){}, toolStart(){}, toolEnd(){}, confirmTool: async () => true };
  const agent = new Agent({ provider, config, ui, sessionKey: 'notif-test' });
  if (hooks) { agent.hooks = hooks; } // 覆盖构造器自动创建的 HookRunner
  return agent;
};

test('Notification: ask 模式确认时 hook 被触发且带 permission_request', async () => {
  const provider = { async streamChat() { return { text: 'ok', toolCalls: [] }; } };
  const config = { provider: 'openai', baseUrl: 'http://x/v1', apiKey: 'k', model: 'm',
    maxTokens: 64, temperature: 0, permissionMode: 'ask', maxTurns: 4,
    contextWindow: 100000, vision: true };
  const fired = [];
  const hooks = new HookRunner({ config: {} });
  hooks.has = () => true;
  hooks.run = async (event, payload) => {
    fired.push({ event, type: payload.notificationType, msg: payload.message });
    return { block: false, reason: "", context: "", permission: null, systemMessage: "", contexts: [] };
  };
  const agent = makeAgent(provider, config, hooks);
  // ask 模式下调用 Write → confirmTool 路径 → Notification hook 触发
  await agent.askPermission('Write', { file_path: 'a.txt' });
  const notifs = fired.filter((f) => f.event === 'Notification');
  assert.ok(notifs.length > 0, 'Notification hook 被触发');
  assert.equal(notifs[0].type, 'permission_request', 'notificationType = permission_request');
});

test('Notification: auto 模式破坏性命令确认时 hook 被触发', async () => {
  const provider = { async streamChat() { return { text: 'ok', toolCalls: [] }; } };
  const config = { provider: 'openai', baseUrl: 'http://x/v1', apiKey: 'k', model: 'm',
    maxTokens: 64, temperature: 0, permissionMode: 'auto', maxTurns: 4,
    contextWindow: 100000, vision: true, autoReview: false };
  const fired = [];
  const hooks = new HookRunner({ config: {} });
  hooks.has = () => true;
  hooks.run = async (event, payload) => {
    fired.push({ event, type: payload.notificationType });
    return { block: false, reason: "", context: "", permission: null, systemMessage: "", contexts: [] };
  };
  const agent = makeAgent(provider, config, hooks);
  agent.askOnDestructive = true;
  // auto 模式 + 破坏性命令 → 确认路径 → Notification hook
  await agent.askPermission('Bash', { command: 'rm -rf /tmp/test' });
  const notifs = fired.filter((f) => f.event === 'Notification');
  assert.ok(notifs.length > 0, '破坏性命令触发 Notification');
  assert.equal(notifs[0].type, 'permission_request');
});

test('Notification: default 无样式时 turnReminder 为空（不产生假通知）', () => {
  assert.equal(outputStyleTurnReminder('default'), '', 'default 无提醒');
  assert.equal(outputStyleTurnReminder('nonexistent'), '', '不存在样式不猜');
});

test('Notification hook stderr 非阻断（不影响回合）', () => {
  const r = interpret({ code: 1, stdout: "", stderr: "notification script bug" });
  assert.equal(r.block, false, 'Notification hook 失败不阻断');
  assert.ok(r.systemMessage.length > 0, '错误可见');
});
