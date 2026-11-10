/**
 * Session fork/branch 行为测试（逻辑层）：
 * fork 复制消息到新 session、原会话不受影响、新 session 的 title 可自定义。
 * branch 创建分叉点，后续消息写入新分支。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HOME = mkdtempSync(join(tmpdir(), 'myclaude-fork-'));
process.env.MYCLAUDE_HOME = HOME;
const { forkSession, saveSession, loadSession, deleteSession } = await import('../src/session.js');
  const { rememberEngineSession, engineSessionFor, forgetEngineSession } = await import('../src/engines/claude-code.js');

test('fork: 复制消息到新 session（原会话不受影响）', () => {
  saveSession('orig', [
    { role: 'user', content: 'q1' },
    { role: 'assistant', content: 'a1' },
    { role: 'user', content: 'q2' },
    { role: 'assistant', content: 'a2' },
  ], { title: 'original' });
  const r = forkSession('orig', { title: 'forked copy' });
  assert.ok(r.ok, 'fork 成功');
  const orig = loadSession('orig');
  const fork = loadSession(r.id);
  assert.equal(fork.messages.length, 4, 'fork 包含全部消息');
  assert.equal(orig.messages.length, 4, '原会话不受影响');
  assert.deepEqual(fork.messages, orig.messages, '消息内容一致');
  // title 不同
  assert.notEqual(fork.title, orig.title);
  // ID 不同
  assert.notEqual(fork.id, 'orig', '新 session id');
});

test('fork: 不存在的会话 → ok:false + error', () => {
  const r = forkSession('nonexistent-session-xyz', {});
  assert.equal(r.ok, false, '不存在的会话 fork 失败');
  assert.match(r.error, /no such session/);
});

test('fork: 自定义标题', () => {
  saveSession('fork-title-orig', [{ role: 'user', content: 'x' }], { title: 'orig title' });
  const r = forkSession('fork-title-orig', { title: 'my custom fork' });
  const fork = loadSession(r.id);
  assert.equal(fork.title, 'my custom fork');
});

test('fork: 引擎绑定不带到新会话（N9 补充——fork 也是"新会话"）', async () => {
  const { rememberEngineSession, engineSessionFor } = await import('../src/engines/claude-code.js');
  rememberEngineSession('fork-bind-orig', 'upstream-123');
  assert.ok(engineSessionFor('fork-bind-orig'), '原会话有绑定');
  // fork 后新会话不应该继承引擎绑定（新上游会话）
  const r = forkSession('fork-bind-orig', {});
  assert.equal(engineSessionFor(r.id), null, '新会话没有引擎绑定');
  forgetEngineSession('fork-bind-orig');
  forgetEngineSession(r.id);
});

test('branch: 分叉后新消息写入新 session', () => {
  saveSession('branch-orig', [
    { role: 'user', content: 'before branch' },
  ], { title: 'before branch' });
  const r = forkSession('branch-orig', { title: 'after branch' });
  // 分叉后新消息写入 fork session
  const forkMsgs = loadSession(r.id).messages;
  forkMsgs.push({ role: 'user', content: 'after branch' });
  saveSession(r.id, forkMsgs);
  // 原会话不受影响
  assert.equal(loadSession('branch-orig').messages.length, 1, '原会话消息数不变');
  assert.equal(loadSession(r.id).messages.length, 2, '新会话消息数增加');
});

test('delete: 删除会话后文件被移除', () => {
  saveSession('delete-me', [{ role: 'user', content: 'x' }]);
  assert.ok(loadSession('delete-me'), '存在');
  deleteSession('delete-me');
  assert.equal(loadSession('delete-me'), null, '删除后不存在');
});
