/**
 * 原生 Claude Code 引擎（B 路线：引擎并入）。
 *
 * 背景：claude-re-2.1.302 提取出的 2433 模块明文树可以在本机 Bun 下直接引导
 * （证据链见 docs/authentic-claude-code-run.md：--version/--help/网关完整回合/
 * 真实 tool_use 全部跑通）。本模块把那棵树当作"另一个 agent 内核"驱动：
 * spawn 子进程 → prompt 走 stdin → 解析 stream-json 事件流 → 汇总成结构化结果。
 *
 * 它不是 provider：provider 只做单轮 LLM 调用，而这里是一个完整 agent 循环
 * （自带工具执行、会话、权限）。所以接入点是 /api/command 命令桥，不进 providers/。
 *
 * 环境依赖（都可用环境变量覆盖）：
 *   - bun 运行时：MYCLAUDE_ENGINE_BUN，默认探测 ~/.bun/bin/bun.exe，再退 PATH
 *   - 提取树入口：MYCLAUDE_ENGINE_CLI，默认 B:/~BUN/root/cli（subst 映射）
 * 网关凭据由调用方传入（baseUrl/apiKey），与 MyClaude 自身会话同源。
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const DEFAULT_CLI = "B:/~BUN/root/cli";
const DEFAULT_TIMEOUT_MS = 180_000;
const MAX_TIMEOUT_MS = 600_000;
const PERMISSION_MODES = new Set(["default", "acceptEdits", "plan", "bypassPermissions"]);

let cachedBun;

/** 解析 bun 可执行文件：env 覆盖 → ~/.bun/bin → PATH 探测（结果缓存）。 */
function resolveBun() {
  // env 覆盖每次都查、不进缓存：测试用它把引擎指向假 CLI（node + 夹具脚本）。
  const env = process.env.MYCLAUDE_ENGINE_BUN;
  if (env && existsSync(env)) return env;
  if (cachedBun !== undefined) return cachedBun;
  cachedBun = null;
  if (!cachedBun) {
    for (const rel of [join(homedir(), ".bun", "bin", "bun.exe"), join(homedir(), ".bun", "bin", "bun")]) {
      if (existsSync(rel)) { cachedBun = rel; break; }
    }
  }
  if (!cachedBun) {
    try {
      const r = spawnSync("bun", ["--version"], { timeout: 10_000, windowsHide: true });
      if (r.status === 0) cachedBun = "bun";
    } catch { /* PATH 里没有就走不可用分支 */ }
  }
  return cachedBun;
}

function cliPath() {
  return process.env.MYCLAUDE_ENGINE_CLI || DEFAULT_CLI;
}

/** 引擎可用性。available = 提取树入口存在 且 bun 可解析。 */
export function engineStatus() {
  const cli = cliPath();
  const bun = resolveBun();
  const cliOk = existsSync(cli);
  return { available: cliOk && Boolean(bun), cli, cliOk, bun: bun || null };
}

/** baseUrl 允许带 /v1（OpenAI 风格配置值），Claude Code 要的是 API 根。 */
export function engineEnv({ baseUrl, apiKey } = {}) {
  const root = String(baseUrl || "").replace(/\/+$/, "").replace(/\/v1$/, "");
  const key = apiKey || "sk-engine-local";
  return {
    ...process.env,
    ...(root ? { ANTHROPIC_BASE_URL: root } : {}),
    ANTHROPIC_AUTH_TOKEN: key,
    ANTHROPIC_API_KEY: key,
    NO_COLOR: "1",
  };
}

/** CLI 参数。prompt 不走 argv（会被 shell/Start-Process 拆错），走 stdin。 */
export function buildEngineArgs({ model, permissionMode = "acceptEdits" } = {}) {
  const mode = PERMISSION_MODES.has(permissionMode) ? permissionMode : "acceptEdits";
  const args = [
    cliPath(),
    "--print",
    "--output-format", "stream-json",
    "--verbose",
    "--permission-mode", mode,
  ];
  if (model) args.push("--model", String(model));
  return args;
}

/**
 * 汇总 stream-json 事件流（纯函数，便于用真实事件夹具做单测）。
 * 事件形状来自实测：system/init（session_id+tools）、assistant（content 块数组）、
 * result（result 文本 + num_turns + duration_ms + usage）。
 */
export function summarizeEngineEvents(lines) {
  const out = {
    sessionId: null, model: null, permissionMode: null, toolsCount: 0,
    assistantTexts: [], toolUses: [], reasoningChars: 0,
    result: null, numTurns: null, durationMs: null, isError: null, costUsd: null, usage: null,
  };
  for (const line of lines) {
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    if (o.type === "system" && o.subtype === "init") {
      out.sessionId = o.session_id || out.sessionId;
      out.model = o.model || out.model;
      out.permissionMode = o.permissionMode || out.permissionMode;
      out.toolsCount = Array.isArray(o.tools) ? o.tools.length : out.toolsCount;
    } else if (o.type === "assistant" && o.message && Array.isArray(o.message.content)) {
      for (const b of o.message.content) {
        if (b.type === "text" && b.text) out.assistantTexts.push(b.text);
        else if (b.type === "thinking" && b.thinking) out.reasoningChars += b.thinking.length;
        else if (b.type === "tool_use") out.toolUses.push({ name: b.name, input: b.input });
      }
    } else if (o.type === "result") {
      if (typeof o.result === "string") out.result = o.result;
      out.numTurns = o.num_turns ?? out.numTurns;
      out.durationMs = o.duration_ms ?? out.durationMs;
      out.isError = Boolean(o.is_error);
      out.costUsd = o.total_cost_usd ?? out.costUsd;
      out.usage = o.usage || out.usage;
      out.sessionId = o.session_id || out.sessionId;
    }
  }
  return out;
}

/**
 * 跑一个完整引擎回合。
 * 超时必须外层兜底：实测网关上游 5xx 时引擎会无限重试（docs 里 G6 的结论），
 * 引擎自己不会放弃。
 */
export function runEngineTurn({
  prompt, model, baseUrl, apiKey, cwd: workdir,
  timeoutMs, permissionMode = "acceptEdits", onEvent,
} = {}) {
  return new Promise((resolve) => {
    const st = engineStatus();
    if (!st.available) { resolve({ ok: false, error: "native engine unavailable", status: st }); return; }
    if (!prompt || !String(prompt).trim()) { resolve({ ok: false, error: "empty prompt" }); return; }
    const timeout = Math.max(5_000, Math.min(Number(timeoutMs) || DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS));
    const args = buildEngineArgs({ model, permissionMode });
    let child;
    try {
      child = spawn(st.bun, args, {
        cwd: workdir || process.cwd(),
        env: engineEnv({ baseUrl, apiKey }),
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (e) {
      resolve({ ok: false, error: "spawn failed: " + e.message, status: st });
      return;
    }
    const lines = [];
    let buf = "", stderrTail = "", timedOut = false, settled = false;
    const timer = setTimeout(() => { timedOut = true; try { child.kill(); } catch { /* already gone */ } }, timeout);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (c) => {
      buf += c;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (line) {
          lines.push(line);
          if (onEvent) { try { onEvent(line); } catch { /* 观察者异常不影响回合 */ } }
        }
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (c) => { stderrTail = (stderrTail + c).slice(-2_000); });
    child.on("error", (e) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      resolve({ ok: false, error: "engine process error: " + e.message, status: st });
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      const s = summarizeEngineEvents(lines);
      resolve({
        ok: !timedOut && code === 0 && !s.isError,
        timedOut, exitCode: code, stderrTail,
        ...s,
      });
    });
    child.stdin.on("error", () => { /* 引擎提前退出时写 stdin 可能 EPIPE，忽略 */ });
    try { child.stdin.write(String(prompt)); child.stdin.end(); } catch { /* 同上 */ }
  });
}
