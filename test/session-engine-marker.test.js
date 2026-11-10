/**
 * N5（会话审计 §4.5）：engine 标记永久残留、会说谎。
 *
 * saveSession 是「读旧文件 + ...meta 合并」，**从不删除旧键**；而只有 upstream
 * 路径写过 engine。于是跑过一次原生引擎的会话会永久留着 engine:"upstream"，
 * 即使之后一直在跑自研 agent —— 排错时这个字段直接误导人。
 * 修法是让两条自研路径也显式声明自己，字段才始终真实。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HOME = mkdtempSync(join(tmpdir(), 'myclaude-engine-marker-'));
process.env.MYCLAUDE_HOME = HOME;

const { saveSession, loadSession } = await import('../src/session.js');

test('saveSession keeps only its whitelist: engine must be re-passed on every write', () => {
  saveSession('marker-1', [{ role: 'user', content: 'a' }], { engine: 'upstream', ui: 'web' });
  assert.equal(loadSession('marker-1').engine, 'upstream');
  // 第二次写入不传 engine —— 它会被**丢弃**（不是「残留旧值」）。
  // 机制：saveSession 只白名单保留 title/pinned/archived/unarchived 四个旧键。
  saveSession('marker-1', [{ role: 'user', content: 'b' }], { ui: 'gui' });
  assert.equal(loadSession('marker-1').engine, undefined, 'engine is dropped, not carried over');
  // 白名单里的键才真的会残留
  saveSession('marker-2', [{ role: 'user', content: 'a' }], { title: 'T' });
  saveSession('marker-2', [{ role: 'user', content: 'b' }], { ui: 'gui' });
  assert.equal(loadSession('marker-2').title, 'T', 'whitelisted keys do survive');
  rmSync(join(HOME, 'sessions', 'marker-1.json'), { force: true });
  rmSync(join(HOME, 'sessions', 'marker-2.json'), { force: true });
});
test('both self-agent write paths declare engine:"self"', () => {
  const gui = readFileSync(new URL('../src/ui/gui-server.js', import.meta.url), 'utf8');
  const tui = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
  assert.match(gui, /engine:\s*"self"/, 'GUI 自研路径必须声明 engine');
  assert.match(tui, /engine:\s*"self"/, 'TUI 自研路径必须声明 engine');
  // 上游路径仍然声明 upstream —— 不要改坏它
  assert.match(gui, /engine:\s*"upstream"/, 'upstream 路径的声明要保留');
});

test('N9：会话删除后引擎绑定被回收（forgetEngineSession 接线）', async () => {
  const gui = readFileSync(new URL('../src/ui/gui-server.js', import.meta.url), 'utf8');
  const tui = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
  // GUI DELETE /api/sessions/:id 内要调 forgetEngineSession(id)
  assert.match(gui, /savers\.delete\(id\);[\s\S]{0,200}forgetEngineSession\(id\);/, 'GUI 删除路径回收绑定');
  // TUI /rm 内要调 forgetEngineSession(arg)
  assert.match(tui, /forgetEngineSession\(arg\)/, 'TUI /rm 路径回收绑定');
});
