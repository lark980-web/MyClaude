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
  if (!result.tests || result.pass !== result.tests || result.fail || result.cancelled || result.skipped || result.todo) throw Error('Incomplete or failing test run: ' + JSON.stringify(result));
  return result;
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
        if (result.status === 0 || !/EBUSY|EPERM|error 0x20|being used by another process|另一个程序正在使用/.test(blob)) break;
        spawnSync(process.execPath, ['-e', 'setTimeout(()=>{}, 2500*(Number(process.env.MYCLAUDE_GATE_RETRY)||1))'], {windowsHide:true, timeout:15000});
        result = runOnce();
      }
      const text=(result.stdout||'')+'\n'+(result.stderr||''); writeFileSync(logPath,text);
      latest.steps.push({name,args,exitCode:result.status,signal:result.signal||null,logPath});
      if (result.error || result.signal || result.status !== 0) throw Error(name+': '+(result.error?.message||'exit '+result.status));
      if (name === 'build-exe') { // AV briefly locks the freshly built exe (error 0x20); let the scan settle before smoke/TTY launch it.
        spawnSync(process.execPath, ['-e', 'setTimeout(()=>{}, Number(process.env.MYCLAUDE_GATE_BUILD_SETTLE_MS)||3000)'], {windowsHide:true, timeout:15000}); }
      if (name === 'tests' || name === 'smoke') { const s=parseSummary(result.stdout||''); if(name==='tests'){summary=s; checkCount(s.tests,baseline);} }
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
