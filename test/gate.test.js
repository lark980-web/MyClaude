import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runGate, parseSummary, parseSkips, checkSkips, waitForExeReady, gateSteps } from '../scripts/gate.mjs';
const tap = n => ['# tests '+n, '# pass '+n, '# fail 0', '# cancelled 0', '# skipped 0', '# todo 0', ''].join('\n');
function fixture(t) {
  const root=mkdtempSync(join(tmpdir(),'mc-gate-'));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  mkdirSync(join(root,'test')); mkdirSync(join(root,'scripts'));
  writeFileSync(join(root,'test/a.test.js'),'');
  for(const f of ['inspect-prompt.mjs','verify-features.mjs']) writeFileSync(join(root,'scripts',f),'');
  return root;
}
const runner = count => name => ({status:0,stdout:name==='tests'?tap(count):name==='prompt'?'{"errors":0}':'ok',stderr:''});
test('TAP parser fails closed on missing, skipped, zero or failed suites',()=>{
  assert.equal(parseSummary(tap(4)).tests,4);
  for(const s of ['',tap(0),tap(4).replace('# fail 0','# fail 1')]) assert.throws(()=>parseSummary(s));
  // skipped 是合法状态（N 系列真引擎测试需要钥匙时如实 skip）
  assert.equal(parseSummary(tap(4).replace('# skipped 0','# skipped 1')).skipped,1);
});
test('successful gate persists baseline; count regression cannot lower it',t=>{
  const root=fixture(t); assert.equal(runGate({root,runner:runner(4)}).latest.status,'passed');
  const r=runGate({root,runner:runner(3)}); assert.equal(r.latest.status,'failed'); assert.match(r.latest.error,/regressed/); assert.equal(r.baseline.testCount,4);
  assert.equal(JSON.parse(readFileSync(join(root,'test/gate-metrics.json'))).baseline.testCount,4);
});
test('feature marker failure makes gate red even after successful tests',t=>{
  const root=fixture(t); const good=runner(4);
  const r=runGate({root,runner:(name,...args)=>name==='features'?{status:1,stdout:'missing marker',stderr:''}:good(name,...args)});
  assert.equal(r.latest.status,'failed'); assert.equal(r.baseline,null); assert.match(r.latest.error,/features/);
});
test('corrupt baseline is preserved and cannot silently bootstrap green',t=>{
  const root=fixture(t); const p=join(root,'test/gate-metrics.json'); writeFileSync(p,'broken');
  assert.equal(runGate({root,runner:runner(4)}).latest.status,'failed'); assert.equal(readFileSync(p,'utf8'),'broken');
});
test('missing script is not a skip and prompt errors block success',t=>{
  const root=fixture(t); rmSync(join(root,'scripts/verify-features.mjs'));
  assert.match(runGate({root,runner:runner(4)}).latest.error,/Missing gate script/);
  const good=runner(4); assert.match(runGate({root,runner:(name,...args)=>name==='prompt'?{status:0,stdout:'{"errors":1}'}:good(name,...args)}).latest.error,/Prompt/);
});
test('full builds executable before smoke and includes both CDP suites and TTY',()=>{
 const names=gateSteps(true).map(x=>x[0]); assert.ok(names.indexOf('build-exe')<names.indexOf('smoke')); assert.deepEqual(names.slice(-3),['catalog-cdp','vim-cdp','tty']);
});
test('parseSkips extracts skipped test names and reasons from TAP', () => {
  const tap = ['ok 1 - passes', 'ok 2 - needs key # SKIP 引擎不可用', 'ok 3 - other # SKIP no reason', ''].join('\n');
  const s = parseSkips(tap);
  assert.deepEqual(s.map(x => x.name), ['needs key', 'other']);
  assert.equal(s[0].reason, '引擎不可用');
  assert.deepEqual(parseSkips(''), []);
});

test('checkSkips fails on an unlisted skip and reports stale entries', () => {
  const allow = { allowed: [{ name: 'known', reason: 'x' }] };
  // listed skip passes
  assert.equal(checkSkips([{ name: 'known', reason: 'x' }], allow).skipped, 1);
  // unlisted skip is red
  assert.throws(() => checkSkips([{ name: 'surprise', reason: 'silently stopped running' }], allow), /Unlisted skipped test/);
  // empty allowlist + any skip is red (fail-closed)
  assert.throws(() => checkSkips([{ name: 'anything', reason: '' }], { allowed: [] }), /Unlisted/);
  assert.doesNotThrow(() => checkSkips([], { allowed: [] }));
});

test('gate turns red when a test silently becomes an unlisted skip', t => {
  const root = fixture(t);
  writeFileSync(join(root, 'test/gate-skip-allowlist.json'), JSON.stringify({ allowed: [] }));
  const withSkip = '# tests 4\n# pass 3\n# fail 0\n# cancelled 0\n# skipped 1\n# todo 0\nok 1 - x # SKIP env\n';
  const good = runner(4);
  const r = runGate({ root, runner: (name, ...args) => name === 'tests' ? { status: 0, stdout: withSkip, stderr: '' } : good(name, ...args) });
  assert.equal(r.latest.status, 'failed');
  assert.match(r.latest.error, /Unlisted skipped test/);
});
test('waitForExeReady reports not-ready when the exe is missing (deterministic)', () => {
  const root = mkdtempSync(join(tmpdir(), 'mc-exe-'));
  try {
    const r = waitForExeReady(root, { attempts: 1, delayMs: 10 });
    assert.equal(r.ready, false);
    assert.match(r.reason, /missing/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
