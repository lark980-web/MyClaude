import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync, readdirSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export function parseSummary(text) {
  const result = {};
  for (const key of ['tests','pass','fail','cancelled','skipped','todo']) {
    const matches = [...text.matchAll(new RegExp('^# ' + key + ' ([0-9]+)\r?$', 'gm'))];
    if (!matches.length) throw Error('Missing TAP summary: ' + key);
    result[key] = Number(matches.at(-1)[1]);
  }
  if (!result.tests || result.fail || result.cancelled || result.todo) throw Error('Incomplete or failing test run: ' + JSON.stringify(result));
  // skipped 是合法状态：真引擎等需要钥匙/环境的测试如实 skip 比假绿好
  if (result.skipped) console.log('[gate] skipped: ' + result.skipped + ' (honest skips are OK)');
  return result;
}
/** The freshly built exe can be briefly un-launchable (AV scan / file lock).
 *  Probe it actively instead of sleeping a fixed time: a fixed sleep is a guess,
 *  and its failure mode is silent - every command in the next step prints nothing. */
export function waitForExeReady(root, { attempts = 12, delayMs = 1500 } = {}) {
  const exe = join(root, 'dist', 'myclaude.exe');
  if (!existsSync(exe)) return { ready: false, reason: 'dist/myclaude.exe missing' };
  for (let i = 0; i < attempts; i++) {
    const r = spawnSync(exe, ['--version'], { encoding: 'utf8', timeout: 15000, windowsHide: true });
    if (r.status === 0 && String(r.stdout || '').trim()) return { ready: true, out: String(r.stdout).trim(), attempts: i + 1 };
    spawnSync(process.execPath, ['-e', 'setTimeout(()=>{}, ' + Number(delayMs) + ')'], { windowsHide: true, timeout: 20000 });
  }
  return { ready: false, reason: 'exe never reported a version after ' + attempts + ' attempts' };
}
/** Parse skipped test names from TAP (ok N - name # SKIP reason). */
export function parseSkips(tapText) {
  const out = [];
  for (const m of String(tapText || '').matchAll(/^ok \d+ - (.+?) # SKIP\s*(.*)$/gm)) {
    out.push({ name: m[1].trim(), reason: (m[2] || '').trim() });
  }
  return out;
}

/** A skip is legal only if it is on the explicit allowlist. Unlisted skip = red:
 *  a test moving from pass to skip keeps the tests count constant, so the
 *  high-water check cannot see it. This is the second lock. */
export function checkSkips(skips, allowlist) {
  const allowed = new Set(((allowlist && allowlist.allowed) || []).map((x) => x.name));
  const unlisted = skips.filter((s) => !allowed.has(s.name));
  if (unlisted.length) {
    throw Error('Unlisted skipped test(s) - add to test/gate-skip-allowlist.json with a reason, or fix the test: ' +
      unlisted.map((s) => JSON.stringify(s.name) + ' (' + (s.reason || 'no reason') + ')').join('; '));
  }
  const skippedNames = new Set(skips.map((s) => s.name));
  const stale = [...allowed].filter((n) => !skippedNames.has(n));
  if (stale.length) console.log('[gate] note: allowlist entries not skipped this run: ' + stale.join('; '));
  return { skipped: skips.length, unlisted: 0, stale };
}

export function checkCount(count, baseline) {
  if (baseline && (!Number.isSafeInteger(baseline.testCount) || baseline.testCount < 1)) throw Error('Invalid baseline');
  if (baseline && count < baseline.testCount) throw Error('Test count regressed: ' + count + ' < ' + baseline.testCount);
}
export function gateSteps(full) {
  const steps = [
    ['tests', ['--test','--test-reporter=tap','--test-concurrency', String(process.env.MYCLAUDE_GATE_TEST_CONCURRENCY || 4), 'test/*.test.js']],
    ['prompt', ['scripts/inspect-prompt.mjs','--json']],
    ['features', ['scripts/verify-features.mjs']],
  ];
  if (full) steps.push(
    ['build-embed',['scripts/bundle-gui.mjs']], ['build-exe',['scripts/build-exe.mjs']],
    ['smoke',['--test','--test-reporter=tap','test/smoke-commands.smoke.js']],
    ['catalog-cdp',['scripts/verify-catalog-toolcard.mjs']],
    ['vim-cdp',['scripts/verify-gui-vim.mjs']], ['tty',['scripts/verify-tui-tty.mjs']]);
  return steps;
}
export function runGate({root, full=false, runner, steps=gateSteps(full)} = {}) {
  root = resolve(root || fileURLToPath(new URL('..', import.meta.url)));
  const metricsPath = join(root,'test/gate-metrics.json');
  const runId = new Date().toISOString().replace(/[:.]/g,'-');
  const logDir = join(root,'.local/gate',runId); mkdirSync(logDir,{recursive:true});
  const git = process.env.MYCLAUDE_GATE_GIT || (existsSync('F:/Tools/Git/cmd/git.exe') ? 'F:/Tools/Git/cmd/git.exe' : 'git');
  const gitRead = args => { const r=spawnSync(git,args,{cwd:root,encoding:'utf8',timeout:10000,windowsHide:true}); return r.status === 0 ? r.stdout.trim() : null; };
  const latest = {runId,mode:full?'full':'fast',startedAt:new Date().toISOString(),commit:gitRead(['rev-parse','HEAD']),dirty:gitRead(['status','--porcelain','--untracked-files=no']),status:'failed',steps:[]};
  let baseline = null, summary = null, validState = true;
  try {
    if (existsSync(metricsPath)) {
      let previous;
      try { previous=JSON.parse(readFileSync(metricsPath,'utf8')); if (previous.schemaVersion !== 1 || !Object.hasOwn(previous,'baseline')) throw Error('Invalid metrics schema'); baseline=previous.baseline; checkCount(Number.MAX_SAFE_INTEGER,baseline); }
      catch (e) { validState=false; throw e; }
    }
    for (const [name,args] of steps) {
      if (name === 'tests' && !readdirSync(join(root,'test')).some(x=>x.endsWith('.test.js'))) throw Error('No test files found');
      if (args[0].startsWith('scripts/') && !existsSync(join(root,args[0]))) throw Error('Missing gate script: '+args[0]);
      const logPath=join(logDir,name+'.log');
      const env = { ...process.env };
      const winptyDir = process.env.MYCLAUDE_GATE_WINPTY_DIR || 'F:/Tools/Git/usr/bin';
      if (name === 'tty' && existsSync(join(winptyDir,'winpty.exe'))) env.PATH = winptyDir + ';' + (env.PATH || '');
      const exeSteps = new Set(['smoke','catalog-cdp','vim-cdp','tty']);
      const runOnce = () => runner ? runner(name,args,root) : spawnSync(process.execPath,args,{cwd:root,encoding:'utf8',windowsHide:true,timeout:600000,maxBuffer:64*1024*1024,env});
      let result = runOnce();
      // AV can lock the freshly built exe (spawn EBUSY / EPERM, exit 0x20). Retry
      // exe-launching steps with backoff; this is environment noise, not a verdict.
      for (let attempt = 0; attempt < 4 && exeSteps.has(name) && !runner; attempt++) {
        const blob = (result.stdout||'')+'\n'+(result.stderr||'')+'\n'+(result.error?.message||'');
        const retryable = /EBUSY|EPERM|error 0x20|being used by another process|另一个程序正在使用/.test(blob)
          // all-silent smoke = exe produced no output at all (startup blocked), retry it
          || (name === 'smoke' && /print nothing at all/.test(blob));
        if (result.status === 0 || !retryable) break;
        spawnSync(process.execPath, ['-e', 'setTimeout(()=>{}, 2500*(Number(process.env.MYCLAUDE_GATE_RETRY)||1))'], {windowsHide:true, timeout:15000});
        result = runOnce();
      }
      const text=(result.stdout||'')+'\n'+(result.stderr||''); writeFileSync(logPath,text);
      latest.steps.push({name,args,exitCode:result.status,signal:result.signal||null,logPath});
      if (result.error || result.signal || result.status !== 0) throw Error(name+': '+(result.error?.message||'exit '+result.status));
      if (name === 'build-exe' && !runner) { // active readiness probe instead of a fixed sleep (see waitForExeReady)
        const w = waitForExeReady(root); latest.exeReady = w;
        if (!w.ready) throw Error('exe not runnable after build: ' + w.reason); }
      if (name === 'tests' || name === 'smoke') { const s=parseSummary(result.stdout||''); if(name==='tests'){
        summary=s; checkCount(s.tests,baseline);
        const skips=parseSkips(result.stdout||'');
        const skipPath=join(root,'test/gate-skip-allowlist.json');
        const allow=existsSync(skipPath)?JSON.parse(readFileSync(skipPath,'utf8')):{allowed:[]};
        latest.skipCheck=checkSkips(skips,allow); latest.skipped=skips.map(x=>x.name);
      } }
      if (name === 'prompt') { const p=JSON.parse(result.stdout); if(p.errors !== 0) throw Error('Prompt inspection failed'); }
      if (name === 'tty') { const line=(result.stdout||'').split(/\r?\n/).find(x=>x.startsWith('{')); const p=JSON.parse(line||'null'); if(!p || p.welcome!==true || p.sawTyped!==true || p.cfgPanelSeen!==true) throw Error('TTY behavioral checks failed'); }
      console.log('[gate] PASS '+name);
    }
    if (!summary) throw Error('No test summary');
    latest.status='passed';
    baseline={testCount:summary.tests,commit:latest.commit,at:new Date().toISOString()};
  } catch(e) { latest.error=e.message; console.error('[gate] FAIL '+e.message); }
  latest.testCount=summary?.tests||null; latest.finishedAt=new Date().toISOString();
  const state={schemaVersion:1,baseline,latest};
  writeFileSync(join(logDir,'result.json'),JSON.stringify(state,null,2)+'\n');
  if(validState){ mkdirSync(dirname(metricsPath),{recursive:true}); const tmp=metricsPath+'.tmp'; writeFileSync(tmp,JSON.stringify(state,null,2)+'\n'); renameSync(tmp,metricsPath); }
  return state;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args=process.argv.slice(2);
  if(args.some(x=>!['--fast','--full'].includes(x)) || args.length>1){console.error('Usage: node scripts/gate.mjs [--fast|--full]'); process.exitCode=2;}
  else process.exitCode=runGate({full:args.includes('--full')}).latest.status==='passed'?0:1;
}
