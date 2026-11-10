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
/**
 * 超时策略：**静默超时（idle）为主，绝对上限兜底**。
 *
 * 旧实现是「从 spawn 起算的绝对墙钟」—— 于是正在干活的引擎也会被砍掉。
 * 实测：一次全工作区搜索（本仓库含 2.8GB apk 与 14.5GB mitm-logs）就超过 180s，
 * 引擎已跑完 2 个工具调用却被杀掉，界面还显示「已终止」，用户以为白干了。
 *
 * 现在的规则：引擎**有输出**（工具调用/文本/事件）就说明它活着，计时器随之重置；
 * 只有连续 idleMs 没有任何输出才算卡死。绝对上限仍在，防「永远不结束」。
 * 两者都可用环境变量覆盖：MYCLAUDE_ENGINE_IDLE_MS / MYCLAUDE_ENGINE_MAX_MS。
 */
const DEFAULT_IDLE_MS = 180_000;      // 连续多久无输出算卡死（沿用旧数字，但语义变了）
const DEFAULT_MAX_MS = 3_600_000;     // 绝对上限：60 分钟（卡死由静默检测负责，这里只防「永远不结束」）
const MAX_TIMEOUT_MS = 3_600_000;     // 显式传入 idle 值的上限（1 小时）
const MAX_CEILING_MS = 7_200_000;     // 显式传入绝对上限的上限（2 小时）

/** 环境变量覆盖的 idle 阈值（非法值退回默认，不静默改变行为）。 */
function idleMs() {
  const v = Number(process.env.MYCLAUDE_ENGINE_IDLE_MS);
  return Number.isFinite(v) && v >= 5_000 ? v : DEFAULT_IDLE_MS;
}
/** 环境变量覆盖的绝对上限。 */
function ceilingMs() {
  const v = Number(process.env.MYCLAUDE_ENGINE_MAX_MS);
  return Number.isFinite(v) && v >= 5_000 ? v : DEFAULT_MAX_MS;
}
/**
 * 引擎 `--permission-mode` 的**权威取值**。
 *
 * 来源：直接让引擎自己打印 —— `bun B:/~BUN/root/cli --help`：
 *   --permission-mode <mode>  (choices: "acceptEdits", "auto", "bypassPermissions",
 *                              "manual", "dontAsk", "plan")
 * 注意没有 "default" —— 以前这里写的就是错的，MyClaude 的 ask/dontAsk 全被静默降级。
 */
const ENGINE_PERMISSION_MODES = new Set(["acceptEdits", "auto", "bypassPermissions", "manual", "dontAsk", "plan"]);

/**
 * MyClaude 模式 → 引擎模式。7 个 MyClaude 模式都有明确对应，不再静默降级。
 * 未知值一律退到 **manual（最保守）**，而不是 acceptEdits —— 未知不等于放行。
 */
const ENGINE_MODE_MAP = Object.freeze({
  ask: "manual",
  acceptEdits: "acceptEdits",
  auto: "auto",
  dontAsk: "dontAsk",
  plan: "plan",
  bypassPermissions: "bypassPermissions",
  fullAccess: "bypassPermissions", // MyClaude 专有逃生舱，语义等同
});

export function toEnginePermissionMode(mode) {
  const m = String(mode || "").trim();
  if (ENGINE_PERMISSION_MODES.has(m)) return m;
  return ENGINE_MODE_MAP[m] || "manual";
}
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
/** 本地地址永远不该走代理。 */
const LOCAL_NO_PROXY = "localhost,127.0.0.1,::1,[::1]";

export function engineEnv({ baseUrl, apiKey } = {}) {
  const root = String(baseUrl || "").replace(/\/+$/, "").replace(/\/v1$/, "");
  const key = apiKey || "sk-engine-local";
  // 引擎永远先跟 MyClaude 自己配置的 baseUrl 说话，而它通常是本机网关。
  // 实测：宿主的 HTTPS_PROXY 被 ...process.env 透传给引擎后，若环境里没有 no_proxy，
  // 引擎会把发往 127.0.0.1 的明文请求交给代理，代理回
  // "400 The plain HTTP request was sent to HTTPS port" —— 整个回合直接失败。
  // 所以这里显式把本地地址加入 NO_PROXY/no_proxy（与宿主已有值合并，不覆盖）。
  const existing = String(process.env.NO_PROXY || process.env.no_proxy || "").split(",").map((x) => x.trim()).filter(Boolean);
  const merged = Array.from(new Set([...existing, ...LOCAL_NO_PROXY.split(",")])).join(",");
  return {
    ...process.env,
    ...(root ? { ANTHROPIC_BASE_URL: root } : {}),
    ANTHROPIC_AUTH_TOKEN: key,
    ANTHROPIC_API_KEY: key,
    NO_PROXY: merged,
    no_proxy: merged,
    NO_COLOR: "1",
  };
}

/** CLI 参数。prompt 不走 argv（会被 shell/Start-Process 拆错），走 stdin。 */
export function buildEngineArgs({
  model, permissionMode = "manual", resumeSessionId, additionalDirectories, permissionPrompts,
} = {}) {
  const mode = toEnginePermissionMode(permissionMode);
  const args = [
    cliPath(),
    "--print",
    "--output-format", "stream-json",
    "--verbose",
    // 上游用此 flag 实现细粒度流式（stream_event partial deltas）——
    // 没有它 GUI 在 upstream 模式下要等整段助手消息才显示（丢流式体验）。
    "--include-partial-messages",
    "--permission-mode", mode,
    // 引擎默认 --permission-prompts host：它会把授权询问发给宿主，而 MyClaude 目前
    // 不实现该协议 → 询问悬空。显式设 none 让行为确定：会询问的一律自动拒绝，
    // 并把拒绝原因回传到 result.permission_denials，由 describeDenials() 讲给人听。
    "--permission-prompts", permissionPrompts === "host" ? "host" : "none",
  ];
  if (resumeSessionId) args.push("--resume", String(resumeSessionId));
  if (model) args.push("--model", String(model));
  // 额外工作目录：MyClaude 的 /add-dir。不给的话引擎只能碰项目目录，
  // 连自己的技能目录（~/.claude/skills）都读不到。
  const dirs = (Array.isArray(additionalDirectories) ? additionalDirectories : [])
    .map((d) => String(d || "").trim()).filter(Boolean);
  if (dirs.length) args.push("--add-dir", ...dirs);
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
    permissionDenials: [],
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
      // 引擎会如实报出「本来要问、但因为没人应答而拒绝」的调用。
      // 这是把「无法创建技能」这类静默失败讲清楚的关键数据。
      if (Array.isArray(o.permission_denials) && o.permission_denials.length) {
        out.permissionDenials = o.permission_denials;
      }
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

/**
 * 超时结果的人话描述 —— **P10 纪律：超时 ≠ 什么都没做**。
 *
 * 引擎被中止前可能已经执行了写操作（Edit/Write/Bash）。把「不知道」说成「已终止」，
 * 用户会以为工作区没被动过 —— 那是错的。所以这里必须：说明中止原因、列出已发生的工具调用、
 * 明确标注结果未知。
 */
/**
 * 一行 stream-json 里的「工具增减」：tool_use +1，tool_result -1。
 *
 * 用途：判断引擎手里是否还有未完成的工具调用。这一点很关键 ——
 * 引擎跑一条长命令（全工作区搜索之类）时**本来就长时间没有输出**，
 * 那是在等自己的工具，不是卡死。把「工具在飞行中」也当静默，就会误杀它。
 */
/**
 * 把引擎报回的权限拒绝转成人能照着做的提示。
 *
 * 为什么需要它：上游把 `.claude/skills|commands|agents` 当作**硬保护目录**
 * （chunk-zvergrz0.js 的 Ef()；调用方 PG() 对这类路径一律要求显式授权）。
 * --print 模式下没人能应答授权 → 静默失败。用户只看到「没装成」，
 * 不知道挡在哪、也不知道怎么办。这个函数负责把话说全。
 */
export function describeDenials(denials, { mode } = {}) {
  const list = Array.isArray(denials) ? denials.filter(Boolean) : [];
  if (!list.length) return null;
  const pickInput = (d) => (d && (d.tool_input || d.input)) || {};
  const lines = list.slice(0, 5).map((d) => {
    const name = (d && (d.tool_name || d.toolName || d.name)) || "工具";
    const input = pickInput(d);
    const target = input.file_path || input.path || input.notebook_path || input.command || "";
    const why = (d && (d.decision_reason || d.reason || d.message)) || "";
    return "  · " + name + (target ? " → " + String(target) : "") + (why ? "（" + String(why).slice(0, 120) + "）" : "");
  });
  const protectedHit = list.some((d) => {
    const input = pickInput(d);
    const path = String(input.file_path || input.path || "").replace(/\\/g, "/");
    return /\/\.claude\/(skills|commands|agents)\//.test(path);
  });
  const fix = protectedHit
    ? ["这是上游的硬保护目录（.claude/skills|commands|agents）。两条路：",
       "  1) 把权限模式切到「全部放行」后重试；",
       "  2) 或把该目录加进额外工作目录（/add-dir），再放行 Write。"].join("\n")
    : ["如果这些调用本来就该放行：检查当前权限模式（/mode），或改用「接受编辑 / 自动 / 全部放行」后重试。"].join("\n");
  return "引擎拒绝了 " + list.length + " 次调用（当前模式：" + (mode || "?") + "）：\n" + lines.join("\n") + "\n" + fix;
}
export function toolBalanceOf(line) {
  try {
    const ev = JSON.parse(line);
    const content = ev && ev.message && ev.message.content;
    if (!Array.isArray(content)) return 0;
    let d = 0;
    for (const part of content) {
      if (!part || typeof part !== "object") continue;
      if (part.type === "tool_use") d++;
      else if (part.type === "tool_result") d--;
    }
    return d;
  } catch { return 0; }
}
export function describeTimeout(r) {
  const idleSec = Math.round((Number(r && r.idleMs) || 0) / 1000);
  let why;
  if (r && r.timeoutKind === "ceiling") why = "已达绝对时间上限";
  else if (idleSec) why = "已连续 " + idleSec + " 秒没有任何输出";
  else why = "长时间没有任何输出";
  const uses = Array.isArray(r && r.toolUses) ? r.toolUses : [];
  const names = uses.map((t) => (t && t.name) || "").filter(Boolean).join("、");
  const ran = uses.length
    ? "中止前已执行 " + uses.length + " 个工具调用（" + names + "）"
    : "中止前未见工具调用";
  return "原生引擎" + why + "，已中止。" + ran + " —— 结果未知，可能已产生部分修改，请先检查工作区再决定是否重试。";
}
/** 上游会话已不存在的判定（实测报错特征在 stderr：No conversation found with session ID: xxx）。 */
function missingSession(result) {
  const text = String(result.stderrTail || "") + "\n" + (result.result || "") + "\n" + (result.assistantTexts || []).join("\n");
  return MISSING_SESSION_RE.test(text);
}

/** 单次 spawn 尝试。timeoutMs 是**静默**阈值；maxMs 是绝对上限。 */
function attempt({
  prompt, model, baseUrl, apiKey, cwd: workdir,
  timeoutMs, maxMs, permissionMode, onEvent, resumeSessionId, additionalDirectories,
}) {
  return new Promise((resolve) => {
    const st = engineStatus();
    if (!st.available) { resolve({ ok: false, error: "native engine unavailable", status: st }); return; }
    const idle = Math.max(5_000, Math.min(Number(timeoutMs) || idleMs(), MAX_TIMEOUT_MS));
    const ceiling = Math.max(idle, Math.min(Number(maxMs) || ceilingMs(), MAX_CEILING_MS));
    const args = buildEngineArgs({ model, permissionMode, resumeSessionId, additionalDirectories });
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
    let buf = "", stderrTail = "", timedOut = false, timeoutKind = null, settled = false;
    let idleTimer = null, ceilingTimer = null;
    // 飞行中的工具调用数：>0 时引擎是在等自己的工具，静默属正常
    let pendingTools = 0;
    const stopTimers = () => { if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; } if (ceilingTimer) { clearTimeout(ceilingTimer); ceilingTimer = null; } };
    const deadline = (kind) => {
      if (settled) return;
      timedOut = true; timeoutKind = kind;
      try { child.kill(); } catch { /* already gone */ }
    };
    // 每收到一段输出就重置静默计时器：有输出 == 还活着
    const bumpIdle = () => {
      if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
      // 有工具在飞行中 → 不设静默计时器：长命令本来就安静，只受绝对上限约束
      if (pendingTools > 0) return;
      idleTimer = setTimeout(() => deadline("idle"), idle);
    };
    bumpIdle();
    ceilingTimer = setTimeout(() => deadline("ceiling"), ceiling);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (c) => {
      buf += c;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (line) {
          lines.push(line);
          pendingTools = Math.max(0, pendingTools + toolBalanceOf(line));
          if (onEvent) { try { onEvent(line); } catch { /* 观察者异常不影响回合 */ } }
        }
      }
      // 处理完这一段再决定要不要武装静默计时器（顺序很重要）
      bumpIdle();
    });
    child.stderr.setEncoding("utf8");
    // stderr 不算「活着」的证据：引擎会把模型警告一直写进 stderr
    child.stderr.on("data", (c) => { stderrTail = (stderrTail + c).slice(-2_000); });
    child.on("error", (e) => { if (settled) return; settled = true; stopTimers(); resolve({ ok: false, error: "engine process error: " + e.message, status: st }); });
    child.on("close", (code) => {
      if (settled) return;
      settled = true; stopTimers();
      const s = summarizeEngineEvents(lines);
      resolve({
        ok: !timedOut && code === 0 && !s.isError,
        timedOut, timeoutKind, exitCode: code, stderrTail, pendingTools,
        idleMs: idle, ceilingMs: ceiling,
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
  timeoutMs, maxMs, permissionMode = "manual", onEvent, resumeSessionId, additionalDirectories,
} = {}) {
  return (async () => {
    if (!prompt || !String(prompt).trim()) return { ok: false, error: "empty prompt" };
    const base = {
      prompt: String(prompt), model, baseUrl, apiKey,
      cwd: workdir, timeoutMs, maxMs, permissionMode, onEvent, additionalDirectories,
    };
    const first = await attempt({ ...base, resumeSessionId: resumeSessionId || null });
    if (resumeSessionId && !first.ok && missingSession(first)) {
      const second = await attempt({ ...base, resumeSessionId: null });
      return { ...second, recoveredFromMissingResume: true };
    }
    return first;
  })();
}