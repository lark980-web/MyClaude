/**
 * 原生 Claude Code 引擎（B 路线：引擎并入）。
 *
 * 背景：claude-re-2.1.302 提取出的 2433 模块明文树可以在本机 Bun 下直接引导
 * （证据链见 docs/authentic-claude-code-run.md）。本模块把那棵树当作「另一个 agent 内核」驱动：
 * spawn 子进程 → prompt 走 stdin → 解析 stream-json 事件流 → 汇总成结构化结果。
 *
 * 会话连续性（--resume）：上游 CLI 原生支持 `--resume <session-id>`，实测可跨进程续接
 * （BANANA42 实验：第二回合能复述第一回合记住的词）。本模块把上游 sessionId 按 MyClaude
 * 会话键存进 ~/.myclaude/engine-sessions.json，下回合自动 --resume —— MyClaude 的 /engine
 * 从「每次新会话」变成「共享上下文的连续会话」。上游会话文件被清理导致 resume 失效时
 * （报错特征：No conversation found with session ID），自动降级为新回合并在结果里标注。
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_CLI = "B:/~BUN/root/cli";
const DEFAULT_TIMEOUT_MS = 180_000;
const MAX_TIMEOUT_MS = 600_000;
const PERMISSION_MODES = new Set(["default", "acceptEdits", "plan", "bypassPermissions"]);
const MISSING_SESSION_RE = /No conversation found with session ID/i;

let cachedBun;

/** 解析 bun 可执行文件：env 覆盖 → ~/.bun/bin → PATH 探测（结果缓存；env 分支每次现查，测试要指向假引擎）。 */
function resolveBun() {
  const env = process.env.MYCLAUDE_ENGINE_BUN;
  if (env && existsSync(env)) return env;
  if (cachedBun !== undefined) return cachedBun;
  cachedBun = null;
  for (const rel of [join(homedir(), ".bun", "bin", "bun.exe"), join(homedir(), ".bun", "bin", "bun")]) {
    if (existsSync(rel)) { cachedBun = rel; break; }
  }
  if (!cachedBun) {
    try { const r = spawnSync("bun", ["--version"], { timeout: 10_000, windowsHide: true }); if (r.status === 0) cachedBun = "bun"; } catch { /* PATH 里没有就走不可用分支 */ }
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
export function buildEngineArgs({ model, permissionMode = "acceptEdits", resumeSessionId } = {}) {
  const mode = PERMISSION_MODES.has(permissionMode) ? permissionMode : "acceptEdits";
  const args = [
    cliPath(),
    "--print",
    "--output-format", "stream-json",
    "--verbose",
    "--permission-mode", mode,
  ];
  if (resumeSessionId) args.push("--resume", String(resumeSessionId));
  if (model) args.push("--model", String(model));
  return args;
}

/**
 * 汇总 stream-json 事件流（纯函数，便于用真实事件夹具做单测）。
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

/* ------------------------------------------------ 会话连续性（--resume） */

/** 上游 sessionId 的持久化表：MyClaude 会话键 → 上游 session id。 */
function engineSessionsPath() {
  const home = process.env.MYCLAUDE_HOME || join(homedir(), ".myclaude");
  return join(home, "engine-sessions.json");
}

function loadEngineSessions() {
  try { return JSON.parse(readFileSync(engineSessionsPath(), "utf8")) || {}; }
  catch { return {}; }
}

function saveEngineSessions(map) {
  try {
    mkdirSync(dirname(engineSessionsPath()), { recursive: true });
    writeFileSync(engineSessionsPath(), JSON.stringify(map, null, 2), "utf8");
  } catch { /* 只读盘/权限问题：丢失映射不是错误，下次重新绑定即可 */ }
}

/** 查某 MyClaude 会话绑定的上游 session id（无则 null）。 */
export function engineSessionFor(key) {
  const v = loadEngineSessions()[key || "default"];
  return typeof v === "string" && v ? v : null;
}

/** 绑定（成功回合后调用；上游 sessionId 随结果回传）。 */
export function rememberEngineSession(key, upstreamSessionId) {
  if (!upstreamSessionId) return;
  const map = loadEngineSessions();
  map[key || "default"] = String(upstreamSessionId);
  saveEngineSessions(map);
}

/** 解绑（/engine new 之后旧映射就该清掉）。 */
export function forgetEngineSession(key) {
  const map = loadEngineSessions();
  delete map[key || "default"];
  saveEngineSessions(map);
}

/** 上游会话已不存在的判定（实测报错特征在 stderr：No conversation found with session ID: xxx）。 */
function missingSession(result) {
  const text = String(result.stderrTail || "") + "\n" + (result.result || "") + "\n" + (result.assistantTexts || []).join("\n");
  return MISSING_SESSION_RE.test(text);
}

/** 单次 spawn 尝试。 */
function attempt({
  prompt, model, baseUrl, apiKey, cwd: workdir,
  timeoutMs, permissionMode, onEvent, resumeSessionId,
}) {
  return new Promise((resolve) => {
    const st = engineStatus();
    if (!st.available) { resolve({ ok: false, error: "native engine unavailable", status: st }); return; }
    const timeout = Math.max(5_000, Math.min(Number(timeoutMs) || DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS));
    const args = buildEngineArgs({ model, permissionMode, resumeSessionId });
    let child;
    try {
      child = spawn(st.bun, args, {
        cwd: workdir || process.cwd(),
        env: engineEnv({ baseUrl, apiKey }),
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (e) { resolve({ ok: false, error: "spawn failed: " + e.message, status: st }); return; }
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
    child.on("error", (e) => { if (settled) return; settled = true; clearTimeout(timer); resolve({ ok: false, error: "engine process error: " + e.message, status: st }); });
    child.on("close", (code) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      const s = summarizeEngineEvents(lines);
      resolve({
        ok: !timedOut && code === 0 && !s.isError,
        timedOut, exitCode: code, stderrTail,
        ...(resumeSessionId ? { resumedFrom: String(resumeSessionId) } : {}),
        ...s,
      });
    });
    child.stdin.on("error", () => { /* 引擎提前退出时写 stdin 可能 EPIPE，忽略 */ });
    try { child.stdin.write(String(prompt)); child.stdin.end(); } catch { /* 同上 */ }
  });
}

/**
 * 跑一个完整引擎回合。
 *
 * resumeSessionId 存在时先尝试续接；上游会话已失效（No conversation found）则自动
 * 降级为新回合，并在结果上标 recoveredFromMissingResume。超时必须外层兜底：
 * 实测网关上游 5xx 时引擎会无限重试，引擎自己不会放弃。
 */
export function runEngineTurn({
  prompt, model, baseUrl, apiKey, cwd: workdir,
  timeoutMs, permissionMode = "acceptEdits", onEvent, resumeSessionId,
} = {}) {
  return (async () => {
    if (!prompt || !String(prompt).trim()) return { ok: false, error: "empty prompt" };
    const base = {
      prompt: String(prompt), model, baseUrl, apiKey,
      cwd: workdir, timeoutMs, permissionMode, onEvent,
    };
    const first = await attempt({ ...base, resumeSessionId: resumeSessionId || null });
    if (resumeSessionId && !first.ok && missingSession(first)) {
      const second = await attempt({ ...base, resumeSessionId: null });
      return { ...second, recoveredFromMissingResume: true };
    }
    return first;
  })();
}