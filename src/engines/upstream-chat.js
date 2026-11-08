/**
 * 上游引擎 → MyClaude SSE 事件翻译器（阶段 1：执行后端统一）。
 *
 * 让 MyClaude 的主对话路径 /api/chat 可以跑上游 Claude Code 2.1.302 引擎：
 * 上游的 stream-json（NDJSON）逐行翻译成 MyClaude 现有的 SSE 事件，
 * 前端无需改动 —— delta 自动建气泡、tool_start 自动建工具卡。
 *
 * 实测的上游事件形态（2026-11-06 捕获）：
 *   system/init                              会话头（session_id、tools）
 *   assistant  message.content[].text        完整文本（不是增量 delta）
 *   assistant  message.content[].thinking    思考
 *   assistant  message.content[].tool_use    {id,name,input}
 *   user       message.content[].tool_result {tool_use_id,content,is_error}
 *   result     {result,session_id,is_error,num_turns,...}
 */

import { spawn } from "node:child_process";
import { engineStatus, engineEnv, buildEngineArgs, engineSessionFor, rememberEngineSession, toolBalanceOf } from "./claude-code.js";

/**
 * 翻译一行上游 NDJSON → 0..N 个 MyClaude SSE 事件（纯函数，可单测）。
 *
 * @param {string} line 一行 NDJSON
 * @param {{toolNames: Map<string,string>, sessionId: string|null, assistantTexts: string[], toolUses: Array, resultText: string|null, isError: boolean}} state
 * @returns {{events: object[], result?: object}}
 */
export function translateUpstreamLine(line, state) {
  let o;
  try { o = JSON.parse(line); } catch { return { events: [] }; }
  const events = [];
  if (o.type === "system" && o.subtype === "init") {
    if (o.session_id) state.sessionId = o.session_id;
    return { events };
  }
  if (o.type === "assistant" && o.message && Array.isArray(o.message.content)) {
    for (const b of o.message.content) {
      if (b.type === "text" && b.text) {
        state.assistantTexts.push(b.text);
        events.push({ type: "delta", text: b.text });
      } else if (b.type === "thinking" && b.thinking) {
        events.push({ type: "reasoning", text: b.thinking });
      } else if (b.type === "tool_use" && b.name) {
        if (b.id) state.toolNames.set(b.id, b.name);
        state.toolUses.push({ name: b.name, input: b.input || {} });
        events.push({ type: "tool_start", call: { name: b.name, args: b.input || {} } });
      }
    }
    return { events };
  }
  if (o.type === "user" && o.message && Array.isArray(o.message.content)) {
    for (const b of o.message.content) {
      if (b.type !== "tool_result") continue;
      const name = state.toolNames.get(b.tool_use_id) || b.tool_use_id || "Tool";
      let output = b.content;
      if (Array.isArray(output)) output = output.map((p) => (p && p.type === "text" ? p.text : String(p))).join("\n");
      if (output == null) output = "";
      events.push({ type: "tool_end", name, ok: !b.is_error, elapsed: 0, output: String(output), data: null });
    }
    return { events };
  }
  if (o.type === "result") {
    if (typeof o.result === "string") state.resultText = o.result;
    if (o.session_id) state.sessionId = o.session_id;
    state.isError = Boolean(o.is_error);
    events.push({ type: "assistant_end" });
    return { events, result: o };
  }
  // 其余事件（进度、遥测）忽略 —— 不认识的不猜
  return { events };
}

/** 造一个翻译状态。 */
export function newTranslateState() {
  return { toolNames: new Map(), sessionId: null, assistantTexts: [], toolUses: [], resultText: null, isError: false };
}

/**
 * 跑一个上游引擎回合，把事件实时翻译成 MyClaude SSE 事件回调出去。
 *
 * 默认后端不变（由调用方判断）；这里只负责「上游模式」的那条路径。
 * 会话续接复用 claude-code.js 的 engineSessionFor / rememberEngineSession。
 */
export function streamUpstreamTurn({
  prompt, model, baseUrl, apiKey, cwd: workdir,
  timeoutMs, maxMs, permissionMode = "acceptEdits", onEvent, resumeSessionId, onChild,
} = {}) {
  return new Promise((resolve) => {
    const st = engineStatus();
    if (!st.available) { resolve({ ok: false, error: "native engine unavailable", status: st }); return; }
    if (!prompt || !String(prompt).trim()) { resolve({ ok: false, error: "empty prompt" }); return; }
    // 与 claude-code.js 同一套静默超时策略：有输出就说明活着，只有连续无输出才算卡死。
    // 绝对上限兜底防「永远不结束」。可用 MYCLAUDE_ENGINE_IDLE_MS / MYCLAUDE_ENGINE_MAX_MS 覆盖。
    const envIdle = Number(process.env.MYCLAUDE_ENGINE_IDLE_MS);
    const envMax = Number(process.env.MYCLAUDE_ENGINE_MAX_MS);
    const idle = Math.max(5_000, Math.min(Number(timeoutMs) || (Number.isFinite(envIdle) && envIdle >= 5_000 ? envIdle : 180_000), 3_600_000));
    const ceiling = Math.max(idle, Math.min(Number(maxMs) || (Number.isFinite(envMax) && envMax >= 5_000 ? envMax : 3_600_000), 7_200_000));
    const args = buildEngineArgs({ model, permissionMode, resumeSessionId });
    let child;
    try {
      child = spawn(st.bun, args, {
        cwd: workdir || process.cwd(),
        env: engineEnv({ baseUrl, apiKey }),
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (e) { resolve({ ok: false, error: "spawn failed: " + e.message }); return; }
    // 把子进程交给调用方，便于中断/断连时杀掉（否则刷新页面会留下孤儿进程）
    if (onChild) { try { onChild(child); } catch { /* 观察者异常不影响回合 */ } }
    const state = newTranslateState();
    let buf = "", stderrTail = "", timedOut = false, timeoutKind = null, settled = false;
    let idleTimer = null, ceilingTimer = null;
    // 飞行中的工具调用数：>0 时引擎在等自己的工具，静默属正常（长命令本来就安静）
    let pendingTools = 0;
    const stopTimers = () => { if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; } if (ceilingTimer) { clearTimeout(ceilingTimer); ceilingTimer = null; } };
    const deadline = (kind) => {
      if (settled) return;
      timedOut = true; timeoutKind = kind;
      try { child.kill(); } catch { /* gone */ }
    };
    const bumpIdle = () => {
      if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
      // 有工具在飞行中 → 不设静默计时器：只受绝对上限约束
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
        if (!line) continue;
        pendingTools = Math.max(0, pendingTools + toolBalanceOf(line));
        const t = translateUpstreamLine(line, state);
        for (const ev of t.events) { if (onEvent) { try { onEvent(ev); } catch { /* 观察者异常不影响回合 */ } } }
      }
      // 处理完这一段再决定要不要武装静默计时器（顺序很重要）
      bumpIdle();
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (c) => { stderrTail = (stderrTail + c).slice(-2_000); });
    child.on("error", (e) => {
      if (settled) return;
      settled = true; stopTimers();
      resolve({ ok: false, error: "engine process error: " + e.message, state });
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true; stopTimers();
      resolve({
        ok: !timedOut && code === 0 && !state.isError,
        timedOut, timeoutKind, exitCode: code, stderrTail, pendingTools,
        idleMs: idle, ceilingMs: ceiling,
        sessionId: state.sessionId,
        result: state.resultText,
        assistantTexts: state.assistantTexts,
        toolUses: state.toolUses,
        resumedFrom: resumeSessionId || null,
        state,
      });
    });
    child.stdin.on("error", () => { /* EPIPE，忽略 */ });
    try { child.stdin.write(String(prompt)); child.stdin.end(); } catch { /* 同上 */ }
  });
}

/** 上游回合结束后：记住 session 绑定。调用方负责把消息写进 MyClaude 会话。 */
export function bindUpstreamSession(key, sessionId) {
  rememberEngineSession(key, sessionId);
}

/** 取某 MyClaude 会话绑定的上游 session id（供 /api/chat 续接）。 */
export function upstreamBoundSession(key) {
  return engineSessionFor(key);
}