import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.MYCLAUDE_HOME = mkdtempSync(join(tmpdir(), 'myclaude-engtimeout-'));

const { runEngineTurn, describeTimeout } = await import('../src/engines/claude-code.js');

const ORIG = { bun: process.env.MYCLAUDE_ENGINE_BUN, cli: process.env.MYCLAUDE_ENGINE_CLI };
after(() => {
  for (const [k, v] of Object.entries(ORIG)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  setTimeout(() => process.exit(0), 100).unref?.();
});

// console.log 自带换行，省得和转义较劲
const ASSISTANT = 'console.log(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: TEXT }] } }));';
const RESULT = 'console.log(JSON.stringify({ type: "result", subtype: "success", result: "done", is_error: false, num_turns: 1 }));';

function fakeCli(lines) {
  const p = join(tmpdir(), 'mc-timeout-' + Math.random().toString(36).slice(2) + '.mjs');
  writeFileSync(p, lines.join('\n'), 'utf8');
  process.env.MYCLAUDE_ENGINE_BUN = process.execPath;
  process.env.MYCLAUDE_ENGINE_CLI = p;
  return p;
}

// 用户实际遇到的那个 bug 的回归测试：
// 旧实现是「从 spawn 起算的绝对墙钟」，一个正在干活（持续有输出）的引擎会被误杀。
test('an engine that keeps producing output is NOT killed by the idle deadline', async () => {
  // 每 500ms 输出一行，共 6 行（约 3s）；idle 阈值 1500ms。
  // 旧行为：1500ms 到点即杀。新行为：每行都重置计时器，跑完为止。
  fakeCli([
    'let n = 0;',
    'const iv = setInterval(() => {',
    '  n++;',
    '  console.log(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "tick " + n }] } }));',
    '  if (n >= 6) {',
    '    clearInterval(iv);',
    '    console.log(JSON.stringify({ type: "result", subtype: "success", result: "done", is_error: false, num_turns: 1 }));',
    '    process.exit(0);',
    '  }',
    '}, 500);',
    'process.stdin.on("data", () => {});',
  ]);
  const started = Date.now();
  const r = await runEngineTurn({ prompt: 'work', timeoutMs: 1500, maxMs: 60000 });
  const took = Date.now() - started;
  assert.equal(r.timedOut, false, 'a working engine must not be killed (took ' + took + 'ms)');
  assert.equal(r.ok, true, JSON.stringify({ error: r.error, tail: r.stderrTail }));
  assert.equal(r.assistantTexts.length, 6, 'all six ticks must arrive');
  assert.ok(took >= 2800, 'it really ran ~3s, longer than the idle threshold: ' + took);
});

test('a genuinely silent engine IS killed at the idle deadline', async () => {
  fakeCli(['process.stdin.on("data", () => {});', 'setTimeout(() => process.exit(0), 60000);']);
  const started = Date.now();
  const r = await runEngineTurn({ prompt: 'x', timeoutMs: 1500, maxMs: 60000 });
  const took = Date.now() - started;
  assert.equal(r.timedOut, true);
  assert.equal(r.ok, false);
  assert.equal(r.timeoutKind, 'idle', 'must blame the idle deadline');
  assert.ok(took < 8000, 'must not wait for the 60s process: ' + took);
});

test('the absolute ceiling still bounds a chatty engine', async () => {
  fakeCli([
    'setInterval(() => console.log(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "x" }] } })), 200);',
    'process.stdin.on("data", () => {});',
  ]);
  const started = Date.now();
  const r = await runEngineTurn({ prompt: 'x', timeoutMs: 1500, maxMs: 2500 });
  const took = Date.now() - started;
  assert.equal(r.timedOut, true);
  assert.equal(r.timeoutKind, 'ceiling', 'must blame the absolute ceiling');
  assert.ok(took >= 2000 && took < 9000, 'stopped near the ceiling: ' + took);
});

test('the idle threshold is configurable by environment', async () => {
  fakeCli(['process.stdin.on("data", () => {});', 'setTimeout(() => process.exit(0), 60000);']);
  process.env.MYCLAUDE_ENGINE_IDLE_MS = '5000';
  try {
    const r = await runEngineTurn({ prompt: 'x' });
    assert.equal(r.timedOut, true);
    assert.equal(r.idleMs, 5000, 'env override must be honoured: ' + r.idleMs);
  } finally { delete process.env.MYCLAUDE_ENGINE_IDLE_MS; }
});

// P10 纪律：超时绝不能报成「已终止」—— 引擎中止前可能已经改过文件。
test('the timeout message never claims nothing happened', () => {
  const withTools = describeTimeout({
    timeoutKind: 'idle', idleMs: 180000,
    toolUses: [{ name: 'Read' }, { name: 'Edit' }, { name: 'Bash' }],
  });
  assert.match(withTools, /已连续 180 秒没有任何输出/);
  assert.match(withTools, /已执行 3 个工具调用/);
  assert.match(withTools, /Read、Edit、Bash/);
  assert.match(withTools, /结果未知/);
  assert.match(withTools, /可能已产生部分修改/);

  const ceiling = describeTimeout({ timeoutKind: 'ceiling', idleMs: 180000, toolUses: [] });
  assert.match(ceiling, /已达绝对时间上限/);
  assert.match(ceiling, /未见工具调用/);
  assert.match(ceiling, /结果未知/);
});

// 用户在截图里遇到的场景：2 个工具操作在跑，界面显示「正在执行」，然后被判超时杀掉。
// 引擎跑长命令时本来就长时间没有输出 —— 那是在等自己的工具，不是卡死。
test('a long-running tool call is NOT mistaken for a hang', async () => {
  fakeCli([
    // 立刻发起一个工具调用（tool_use），然后**静默 2.5 秒**（超过 1.5 秒的 idle 阈值）
    'console.log(JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "sleep 2.5" } }] } }));',
    'setTimeout(() => {',
    '  console.log(JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "done" }] } }));',
    '  console.log(JSON.stringify({ type: "result", subtype: "success", result: "ok", is_error: false, num_turns: 1 }));',
    '  process.exit(0);',
    '}, 2500);',
    'process.stdin.on("data", () => {});',
  ]);
  const started = Date.now();
  const r = await runEngineTurn({ prompt: 'x', timeoutMs: 1500, maxMs: 60000 });
  const took = Date.now() - started;
  assert.equal(r.timedOut, false, 'a tool in flight must not be treated as silence (took ' + took + 'ms)');
  assert.equal(r.ok, true, JSON.stringify({ error: r.error, tail: r.stderrTail }));
  assert.ok(took >= 2400, 'it waited for the tool: ' + took);
  assert.equal(r.toolUses.length, 1);
  assert.equal(r.toolUses[0].name, 'Bash');
});

test('the idle deadline resumes once the in-flight tool finishes', async () => {
  // 工具回来之后仍然静默 → 这次必须被杀（证明不是把 idle 永久关掉了）
  fakeCli([
    'console.log(JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "Read", input: {} }] } }));',
    'setTimeout(() => {',
    '  console.log(JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "x" }] } }));',
    '}, 400);',
    'setTimeout(() => process.exit(0), 60000);',
    'process.stdin.on("data", () => {});',
  ]);
  const started = Date.now();
  const r = await runEngineTurn({ prompt: 'x', timeoutMs: 1500, maxMs: 60000 });
  const took = Date.now() - started;
  assert.equal(r.timedOut, true, 'silence after the tool returned must still be caught');
  assert.equal(r.timeoutKind, 'idle');
  assert.ok(took >= 1800 && took < 9000, 'killed one idle window after the tool result: ' + took);
});
// 第二个独立故障的回归测试：宿主代理配置污染引擎。
// 宿主有 HTTPS_PROXY + NODE_USE_ENV_PROXY 但没有 no_proxy 时，引擎会把发往
// 本机网关的明文请求交给代理，代理回 400 → 整个回合失败。engineEnv 必须兜住。
test('engineEnv never lets a local gateway go through a proxy', async () => {
  const { engineEnv } = await import('../src/engines/claude-code.js');
  const orig = { NO_PROXY: process.env.NO_PROXY, no_proxy: process.env.no_proxy, HTTPS_PROXY: process.env.HTTPS_PROXY };
  try {
    delete process.env.NO_PROXY; delete process.env.no_proxy;
    process.env.HTTPS_PROXY = 'http://127.0.0.1:7897';
    const a = engineEnv({ baseUrl: 'http://127.0.0.1:3425/v1', apiKey: 'k' });
    for (const k of ['NO_PROXY', 'no_proxy']) {
      assert.match(a[k], /localhost/, k + ' must bypass the proxy for localhost');
      assert.match(a[k], /127\.0\.0\.1/, k + ' must bypass the proxy for 127.0.0.1');
      assert.match(a[k], /::1/, k + ' must bypass the proxy for ::1');
    }
    assert.equal(a.ANTHROPIC_BASE_URL, 'http://127.0.0.1:3425', 'the /v1 suffix is stripped');
    assert.equal(a.ANTHROPIC_AUTH_TOKEN, 'k');
    // 宿主已有的 no_proxy 必须保留（合并不覆盖）
    process.env.no_proxy = 'example.com';
    const b = engineEnv({ baseUrl: 'http://127.0.0.1:3425/v1' });
    assert.match(b.NO_PROXY, /example\.com/, 'existing host entries survive');
    assert.match(b.NO_PROXY, /127\.0\.0\.1/, 'local entries are still added');
    // 空 apiKey 有确定的兜底值，不是 undefined
    assert.equal(b.ANTHROPIC_API_KEY, 'sk-engine-local');
  } finally {
    for (const [k, v] of Object.entries(orig)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
});

test('an engine that works then goes quiet is killed only after it goes quiet', async () => {
  fakeCli([
    'console.log(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "a" }] } }));',
    'setTimeout(() => console.log(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "b" }] } })), 900);',
    'setTimeout(() => process.exit(0), 60000);',
    'process.stdin.on("data", () => {});',
  ]);
  const started = Date.now();
  const r = await runEngineTurn({ prompt: 'x', timeoutMs: 1500, maxMs: 60000 });
  const took = Date.now() - started;
  assert.equal(r.timedOut, true);
  assert.equal(r.timeoutKind, 'idle');
  assert.match(String(r.assistantTexts.join('')), /ab/, 'both ticks arrived before the kill');
  assert.ok(took >= 2200, 'killed after the second tick plus the idle window: ' + took);
});