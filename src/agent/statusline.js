/**
 * 状态行（statusLine）—— 阶段 2：从「只存配置」升级为「真执行外部命令」。
 *
 * 上游 2.1.302 的契约（实测来源，非猜测）：
 *   chunk-e0x0xb6d.js@2656002 的 statusLine setup agent 提示词给出了完整 stdin JSON；
 *   @3688311 的 Lbr() 是执行点：GH(...) 执行命令，stdin 传 JSON，
 *   取 D.status===0 时的 stdout，按 `trim().split(' ').flatMap(...).join(' ')` 压成单行。
 *
 * stdin JSON 字段（上游口径）：
 *   session_id, session_name, prompt_id, transcript_path, cwd,
 *   model{id,display_name}, workspace{current_dir,project_dir,added_dirs,git_worktree,repo{host,owner,name}},
 *   version, output_style{name},
 *   context_window{total_input_tokens,total_output_tokens,context_window_size,
 *     current_usage{input_tokens,output_tokens,cache_creation_input_tokens,cache_read_input_tokens}|null,
 *     used_percentage|null, remaining_percentage|null},
 *   effort{level}（可选）
 */

import { spawn } from "node:child_process";
import { VERSION } from "../version.js";

const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_OUTPUT_CHARS = 2_000;

/**
 * 按上游 StatusLineCommandInput 构造 stdin JSON。
 * 缺失的信息一律用 null / 空值，不编造。
 */
export function buildStatusLineInput({
  sessionId, sessionName, promptId, transcriptPath, cwd, model,
  projectDir, addedDirs, gitWorktree, repo, outputStyle, contextWindow, effort,
} = {}) {
  const used = contextWindow && Number(contextWindow.contextWindowSize) > 0
    ? Math.round((Number(contextWindow.totalInputTokens || 0) / Number(contextWindow.contextWindowSize)) * 100)
    : null;
  return {
    session_id: sessionId || "",
    session_name: sessionName || null,
    prompt_id: promptId || null,
    transcript_path: transcriptPath || null,
    cwd: cwd || process.cwd(),
    model: {
      id: (model && model.id) || "",
      display_name: (model && model.displayName) || (model && model.id) || "",
    },
    workspace: {
      current_dir: cwd || process.cwd(),
      project_dir: projectDir || cwd || process.cwd(),
      added_dirs: Array.isArray(addedDirs) ? addedDirs : [],
      git_worktree: gitWorktree || null,
      repo: repo || null,
    },
    version: VERSION,
    output_style: { name: (outputStyle && outputStyle.name) || "default" },
    context_window: {
      total_input_tokens: Number((contextWindow && contextWindow.totalInputTokens) || 0),
      total_output_tokens: Number((contextWindow && contextWindow.totalOutputTokens) || 0),
      context_window_size: Number((contextWindow && contextWindow.contextWindowSize) || 0),
      current_usage: contextWindow && contextWindow.currentUsage ? {
        input_tokens: Number(contextWindow.currentUsage.input_tokens || 0),
        output_tokens: Number(contextWindow.currentUsage.output_tokens || 0),
        cache_creation_input_tokens: Number(contextWindow.currentUsage.cache_creation_input_tokens || 0),
        cache_read_input_tokens: Number(contextWindow.currentUsage.cache_read_input_tokens || 0),
      } : null,
      used_percentage: used,
      remaining_percentage: used === null ? null : Math.max(0, 100 - used),
    },
    ...(effort && effort.level ? { effort: { level: String(effort.level) } } : {}),
  };
}

/** 上游把 stdout 压成单行：trim → 按空格切 → 丢空段 → 空格 join。 */
export function normalizeStatusLineOut(stdout) {
  return String(stdout || "")
    .trim()
    .split(" ")
    .flatMap((q) => q.trim() || [])
    .join(" ")
    .slice(0, MAX_OUTPUT_CHARS);
}

/**
 * 执行一次状态行命令。失败一律返回 null（状态行是装饰，绝不能拖垮主流程）。
 *
 * @returns {Promise<{ok:boolean, text:string|null, error:string|null, command:string}>}
 */
export function runStatusLine({ command, input, cwd: workdir, timeoutMs } = {}) {
  return new Promise((resolve) => {
    const cmd = String(command || "").trim();
    if (!cmd) { resolve({ ok: false, text: null, error: "no statusLine command configured", command: cmd }); return; }
    const timeout = Math.max(500, Math.min(Number(timeoutMs) || DEFAULT_TIMEOUT_MS, 30_000));
    let child;
    try {
      child = spawn(cmd, {
        cwd: workdir || process.cwd(),
        shell: true,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (e) { resolve({ ok: false, text: null, error: "spawn failed: " + e.message, command: cmd }); return; }
    let out = "", errTail = "", timedOut = false, settled = false;
    const timer = setTimeout(() => { timedOut = true; try { child.kill(); } catch { /* gone */ } }, timeout);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (c) => { out = (out + c).slice(-MAX_OUTPUT_CHARS * 4); });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (c) => { errTail = (errTail + c).slice(-500); });
    child.on("error", (e) => {
      if (settled) return; settled = true; clearTimeout(timer);
      resolve({ ok: false, text: null, error: "process error: " + e.message, command: cmd });
    });
    child.on("close", (code) => {
      if (settled) return; settled = true; clearTimeout(timer);
      if (timedOut) { resolve({ ok: false, text: null, error: "timeout", command: cmd }); return; }
      if (code !== 0) {
        resolve({ ok: false, text: null, error: "exit " + code + (errTail ? ": " + errTail.trim().slice(0, 160) : ""), command: cmd });
        return;
      }
      const text = normalizeStatusLineOut(out);
      resolve({ ok: true, text: text || null, error: null, command: cmd });
    });
    child.stdin.on("error", () => { /* EPIPE，忽略 */ });
    try {
      child.stdin.write(JSON.stringify(input || {}));
      child.stdin.end();
    } catch { /* 同上 */ }
  });
}