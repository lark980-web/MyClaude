/**
 * Lifecycle hooks.
 *
 * Users declare shell commands in config that run at key points. Each hook
 * receives the event payload as JSON on stdin and may answer with JSON on
 * stdout to steer the agent. This is how you bolt on linting, secret
 * scanning, audit logging or policy without touching agent code.
 *
 * Config shape:
 *
 *   "hooks": {
 *     "PreToolUse": [
 *       { "matcher": "Bash",
 *         "hooks": [ { "type": "command", "command": "node check.js" } ] }
 *     ]
 *   }
 *
 * Exit-code contract (matches the convention the hooks ecosystem uses):
 *   0  -> stdout is parsed as JSON; unparseable output is ignored
 *   2  -> blocking error; stderr is fed back to the model as the reason
 *   other -> non-blocking failure, surfaced as a warning only
 */

import { spawn } from "node:child_process";

const DEFAULT_TIMEOUT_MS = 60000;

/** Shells a hook command may run under. */
const SHELLS = {
  powershell: { binary: "powershell.exe", args: (c) => ["-NoProfile", "-Command", c] },
  pwsh: { binary: "pwsh", args: (c) => ["-NoProfile", "-Command", c] },
  cmd: { binary: "cmd.exe", args: (c) => ["/d", "/s", "/c", c] },
  sh: { binary: "/bin/sh", args: (c) => ["-c", c] },
  bash: { binary: "bash", args: (c) => ["-c", c] },
};

/** Events that may carry a per-hook matcher. */
export const TOOL_EVENTS = new Set(["PreToolUse", "PostToolUse"]);

export const HOOK_EVENTS = [
  "UserPromptSubmit", "PreToolUse", "PostToolUse", "Notification", "Stop", "PreCompact", "SubagentStop"
];

/**
 * Does a matcher apply to this tool name?
 *
 * Empty or "*" matches everything; otherwise the matcher is treated as a
 * regular expression (as in "Edit|Write" or "^Bash$") with a plain-equality
 * fallback so a typo does not silently match nothing.
 */
export function matcherMatches(matcher, toolName) {
  const m = String(matcher == null ? "" : matcher).trim();
  if (!m || m === "*") { return true; }
  const name = String(toolName || "");
  try {
    if (new RegExp(m).test(name)) { return true; }
  } catch {
    return m === name;
  }
  return false;
}

/**
 * Interpret one hook process result into a decision object.
 *
 * @param {{code: number|null, stdout: string, stderr: string}} res
 * @returns {{block: boolean, reason: string, context: string, permission: string|null, systemMessage: string}}
 */
export function interpret(res) {
  const out = { block: false, reason: "", context: "", permission: null, systemMessage: "" };
  const code = res && res.code;

  if (code === 2) {
    out.block = true;
    out.reason = String(res.stderr || "").trim() || "hook blocked this action";
    return out;
  }
  if (code !== 0) {
    // Anything else is a broken hook, not a veto: warn but let the turn run.
    out.systemMessage = String(res.stderr || "").trim() || ("hook exited with code " + code);
    return out;
  }

  let data = null;
  try { data = JSON.parse(String(res.stdout || "").trim()); } catch { return out; }
  if (!data || typeof data !== "object") { return out; }

  if (data.continue === false) {
    out.block = true;
    out.reason = data.stopReason || "hook requested the agent stop";
  }
  if (data.decision === "block") {
    out.block = true;
    out.reason = data.reason || out.reason || "hook blocked this action";
  }
  if (typeof data.systemMessage === "string") { out.systemMessage = data.systemMessage; }

  const spec = data.hookSpecificOutput || {};
  if (spec.permissionDecision) { out.permission = spec.permissionDecision; }
  if (typeof spec.additionalContext === "string") { out.context = spec.additionalContext; }
  if (typeof data.supplementalContext === "string") { out.context += (out.context ? "\n" : "") + data.supplementalContext; }
  return out;
}

export class HookRunner {
  constructor({ config, cwd = process.cwd(), ui = null } = {}) {
    this.config = config || {};
    this.cwd = cwd;
    this.ui = ui;
    this.timeoutMs = Number(this.config.hookTimeoutMs) || DEFAULT_TIMEOUT_MS;
    // The shell matters on Windows: PowerShell does not forward stdin to child
    // processes, and the hook contract delivers the event payload on stdin, so a
    // PowerShell hook would silently receive nothing. cmd.exe passes stdin
    // through and resolves node via App Paths even when PATH is incomplete.
    // Set "hookShell": "powershell" only if a hook genuinely needs it.
    this.shellName = String(this.config.hookShell || (process.platform === "win32" ? "cmd" : "sh")).toLowerCase();
    this.lastRun = [];
  }

  get definitions() {
    return this.config.hooks && typeof this.config.hooks === "object" ? this.config.hooks : {};
  }

  /** True when at least one hook is configured for this event. */
  has(event, toolName) {
    return this.#plan(event, toolName).length > 0;
  }

  #plan(event, toolName) {
    const groups = this.definitions[event];
    if (!Array.isArray(groups)) { return []; }
    const commands = [];
    for (const group of groups) {
      if (!group) { continue; }
      if (TOOL_EVENTS.has(event) && !matcherMatches(group.matcher, toolName)) { continue; }
      for (const hook of group.hooks || []) {
        if (hook && hook.type !== "command" && hook.type) { continue; }
        const command = hook && (hook.command || hook.cmd);
        if (typeof command === "string" && command.trim()) { commands.push(command.trim()); }
      }
    }
    return commands;
  }

  /**
   * Run every hook registered for an event and merge their verdicts.
   *
   * A block from any hook wins; contexts accumulate; the last explicit
   * permission decision is the one applied.
   *
   * @param {string} event
   * @param {object} payload JSON handed to each hook on stdin
   */
  async run(event, payload = {}) {
    const commands = this.#plan(event, payload.tool_name);
    const merged = { block: false, reason: "", context: "", permission: null, systemMessage: "", ran: 0 };
    if (!commands.length) { return merged; }

    const input = JSON.stringify({
      hook_event_name: event,
      session_id: payload.session_id || this.config.sessionId || null,
      cwd: this.cwd,
      model: this.config.model || null,
      ...payload
    });

    for (const command of commands) {
      const res = await this.#exec(command, input);
      merged.ran++;
      this.lastRun.push({ event, command, code: res.code, stderr: res.stderr });
      if (this.lastRun.length > 50) { this.lastRun.shift(); }

      const verdict = interpret(res);
      if (verdict.block) { merged.block = true; merged.reason = merged.reason ? merged.reason + "\n" + verdict.reason : verdict.reason; }
      if (verdict.context) { merged.context += (merged.context ? "\n" : "") + verdict.context; }
      if (verdict.permission) { merged.permission = verdict.permission; }
      if (verdict.systemMessage) {
        merged.systemMessage += (merged.systemMessage ? "\n" : "") + verdict.systemMessage;
        if (this.ui && this.ui.warn) { this.ui.warn(`hook ${event}: ${verdict.systemMessage}`); }
      }
    }
    return merged;
  }

  #exec(command, input) {
    const spec = SHELLS[this.shellName] || SHELLS[process.platform === "win32" ? "cmd" : "sh"];
    const shell = spec.binary;
    const args = spec.args(command);
    return new Promise((resolvePromise) => {
      const child = spawn(shell, args, {
        cwd: this.cwd,
        windowsHide: true,
        env: { ...process.env, MYCLAUDE_HOOK_EVENT: "1" },
      });
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let grace = null;
      // On Windows the command usually runs through a .cmd wrapper, which
      // spawns node as a child; killing the wrapper would leave the hook alive
      // and the pipe open, so terminate the whole tree.
      let settled = false;
      const finish = (code) => {
        if (settled) { return; }
        settled = true;
        clearTimeout(timer);
        clearTimeout(grace);
        resolvePromise({ code, stdout, stderr });
      };

      const timer = setTimeout(() => {
        if (settled) { return; }
        timedOut = true;
        stderr += "\n[hook timed out after " + this.timeoutMs + "ms]";
        try {
          if (process.platform === "win32" && child.pid) {
            spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
          } else {
            child.kill("SIGKILL");
          }
        } catch {}
        // Killing the wrapper does not always close the inherited pipes: on
        // Windows the grandchild node process can keep them open, so the close
        // event may never fire. Resolve after a short grace period instead of
        // hanging the agent forever.
        grace = setTimeout(() => finish(-1), 1500);
        grace.unref?.();
      }, this.timeoutMs);

      child.stdout?.on("data", (c) => { stdout += c; });
      child.stderr?.on("data", (c) => { stderr += c; });
      child.on("error", (e) => {
        if (!stderr) { stderr = e.message; }
        finish(-1);
      });
      child.on("close", (code) => {
        finish(timedOut ? -1 : code);
      });
      // The payload arrives on stdin, which is how a hook reads its context.
      try {
        child.stdin.write(input);
        child.stdin.end();
      } catch {}
    });
  }
}
