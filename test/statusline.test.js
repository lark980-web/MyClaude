import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.MYCLAUDE_HOME = mkdtempSync(join(tmpdir(), 'myclaude-statusline-'));

const { buildStatusLineInput, normalizeStatusLineOut, runStatusLine } = await import('../src/agent/statusline.js');
const { startGui } = await import('../src/ui/gui-server.js');

const TOP = ['session_id','session_name','prompt_id','transcript_path','cwd','model','workspace','version','output_style','context_window'];

test('buildStatusLineInput matches the upstream StatusLineCommandInput shape', () => {
  const i = buildStatusLineInput({ sessionId: 's1', cwd: '/repo', model: { id: 'm/x', displayName: 'M X' },
    contextWindow: { totalInputTokens: 40000, totalOutputTokens: 120, contextWindowSize: 200000 } });
  assert.deepEqual(Object.keys(i), TOP);
  assert.equal(i.session_id, 's1');
  assert.equal(i.model.display_name, 'M X');
  assert.deepEqual(Object.keys(i.workspace), ['current_dir','project_dir','added_dirs','git_worktree','repo']);
  assert.equal(i.context_window.used_percentage, 20);
  assert.equal(i.context_window.remaining_percentage, 80);
  assert.equal(i.context_window.current_usage, null);
});

test('effort is optional', () => {
  assert.equal('effort' in buildStatusLineInput({}), false);
  assert.deepEqual(buildStatusLineInput({ effort: { level: 'high' } }).effort, { level: 'high' });
});

test('normalizeStatusLineOut compresses stdout like upstream', () => {
  assert.equal(normalizeStatusLineOut('  hello   world  '), 'hello world');
  assert.equal(normalizeStatusLineOut(''), '');
});

function fakeCmd(lines) {
  const p = join(tmpdir(), 'mc-statusline-fake-' + Math.random().toString(36).slice(2) + '.mjs');
  writeFileSync(p, lines.join('\n'), 'utf8');
  return 'node ' + p;
}

test('runStatusLine passes the JSON on stdin and returns compressed text', async () => {
  const cmd = fakeCmd([
    'let b = "";',
    'process.stdin.on("data", (c) => { b += c; });',
    'process.stdin.on("end", () => { const j = JSON.parse(b); console.log("OK " + j.session_id + " " + j.model.id + " " + j.context_window.used_percentage); });',
  ]);
  const input = buildStatusLineInput({ sessionId: 's9', model: { id: 'm/y' },
    contextWindow: { totalInputTokens: 1000, contextWindowSize: 10000 } });
  const r = await runStatusLine({ command: cmd, input, timeoutMs: 15000 });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.text, 'OK s9 m/y 10');
});

test('runStatusLine degrades on nonzero exit and on no command', async () => {
  const bad = await runStatusLine({ command: fakeCmd(['process.exit(3);']), input: {}, timeoutMs: 15000 });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /exit 3/);
  const none = await runStatusLine({ command: '', input: {}, timeoutMs: 5000 });
  assert.equal(none.ok, false);
  assert.match(none.error, /no statusLine command/);
});

test('/api/statusline executes the configured command', async () => {
  const cmd = fakeCmd([
    'let b = "";',
    'process.stdin.on("data", (c) => { b += c; });',
    'process.stdin.on("end", () => { const j = JSON.parse(b); console.log("SL " + j.session_id + " " + j.version); });',
  ]);
  const { server: gui, address } = await startGui({ config: { model: 'm', provider: 'openai', baseUrl: 'http://127.0.0.1:9', apiKey: 'x', statusLineCommand: cmd }, port: 0, open: false });
  try {
    const j = await (await fetch(address + '/api/statusline?sessionKey=sl-e2e')).json();
    assert.equal(j.ok, true, JSON.stringify(j));
    assert.equal(j.configured, true);
    assert.match(j.text, /^SL sl-e2e /);
  } finally { await new Promise((r) => gui.close(r)); }
});

test('/api/statusline reports unconfigured honestly', async () => {
  const { server: gui, address } = await startGui({ config: { model: 'm', provider: 'openai', baseUrl: 'http://127.0.0.1:9', apiKey: 'x' }, port: 0, open: false });
  try {
    const j = await (await fetch(address + '/api/statusline')).json();
    assert.equal(j.ok, false);
    assert.equal(j.configured, false);
    assert.equal(j.text, null);
  } finally { await new Promise((r) => gui.close(r)); }
});

test('POST /api/config syncs the statusline command to the server', async () => {
  const cmd = fakeCmd([
    'let b = "";',
    'process.stdin.on("data", (c) => { b += c; });',
    'process.stdin.on("end", () => { const j = JSON.parse(b); console.log("SYNC " + j.session_id); });',
  ]);
  const { server: gui, address } = await startGui({ config: { model: 'm', provider: 'openai', baseUrl: 'http://127.0.0.1:9', apiKey: 'x' }, port: 0, open: false });
  try {
    const before = await (await fetch(address + '/api/statusline')).json();
    assert.equal(before.configured, false);
    await fetch(address + '/api/config', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ statusLineCommand: cmd }) });
    const after = await (await fetch(address + '/api/statusline?sessionKey=sync-1')).json();
    assert.equal(after.configured, true);
    assert.equal(after.text, 'SYNC sync-1');
    // clear 也能同步
    await fetch(address + '/api/config', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ statusLineCommand: null }) });
    const cleared = await (await fetch(address + '/api/statusline')).json();
    assert.equal(cleared.configured, false);
  } finally { await new Promise((r) => gui.close(r)); }
});
test('statusline is wired into all three surfaces', async () => {
  const fs = await import('node:fs');
  const main = fs.readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
  const app = fs.readFileSync(new URL('../src/ui/web/js/app.js', import.meta.url), 'utf8');
  const gs = fs.readFileSync(new URL('../src/ui/gui-server.js', import.meta.url), 'utf8');
  assert.match(main, /runStatusLine\(/);
  assert.match(app, /refreshStatusLine/);
  assert.match(gs, /\/api\/statusline/);
});

after(() => { setTimeout(() => process.exit(0), 100).unref?.(); });
test("vim.mode 仅在传入时进入 stdin 契约（上游 chunk-e0x0xb6d vim 契约）", () => {
  const base = buildStatusLineInput({ sessionId: "s1" });
  assert.equal("vim" in base, false, "未启用 vim 时字段不存在");
  const withVim = buildStatusLineInput({ sessionId: "s1", vim: { mode: "VISUAL LINE" } });
  assert.deepEqual(withVim.vim, { mode: "VISUAL LINE" });
});
