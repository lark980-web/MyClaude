/**
 * 引擎会话绑定行为测试（N9 深层）：绑定表的生命周期在**运行时**被验证——
 * remember → engineSessionFor 回读 → forget → 回读为 null。
 * 不只测源码文本，测真模块的行为。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HOME = mkdtempSync(join(tmpdir(), 'myclaude-bind-'));
process.env.MYCLAUDE_HOME = HOME;

const { engineSessionFor, rememberEngineSession, forgetEngineSession } = await import('../src/engines/claude-code.js');

test('N9 运行时行为：remember → 读回 → forget → null', () => {
  const key = 'bind-test-' + Date.now();
  assert.equal(engineSessionFor(key), null, '初始无绑定');
  rememberEngineSession(key, 'upstream-sess-abc');
  assert.equal(engineSessionFor(key), 'upstream-sess-abc', '绑定后读回');
  forgetEngineSession(key);
  assert.equal(engineSessionFor(key), null, 'forget 后清空');
});

test('N9 边缘：空 key 归一为 default；空 sessionId 不写入', () => {
  rememberEngineSession('edge-key', '');
  assert.equal(engineSessionFor('edge-key'), null, '空 sessionId 不产生绑定');
  rememberEngineSession('', 'sess-for-default');
  assert.equal(engineSessionFor(''), 'sess-for-default', '空 key 落 default 槽');
  forgetEngineSession('');
  assert.equal(engineSessionFor(''), null);
});
