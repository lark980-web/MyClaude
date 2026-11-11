import { estimateTextTokens } from "../tokens.js";
import { findTool, toolSchemas } from "../tools/index.js";
import { ProviderRouter } from "../providers/router.js";
import { PermissionEngine, loadMemory } from "./permissions.js";
import { normalizeMode, isCommonFileCommand, isDestructiveCommand, FILE_EDIT_TOOLS } from "./modes.js";
import { isAutoApprovable, autoApprovalBlockerAsync } from "./command-safety.js";
import { initUpstreamSafety } from "./upstream-safety.js";
import { reviewToolCall } from "./auto-review.js";
import { outputStyleFragment, outputStyleTurnReminder } from "../output-style.js";
import { SYSTEM_PROMPT, AUTONOMY_SECTION } from "./prompt.js";
import { buildUserContent, buildToolAttachmentContent, resolveAttachments } from "../attachments.js";
import { setQuestionPresenter } from "../tools/extended.js";
import { HookRunner } from "../hooks.js";
import { stripReasoning } from "./think.js";
import { CheckpointStore } from "./checkpoint.js";
import { listTasks } from "../tools/tasks.js";
import { skillCatalogue } from "../skills.js";
import { contextWindowOf, maxTokensOf, supportsVision, findModel } from "../models.js";
import { CONFIG_DIR } from "../config.js";
import { join } from "node:path";

/**
 * The heading that marks the part of the project memory which governs how
 * work is done, rather than what the project contains.
 *
 * It is pulled out of the memory and put at the front of the system prompt,
 * because a rule that shapes every later decision should not arrive after
 * the details it governs.
 */
const CORE_RULES_HEADING = "## 核心要义";

/**
 * Split the project memory into the core rules and the rest.
 *
 * @param {string} memory
 * @returns {{core: string, rest: string}}
 */
function splitCoreRules(memory) {
  const text = String(memory || "");
  const at = text.indexOf(CORE_RULES_HEADING);
  if (at < 0) { return { core: "", rest: text }; }
  // The section runs until the next heading of the same level.
  const after = text.indexOf("\n## ", at + CORE_RULES_HEADING.length);
  const end = after < 0 ? text.length : after;
  return { core: text.slice(at, end).trim(), rest: (text.slice(0, at) + text.slice(end)).trim() };
}

/**
 * Turn a session key into a directory name.
 *
 * Session keys are timestamps plus an id, but a caller may pass anything, so
 * path separators and drive letters are stripped before the key becomes part of
 * a filesystem path.
 */
function safeSessionKey(key) {
  const cleaned = String(key || "default").replace(/[\\/:*?"<>|]+/g, "-");
  return cleaned || "default";
}

/** Tools that never touch the filesystem, so they never need approval. */
const NON_MUTATING_TOOLS = new Set([
  "TodoWrite",
  "AskUserQuestion",
  "ExitPlanMode",
  "EnterPlanMode",
  "Skill",
  "BashOutput",
  "GitStatus",
  "GitDiff",
  "GitLog",
]);

/**
 * reasoning 通道的最后一段。推理模型把整段答复写进 reasoning_content、
 * content 留空时，这是唯一还可读的正文来源。超长只取尾部，避免整段思考灌进界面。
 */
function lastReasoningParagraph(raw) {
  const s = String(raw || "").trim();
  if (!s) return "";
  const parts = s.split(/\n\s*\n/).map((x) => x.trim()).filter(Boolean);
  const tail = parts[parts.length - 1] || s;
  return tail.length > 1200 ? tail.slice(-1200) : tail;
}

/**
 * 确定性兜底：连收尾请求都失败时，用本轮真实执行过的工具生成结论，
 * 而不是把问题推回给用户（旧版在这里输出的是一句让用户自己再问一次的占位文案）。
 */
/**
 * 空正文补救的配额与文案（会话审计 §1.2 / §1.3 R1+R2）。
 *
 * 旧实现：上限写死为「每回合 2 次」，且计数器在每次 run() 开头归零 ——
 * 用户每发一条消息就重新获得 2 条**逐字节完全相同**的系统消息。
 * 实测（会话 2026-11-08T11-44-52_9d93d2）用户连续看到 3 条一模一样的
 * 「[系统] 上一条回复只有思考过程、没有正文…」，既无信息量也像故障。
 *
 * 现在：配额按**会话时间窗**计（不随回合归零），且每次注入给不同约束。
 * 审计明确不推荐单纯把次数调大 —— 那只会让病态时更多雷同消息涌进对话历史。
 */
const EMPTY_BODY_WINDOW_MS = 60_000;
// 两个上限并存：
//  - **每回合 2 次**：保持原有的补救节奏（催两次不成，就直接用 reasoning 尾段兜底）。
//    审计明确警告过「不要单纯把次数调大」—— 那只会让病态时更多雷同消息涌进历史。
//  - **每会话 60 秒窗口 4 次**：密钥在于它**不随回合归零**。旧写法每次 run() 归零，
//    用户每发一条消息就重新拿到 2 条配额，于是连续看到一模一样的系统消息。
const EMPTY_BODY_MAX_PER_TURN = 2;
const EMPTY_BODY_MAX_PER_WINDOW = 4;
const EMPTY_BODY_HINTS = [
  "请直接写出给用户的最终结论（中文正文，不要调用工具）。",
  "这次务必直接输出正文；内容多就先给一句话结论，再补细节。",
  "不要再思考了 —— 用中文把结论写出来，哪怕只有一句话。",
  "最后一次提醒：请输出面向用户的正文，不要再调用工具。",
];

function summarizeTurn(messages) {
  const names = [];
  let tail = "";
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === "tool") {
      if (!tail && typeof m.content === "string") tail = m.content.trim().slice(-260);
      names.push(m.name || m.tool_call_id || "工具");
    } else if (m.role === "user" && names.length) { break; }
  }
  const head = names.length
    ? "本轮共执行 " + names.length + " 个工具操作，模型未输出文字结论。"
    : "模型本轮未输出文字结论。";
  // 审计 §1.3 R3 / N7：这是**确定性兜底**，不是模型写的正文。
  // 以前它在界面上与模型正文完全无从分辨，用户会以为模型就是这么说的话。
  return "[自动摘要，非模型原文 —— 可以让我重说一遍]" + "\n\n" + head +
    (tail ? "\n\n最后一步工具输出（节选）：\n" + tail : "");
}

export class Agent {
  constructor({ provider, config, ui, tools = toolSchemas(), permissions, sessionKey }) {
    // 上游判定桥要加载 2433 模块的提取树（首次约 2-4 秒），在构造期就预热，
    // 免得第一次 Bash 权限判定时用户干等。失败也不影响：桥会退回自研启发式。
    initUpstreamSafety().catch(() => {});
    this.provider = provider;
    // Wrap the provider so a failing endpoint can fall back to another model.
    // The router owns the active provider; `this.provider` stays the entry point
    // for callers that only want the current one.
    this.router = new ProviderRouter({
      config,
      provider,
      fallbacks: config.fallbacks || [],
      onSwitch: (cfg, reason, extra) => this.onProviderSwitch(cfg, reason, extra)
    });
    this.config = config;
    this.ui = ui;
    this.tools = tools;
    this.messages = [];
    this.abortController = null;
    // Set by abort() and honoured at the next turn boundary: the per-turn
    // AbortController below would otherwise silently discard an abort that
    // landed while a tool was running, and the task would carry on.
    this.stopRequested = false;
    // Resolve the model's real limits instead of assuming one global number:
    // the catalogue carries per-model context window and token ceiling, and a
    // 1M-token model must not be compacted on a 200k model's schedule.
    // The catalogue is the hard ceiling; the config value is a user CAP on
    // top of it. The gateway advertises 1M for this model, but every turn
    // re-sends the whole history, so a wide window meant slow, expensive
    // turns rather than better answers - the config value existed and did
    // nothing.
    const catalogueWindow = contextWindowOf(config.model);
    const configuredWindow = Number(config.contextWindow) || 0;
    this.contextWindow = configuredWindow > 0 ? Math.min(catalogueWindow, configuredWindow) : catalogueWindow;
    this.maxTokens = maxTokensOf(config.model);
    this.turnCount = 0;
    // Files touched by the current turn, so /rewind can put them back.
    // Snapshots go under ~/.myclaude/checkpoints/<session> so /rewind can undo a
    // change after a restart. A session without a key writes to "default".
    const checkpointDir = join(CONFIG_DIR, "checkpoints", safeSessionKey(sessionKey));
    this.checkpoints = new CheckpointStore({ persistDir: checkpointDir });
    // Guards the Stop hook so it can only extend a run once.
    this.stopHookUsed = false;
    // Session identity comes from the caller: the GUI keeps one agent per tab,
    // so a hard-coded "default" made every tab share todos and task lists.
    this.sessionKey = sessionKey || config.sessionKey || "default";
    this.mcp = null;
    this.totalInputTokens = 0;
    this.totalOutputTokens = 0;
    this.permissions =
      permissions instanceof PermissionEngine
        ? permissions
        : new PermissionEngine(config.permissions || {});
    // Auto mode normally never asks. A destructive command can still ask
    // when the user opted in, because running one unattended is expensive
    // to undo. The switch lives in the config so the default behaviour of
    // existing setups does not change.
    this.askOnDestructive = !!(config.permissions && config.permissions.askOnDestructive);
    this.planMode = normalizeMode(config.permissionMode) === "plan";
    this.memory = loadMemory(process.cwd());
    this.hooks = new HookRunner({ config, cwd: process.cwd(), ui });
    this.systemPrompt = this.buildSystemPrompt();
    // AskUserQuestion / ExitPlanMode need a presenter; bind it per agent so a
    // GUI or TUI session always routes prompts to its own UI.
    if (typeof ui?.askQuestions === "function") setQuestionPresenter(ui.askQuestions);
  }

  /** Attach a new UI (one HTTP response per GUI turn) and rebind interactive tools. */
  setUi(ui) {
    this.ui = ui;
    if (typeof ui?.askQuestions === "function") setQuestionPresenter(ui.askQuestions);
    return ui;
  }

  /**
   * Called by the router when a request fails over to another model.
   *
   * @param {object} cfg the candidate being used or that just failed
   * @param {"failing"|"recovered"} reason
   * @param {object} [extra]
   */
  onProviderSwitch(cfg, reason, extra) {
    if (reason === "failing" && extra && extra.next) {
      const err = extra.error;
      const why = err && (err.status ? `HTTP ${err.status}` : String(err.message || "").slice(0, 80));
      this.ui.warn(`${cfg.model} failed (${why}) \u2014 switching to ${extra.next.model}`);
      return;
    }
    if (reason === "recovered") {
      this.ui.info(`now answering with ${cfg.model}`);
    }
  }

  /**
   * Switch the active model at runtime.
   *
   * The router holds the live provider, so it must be updated too; otherwise a
   * later failover would resurrect the previous model.
   */
  setModel(model) {
    if (!model) return this.router.model;
    this.config.model = model;
    // Keep the compaction schedule and output ceiling in step with the model.
    this.contextWindow = contextWindowOf(model);
    this.maxTokens = maxTokensOf(model);
    this.router.provider.model = model;
    this.provider.model = model;
    return this.router.model;
  }

  /** Current routing state, surfaced in the GUI inspector. */
  routingStatus() {
    return this.router.status();
  }

  /** Whether image attachments are forwarded to the model. */
  get vision() {
    return this.config.vision !== false;
  }



  buildSystemPrompt() {
    // The core rules come first: they decide how the rest is done.
    const { core, rest } = splitCoreRules(this.memory || "");
    const parts = [];
    if (core) {
      parts.push(`\n\n# Core project rules\n\n${core}\n\n` +
        "These rules govern how work is done here. They are not suggestions: when they " +
        "conflict with a habit or a general assumption, follow them.");
    }
    parts.push(SYSTEM_PROMPT);
    // 自主模式（autoRun / 长目标自动续跑）：注入上游 autonomy_append 段。
    // 只在该模式下注入 —— 普通交互里「不必确认」会与用户的即时确认预期冲突。
    if (this.config && this.config.autoRun) { parts.push("\n\n" + AUTONOMY_SECTION); }
    // Output style (/output-style)：reshape how the assistant communicates.
    const styleFrag = outputStyleFragment(this.config.outputStyle);
    if (styleFrag) { parts.push("\n\n" + styleFrag); }
    // Extra working directories registered with /add-dir: telling the model
    // where else it may look is what makes them usable.
    if (Array.isArray(this.config.additionalDirectories) && this.config.additionalDirectories.length) {
      parts.push("\n\n# Additional working directories\n" +
        this.config.additionalDirectories.map((d) => "- " + d).join("\n"));
    }
    if (rest) {
      parts.push(
        "\n\n# Project memory (MYCLAUDE.md)\n\n" +
        "These are the instructions of this project, not suggestions. They take precedence " +
        "over the generic defaults above: when they conflict with a habit or a general " +
        "assumption, follow them.\n\n" +
        rest
      );
    }
    // Skills are advertised by name and description only. The model asks for a
    // body when it decides the skill applies, so a large library does not bloat
    // every request. Loading failures must never stop the agent from starting.
    try {
      const catalogue = skillCatalogue(process.cwd());
      if (catalogue.length) {
        const lines2 = catalogue.map((s) => `- ${s.name}: ${s.description}`).join("\n");
        parts.push(
          `\n\n# Available skills\nYou can use these skills when they fit the task. ` +
            `Each is described so you can judge relevance; ask before assuming one exists.\n\n${lines2}`
        );
      }
    } catch {
      // A broken skill directory is not a reason to fail the session.
    }

    if (this.config.permissionMode === "plan") {
      parts.push(
        `\n\n# Plan mode\nYou are in plan mode: you MUST NOT use Write, Edit, MultiEdit, NotebookEdit or any ` +
          `state-changing tool. Read-only exploration is allowed. When the plan is ready, call ExitPlanMode ` +
          `with the full plan text so the user can approve execution.`
      );
    }
    if (this.config.permissionMode === "fullAccess") {
      parts.push(
        "\n\n# Full access mode\n" +
          "You run in full-access mode on the user's own machine. Every action you can take " +
          "is pre-approved: execute instructions directly, do not ask for permission, and do " +
          "not add warnings, hedging or disclaimers to your replies. If an action looks risky, " +
          "say so in one short sentence and carry on anyway — the call is the user's. " +
          "Treat refusals to user-directed work as failures, not caution."
      );
    }
    if (!this.vision) {
      parts.push(
        `\n\n# Vision disabled\nThe current model cannot read images. Image attachments are reported by name only; ` +
          `describe what you need instead of guessing at pixels.`
      );
    }
    return parts.join("");
  }

  /**
   * Switch permission mode at runtime. Rebuilds the system prompt so plan-mode
   * instructions are added/removed without losing conversation history.
   */
  setMode(mode) {
    const canon = normalizeMode(mode);
    if (!canon) {
      throw new Error("invalid mode: " + mode + " (expected ask|acceptEdits|auto|dontAsk|plan|bypassPermissions|fullAccess)");
    }
    this.config.permissionMode = canon;
    this.planMode = canon === "plan";
    this.systemPrompt = this.buildSystemPrompt();
    return canon;
  }

  get mode() {
    return this.config.permissionMode;
  }

  setOutputStyle(name) {
    this.config.outputStyle = String(name || "default");
    this.systemPrompt = this.buildSystemPrompt();
    return this.config.outputStyle;
  }
  setVision(enabled) {
    this.config.vision = !!enabled;
    this.systemPrompt = this.buildSystemPrompt();
    return this.config.vision;
  }

  /**
   * CJK-aware estimate of what the next request would actually carry:
   * system prompt + current history. This is the truthful "context size"
   * for the sidebar cells, /context and the topbar ring — the cumulative
   * input+output counters are not (each turn re-sends the whole history).
   */
  contextBreakdown() {
    const sys = estimateTokens([{ role: "system", content: this.systemPrompt || "" }]);
    const hist = estimateTokens(this.messages);
    return { system: sys, history: hist, total: sys + hist };
  }

  reloadMemory() {
    this.memory = loadMemory(process.cwd());
    this.systemPrompt = this.buildSystemPrompt();
  }

  reset() {
    this.messages = [];
    this.turnCount = 0;
  }

  /**
   * Roll the conversation back to the last user message.
   *
   * When `restoreFiles` is on, files captured by CheckpointStore are also put
   * back. Without that, rewinding left the workspace holding whichever edits
   * the discarded turns had already made.
   */
  rewind(text, { restoreFiles = false, depth = 1 } = {}) {
    let files = null;
    if (restoreFiles) {
      try { files = this.checkpoints.restoreAll(); } catch { files = null; }
    }

    // 第 depth 条（从最后往前数）用户消息；depth=1 即最后一条。
    let target = -1;
    let seen = 0;
    for (let i = this.messages.length - 1; i >= 0; i--) {
      if (this.messages[i].role === "user") {
        seen++;
        if (seen === depth) { target = i; break; }
      }
    }
    if (target < 0) return { rewound: 0, lastUser: null, files };

    if (depth === 1) {
      // 原语义（/rewind 与 GUI 编辑重发共用）：撤掉该提问之后的回合，
      // 并就地替换提问文本 —— 随后 run("", { reuseLastUser: true }) 重放循环。
      const dropped = this.messages.length - target - 1;
      this.messages = this.messages.slice(0, target + 1);
      if (typeof text === "string" && text.trim()) {
        this.messages[target] = { role: "user", content: text };
      }
      return { rewound: dropped, lastUser: this.messages[target], files };
    }

    // depth > 1（Esc+Esc 选更早的消息）：连这条提问一起撤掉，
    // 编辑后的文本由调用方作为新提问重新发来，不产生重复。
    const dropped = this.messages.length - target;
    this.messages = this.messages.slice(0, target);
    return { rewound: dropped, lastUser: null, files };
  }

  /**
   * Fire the SessionStart hook.
   *
   * @param {string} source "startup" or "resume" - why this agent exists
   */
  async sessionHook(source) {
    if (this.hooks && this.hooks.has("SessionStart")) {
      await this.hooks.run("SessionStart", { source: source || "startup", session_id: this.sessionKey, cwd: process.cwd() });
    }
    return this;
  }

  /**
   * Fire the SessionEnd hook on the exits we can await.
   *
   * A hard crash fires neither this nor anything else async - same as Claude.
   *
   * @param {string} reason "exit" | "clear" | "rotate" | "delete"
   */
  async sessionEnd(reason) {
    if (this.hooks && this.hooks.has("SessionEnd")) {
      await this.hooks.run("SessionEnd", { reason: reason || "exit", session_id: this.sessionKey, cwd: process.cwd() });
    }
    return this;
  }

  abort() {
    this.stopRequested = true;
      this.abortController?.abort();
  }

  buildRequestMessages() {
    const system = [{ role: "system", content: this.systemPrompt }];
    if (!this.config.fastMode) { return system.concat(this.messages); }
    return system.concat(this.fastWindow());
  }

  /**
   * The fast-mode slice of history.
   *
   * The newest fastModeMessages entries, extended backwards to the nearest
   * user message: a turn always begins with a user message, so the window
   * never opens mid-turn and every tool_call it contains keeps its tool
   * result. A window that orphaned a tool result would be rejected by the
   * provider outright.
   */
  fastWindow() {
    const msgs = this.messages;
    const max = Math.max(2, Number(this.config.fastModeMessages) || 24);
    if (msgs.length <= max) { return msgs; }
    let start = msgs.length - max;
    while (start > 0 && msgs[start].role !== "user") { start--; }
    return msgs.slice(start);
  }

  /** Tools that never mutate the workspace; allowed without prompting in plan mode. */
  static READ_ONLY_TOOLS = new Set([
    "Read",
    "GitStatus",
    "GitDiff",
    "GitLog",
    "LS",
    "Glob",
    "Grep",
    "WebFetch",
    "WebSearch",
    "NotebookRead",
    "TodoWrite",
    "AskUserQuestion",
    "ExitPlanMode",
    "BashOutput",
  ]);

  /** Deny list of tools that mutate state, blocked while in plan mode. */
  static PLAN_MODE_BLOCKED = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit", "Bash", "KillShell"]);

  async askPermission(toolName, args) {
    const mode = this.config.permissionMode;

    // fullAccess short-circuits before the rule engine: it is the explicit "run
    // whatever the model asks for" choice, so a stale deny rule must not silently
    // override what the user just selected. bypassPermissions keeps the rules —
    // that is the difference between the two.
    if (mode === "fullAccess") return true;

    // Plan mode is read-only, and that outranks a permissive allow rule: the
    // old order returned true on verdict === "allow" before this check, so
    // configuring allow: ["Write(**)"] silently disabled plan mode.
    if (mode === "plan" && !Agent.READ_ONLY_TOOLS.has(toolName)) {
      this.ui.warn(`plan mode: ${toolName} is blocked until the plan is approved`);
      return false;
    }

    const verdict = this.permissions.evaluate(toolName, args);
    if (verdict === "deny") {
      this.ui.warn(`denied by permission rule: ${toolName}`);
      return false;
    }
    if (verdict === "allow") return true;

    // Pure bookkeeping tools (todo list, clarification prompts, reading
    // background output) cannot touch the workspace, so prompting for them only
    // costs the user a click. They are always allowed.
    if (NON_MUTATING_TOOLS.has(toolName)) return true;

    // Reading and searching are safe in every mode, not just plan: gating them
    // behind a prompt (or auto-denying them under dontAsk) would leave the
    // agent unable to do anything at all.
    if (Agent.READ_ONLY_TOOLS.has(toolName)) return true;

    if (mode === "bypassPermissions") return true;

    if (mode === "acceptEdits") {
      // acceptEdits covers edits and the commands that surround them: build,
      // test, install, git add/commit, mkdir, redirect a file. What still asks
      // is what can destroy data or hide its own behaviour — a forced delete,
      // a force push, a subshell, an encoded payload, a write into .git.
      // Claude gates the same decision on a shell AST (chunk-41tke5jp.js);
      if (FILE_EDIT_TOOLS.has(toolName)) return true;
      // 上游 Claude Code 的真实判定 + MyClaude 自研闸，取更紧的一道（见 command-safety.js）
      if (toolName === "Bash" && (await autoApprovalBlockerAsync(args && args.command)) === null) return true;
    }

    // "auto" is the user saying "do not ask me". A destructive command still
    // asks when the user opted in, because the mode only covers the tools
    // that are safe to run unattended.
    if (mode === "auto") {
      if (toolName === "Bash" && this.askOnDestructive && isDestructiveCommand(args && args.command)) {
        this.ui.warn("auto mode: this command looks destructive, asking first");
        // 上游 Notification hook：需要用户确认时通知（chunk-9fg8a8zw.js worker_permission_prompt）
        if (this.hooks.has("Notification")) {
          await this.hooks.run("Notification", { message: `auto mode: destructive command needs confirmation: ${toolName}`, notification_type: "permission_request" });
        }
        return this.ui.confirmTool(toolName, args);
      }
      // Auto mode promises "no routine prompts", and in Claude a reviewer model
      // decides what counts as routine. Without it this was "run everything",
      // which is a different promise. The reviewer only answers whether a human
      // should look; an unreadable answer falls through to asking rather than
      // being taken as permission.
      if (this.config.autoReview) {
        const verdict = await reviewToolCall(this.router, toolName, args);
        if (verdict.allow === false) {
          this.ui.warn(`auto review: ${verdict.reason} — asking`);
          if (this.hooks.has("Notification")) {
            await this.hooks.run("Notification", { message: `auto review blocked: ${toolName} — ${verdict.reason}`, notification_type: "permission_request" });
          }
          return this.ui.confirmTool(toolName, args);
        }
        if (verdict.allow === null) {
          this.ui.warn(`auto review: ${verdict.reason} — falling back to asking`);
          if (this.hooks.has("Notification")) {
            await this.hooks.run("Notification", { message: `auto review inconclusive: ${toolName}`, notification_type: "permission_request" });
          }
          return this.ui.confirmTool(toolName, args);
        }
      }
      return true;
    }

    if (mode === "dontAsk") {
      // The user opted out of prompts entirely: refuse rather than ask.
      this.ui.warn(`don't ask: ${toolName} was auto-denied`);
      return false;
    }

    // ask 模式 + 非 auto 路径的确认：Notification hook 通知用户需要确认
    if (this.hooks.has("Notification")) {
      await this.hooks.run("Notification", { message: `tool needs confirmation: ${toolName}`, notification_type: "permission_request" });
    }
    return this.ui.confirmTool(toolName, args);
  }

  /**
   * Ask the model for the next turn.
   *
   * @param {string} userInput
   * @param {object} [options]
   * @param {Array} [options.attachments]
   * @param {boolean} [options.reuseLastUser] replay the existing last user
   *   message instead of appending a new one (used by Retry)
   */
  /**
   * 一次用户回合：跑循环，再保证有一个可读的结论。
   *
   * 循环自己会在「模型只思考不写正文」时提前返回，错误路径也会直接返回 ——
   * 收尾因此放在循环之外兜一层，而不是散落在每个 return 前。
   */
  async run(userInput, opts = {}) {
    this._finalizeUsed = false;
    // 每回合配额照旧归零（保住补救节奏）；**会话窗口**不归零 —— 这才是审计指出的病灶：
    // 旧写法只有「每回合 2 次」这一个上限，用户每发一条消息就重新拿到 2 条雷同系统消息。
    this._emptyBodyRetries = 0;
    this._emptyBodyInjections = (this._emptyBodyInjections || []).filter((ts) => Date.now() - ts < EMPTY_BODY_WINDOW_MS);
    const result = await this.runLoop(userInput, opts);
    if (!result) return result;
    // 这些结局不该被收尾请求改写：达到轮次上限/被中断/被钩子拦下/用户停止。
    if (result.maxTurnsReached || result.interrupted || result.blocked || this.stopRequested) { return result; }
    await this.ensureFinalAnswer();
    return result;
  }

  /**
   * 收尾请求：一次不带工具、预算很小的补问，只为拿到一段给用户看的正文。
   *
   * 用**自己的 AbortController**。旧实现复用 this.abortController，而浏览器刷新会触发
   * res.close → agent.abort()，把收尾请求一并打死；它还自带 15s 定时器自杀。
   * 两次都失败时退回确定性摘要，不把问题推回给用户。
   */
  async ensureFinalAnswer() {
    if (this._finalizeUsed) { return; }
    this._finalizeUsed = true;
    const last = this.messages[this.messages.length - 1];
    // 已经是带正文的 assistant 结尾：不需要再问一次。
    if (last && last.role === "assistant" && !Array.isArray(last.tool_calls) && String(last.content ?? "").trim()) { return; }

    const instruction = {
      role: "user",
      content: "[系统] 这一轮已经结束。请用中文直接写出给用户的最终结论：做了什么、结果如何、还有什么没做。不要调用工具，不要只思考。",
    };
    const base = this.buildRequestMessages();
    const localAbort = new AbortController();
    const timer = setTimeout(() => { try { localAbort.abort(); } catch {} }, 30000);
    let lastErr = null;
    let closing = null;
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        if (this.stopRequested) { return; }
        // 第二次只带系统提示 + 收尾指令：长历史刚被打断过一次，重发全部只会再挂一次。
        const messages2 = attempt === 0 ? base.concat([instruction]) : [base[0], instruction];
        try {
          closing = await this.router.streamChat({
            maxTokens: this.maxTokens,
            messages: messages2,
            tools: [],
            signal: localAbort.signal,
          });
          if (closing) { break; }
        } catch (e) {
          lastErr = e;
          if (localAbort.signal.aborted) { break; }
        }
      }
    } finally {
      clearTimeout(timer);
    }

    let text = stripReasoning(closing && closing.text ? closing.text : "").trim();
    if (!text) { text = lastReasoningParagraph(closing && closing.reasoning ? closing.reasoning : ""); }
    if (!text) {
      text = summarizeTurn(this.messages);
      if (lastErr) {
        this.ui.warn("结语生成失败：" + String((lastErr && lastErr.message) || lastErr) + "；已用工具执行摘要代替。");
      }
    }
    this.messages.push({ role: "assistant", content: text });
    this.ui.streamText(text);
    if (closing && closing.finishReason) { this.lastFinishReason = closing.finishReason; }
    this.ui.endStream();
  }

  async runLoop(userInput, { attachments, reuseLastUser } = {}) {
    // A previous stop must not brick this agent: the flag is checked at every
    // turn boundary, so without the reset every later run instantly returned
    // (interrupted) — "I stopped a task and now nothing runs".
    this.stopRequested = false;
    if (!reuseLastUser) {
      // UserPromptSubmit may veto the turn or inject extra context alongside it.
      if (this.hooks.has("UserPromptSubmit")) {
        const verdict = await this.hooks.run("UserPromptSubmit", { prompt: String(userInput || "") });
        if (verdict.systemMessage) { this.ui.warn(verdict.systemMessage); }
        if (verdict.block) {
          this.ui.warn(`prompt blocked by hook: ${verdict.reason}`);
          return { blocked: true, reason: verdict.reason };
        }
        if (verdict.context) {
          this.messages.push({ role: "user", content: "[hook context]\n" + verdict.context });
        }
        // 上游 additionalContexts（数组）逐条注入（chunk-1j09a7h8.js hook_additional_context）
        for (const cx of verdict.contexts) {
          this.messages.push({ role: "user", content: "[hook context]\n" + cx });
        }
      }
      // 上游 Notification hook：回合完成时通知用户（task_complete 语义）
      if (this.hooks.has("Notification") && this.turnCount > 0) {
        try { await this.hooks.run("Notification", { message: "turn completed", notification_type: "task_complete" }); } catch {}
      }
      const resolved = await resolveAttachments(attachments);
      const bad = resolved.filter((a) => a.kind === "error");
      for (const a of bad) this.ui.warn(`attachment skipped: ${a.name} — ${a.error}`);
      const usable = resolved.filter((a) => a.kind !== "error");

      // 输出样式的逐回合提醒（上游 chunk-e0x0xb6d.js turnReminder 机制）：
      // 样式激活时每个用户回合随文注入；等待后台任务时切换 waitingTurnReminder。
      // default 无提醒；走 [系统] 约定（prompt.js：harness 注入、非用户原文）。
      let bgWaiting = false;
      try { const { listTasks } = await import("../tools/tasks.js"); bgWaiting = listTasks().some((t) => t.status === "running"); } catch { bgWaiting = false; }
      const styleReminder = outputStyleTurnReminder(this.config.outputStyle, {
        waiting: bgWaiting,
      });
      const turnText = styleReminder && typeof userInput === "string"
        ? userInput + "\n\n[系统] output-style 提醒：" + styleReminder
        : userInput;
      this.messages.push({
        role: "user",
        content: buildUserContent(turnText, usable, { vision: this.vision }),
      });
    }

    const pendingImages = [];
    // Each run gets its own Stop-hook budget.
    this.stopHookUsed = false;

    // Files this run touched via Edit/Write/MultiEdit — the "Turn" scope of
    // the changes panel. Reset once per run (not per model turn): resetting
    // inside the turn loop wiped the set after the final text-only turn, so
    // the panel showed nothing even though the agent had just written files.
    this.turnFiles = new Set();
    for (let turn = 0; turn < this.config.maxTurns; turn++) {
      if (this.stopRequested) {
        this.ui.info("\n(interrupted)");
        this.messages.push({ role: "assistant", content: "(interrupted)" });
        return { interrupted: true };
      }
      this.turnCount++;
      this.abortController = new AbortController();

      let streamed = "";
      let result;
      try {
        result = await this.router.streamChat({
          // Per-model ceiling beats the global config default (8192).
          maxTokens: this.maxTokens,
          messages: this.buildRequestMessages(),
          tools: this.tools,
          signal: this.abortController.signal,
          onDelta: (chunk) => {
            streamed += chunk;
            this.ui.streamText(chunk);
          },
          // Reasoning arrives on its own channel so it can be shown in the
          // collapsible panel instead of the answer body.
          onReasoning: (chunk) => {
            if (typeof this.ui.reasoningText === "function") { this.ui.reasoningText(chunk); }
          }
        });
      } catch (e) {
        if (e.name === "AbortError") {
          this.ui.info("\n(interrupted)");
          this.messages.push({ role: "assistant", content: streamed || "(interrupted)" });
          return { interrupted: true };
        }
        this.ui.error(`provider error: ${e.message}`);
        return { error: e };
      }

      if (streamed) this.ui.endStream();

      const { text, toolCalls, reasoning } = result;

      // Accumulate reported usage; endpoints that omit it leave the counters
      // at zero rather than guessing.
      if (result.usage) {
        this.totalInputTokens += result.usage.promptTokens || 0;
        this.totalOutputTokens += result.usage.completionTokens || 0;
      }

      if (!toolCalls.length) {
        const visible = stripReasoning(text).trim();
        if (!visible) {
          // 推理模型会把整段答复放进 reasoning_content、content 留空。旧实现把空字符串
          // 当成「回答完成」，界面于是留下一个空气泡。这里先有界催两次让模型写正文，
          // 仍空则用 reasoning 尾段兜底 —— 绝不 push 空 assistant 消息污染历史。
          const stamps = this._emptyBodyInjections || (this._emptyBodyInjections = []);
          const perTurn = (this._emptyBodyRetries || 0) + 1;
          if (perTurn <= EMPTY_BODY_MAX_PER_TURN && stamps.length < EMPTY_BODY_MAX_PER_WINDOW) {
            this._emptyBodyRetries = perTurn;
            stamps.push(Date.now());
            // 标签用**窗口内**的序号，跨回合单调递增 —— 用户永远不会看到两条一样的提示。
            const nth = stamps.length;
            const hint = EMPTY_BODY_HINTS[(nth - 1) % EMPTY_BODY_HINTS.length];
            this.messages.push({ role: "user", content: "[系统] 上一条回复只有思考过程、没有正文（本会话第 " + nth + " 次）。" + hint });
            continue;
          }
          const fromReasoning = lastReasoningParagraph(reasoning);
          this.lastFinishReason = result.finishReason || null;
          if (fromReasoning) {
            this.messages.push({ role: "assistant", content: fromReasoning });
            this.ui.streamText(fromReasoning);
            this.ui.endStream();
            return { text: fromReasoning, done: true, turns: this.turnCount, finishReason: this.lastFinishReason };
          }
          return { text: "", done: true, turns: this.turnCount, finishReason: this.lastFinishReason };
        }
        // A gateway that answers with a leading <think> block would otherwise
        // persist it in history and replay it to the model next turn.
        this.messages.push({ role: "assistant", content: stripReasoning(text) });

        // Stop may veto the ending (e.g. "tests still failing"), which keeps the
        // agent working with the hook's reason as new context. Only allow it
        // once per turn so a misconfigured hook cannot loop forever.
        if (this.hooks.has("Stop") && !this.stopHookUsed) {
          this.stopHookUsed = true;
          const sv = await this.hooks.run("Stop", { transcript: this.messages.slice(-6) });
          if (sv.systemMessage) { this.ui.warn(sv.systemMessage); }
          if (sv.block) {
            this.ui.warn("hook asked to continue: " + sv.reason);
            this.messages.push({ role: "user", content: "[hook] " + sv.reason });
            continue;
          }
        }
        this.stopHookUsed = false;
        return { text, done: true, turns: this.turnCount };
      }

      this.messages.push({
        role: "assistant",
        content: stripReasoning(text) || null,
        tool_calls: toolCalls.map((c) => ({
          id: c.id,
          type: "function",
          function: { name: c.name, arguments: c.raw || JSON.stringify(c.arguments) },
        })),
      });

      // Phase 1 — authorise every call in order.
      //
      // Permission prompts are interactive, so they must stay sequential:
      // asking about three tools at once would stack dialogs the user cannot
      // answer coherently. Only the execution phase runs concurrently.
      const approvedCalls = [];
      for (const call of toolCalls) {
        const tool = findTool(call.name);
        if (!tool) {
          approvedCalls.push({ call, error: `ERROR: unknown tool "${call.name}"` });
          this.ui.error(`unknown tool: ${call.name}`);
          continue;
        }

        // PreToolUse runs before the interactive prompt so a hook can settle the
        // decision without bothering the user (allow) or veto it outright (block).
        let hookPermission = null;
        let hookPermissionReason = "";
        if (this.hooks.has("PreToolUse", call.name)) {
          const hv = await this.hooks.run("PreToolUse", {
            tool_name: call.name,
            tool_input: call.arguments,
            tool_use_id: call.id || "",
          });
          hookPermission = hv.permission;
          hookPermissionReason = hv.permissionReason || "";
          if (hv.systemMessage) { this.ui.warn(hv.systemMessage); }
          if (hv.block) {
            approvedCalls.push({ call, error: "ERROR: blocked by hook: " + hv.reason });
            this.ui.warn(`blocked by hook: ${call.name} — ${hv.reason}`);
            continue;
          }
          // 上游 PreToolUse 可修改工具入参（updatedInput）—— 修改后既影响权限判定也影响执行
          if (hv.updatedInput) { call.arguments = { ...call.arguments, ...hv.updatedInput }; }
        }

        const approved = hookPermission === "allow"
          ? true
          : hookPermission === "deny"
            ? false
            : await this.askPermission(call.name, call.arguments);
        if (!approved) {
          approvedCalls.push({ call, error: "ERROR: permission denied" + (hookPermissionReason ? " — " + hookPermissionReason : " by user") });
          this.ui.warn(`denied: ${call.name}` + (hookPermissionReason ? " — " + hookPermissionReason : ""));
          continue;
        }

        // Snapshot the target before it is touched: /rewind needs the previous
        // bytes, and a conversation-only rewind leaves the broken file behind.
        const targetPath = call.arguments && (call.arguments.file_path || call.arguments.notebook_path);
        if (targetPath) { this.checkpoints.capture(targetPath); }
        approvedCalls.push({ call, tool });
      }

      // Phase 2 — run the approved calls concurrently.
      //
      // Independent reads dominate a multi-tool turn, and awaiting them one by
      // one made "read these five files" five round trips. Results are still
      // recorded in the original order below, because the provider requires
      // each tool result to answer its own tool_call id in sequence.
      for (let k = 0; k < approvedCalls.length; k++) {
        const entry = approvedCalls[k];
        if (entry.error) { continue; }
        entry.started = Date.now();
        this.ui.toolStart(entry.call.name, entry.call.arguments);
      }

      await Promise.all(approvedCalls.map(async (entry) => {
        if (entry.error) { return; }
        const { call, tool } = entry;
        let out;
        try {
          if (["Edit", "Write", "MultiEdit"].includes(call.name) && call.arguments && call.arguments.file_path) { (this.turnFiles || (this.turnFiles = new Set())).add(String(call.arguments.file_path)); }
          out = tool.mcp
            ? await this.mcp.call(tool.mcpToolName || call.name, call.arguments)
            : await tool.run({ ...call.arguments, signal: this.abortController?.signal }, { sessionKey: this.sessionKey });
          if (!out || typeof out !== "object") out = { ok: true, content: String(out ?? "") };
        } catch (e) {
          out = { ok: false, content: `tool threw: ${e.message}` };
        }
        entry.out = out;
        entry.elapsed = Date.now() - entry.started;
      }));

      // Phase 3 — record results in order, then run the post-tool hooks.
      for (const entry of approvedCalls) {
        const { call } = entry;
        if (entry.error) {
          this.messages.push({ role: "tool", tool_call_id: call.id, content: entry.error });
          continue;
        }

        const out = entry.out;
        // The 5th argument carries structured payloads (git diffs, task ids)
        // for UIs that can render more than plain text.
        const extra = {};
        if (Array.isArray(out.attachments)) { extra.attachments = out.attachments; }
        if (out.git) { extra.git = out.git; }
        if (Array.isArray(out.diff)) { extra.diff = out.diff; }
        if (out.taskId) { extra.taskId = out.taskId; }
        // N4：大输出落盘路径透传到 GUI（GUI 可引导用户查看完整输出）
        if (out.persistedOutputPath) { extra.persistedOutputPath = out.persistedOutputPath; }
        this.ui.toolEnd(call.name, out.ok, entry.elapsed, out.content, extra);

        // PostToolUse sees the result, so it can lint, scan or audit it. A block
        // here cannot undo the call, but its reason is fed back to the model.
        // 上游语义（chunk-e0x0xb6d.js）：updatedToolOutput 可修改工具输出；
        // additionalContexts（数组）每条单独注入。
        if (this.hooks.has("PostToolUse", call.name)) {
          const hv = await this.hooks.run("PostToolUse", {
            tool_name: call.name,
            tool_input: call.arguments,
            tool_response: out.content,
            tool_ok: out.ok,
            tool_use_id: call.id || "",
          });
          if (hv.systemMessage) { this.ui.warn(hv.systemMessage); }
          if (hv.context) { this.messages.push({ role: "user", content: "[hook context]\n" + hv.context }); }
          for (const cx of hv.contexts) {
            this.messages.push({ role: "user", content: "[hook context]\n" + cx });
          }
          if (hv.block) {
            this.ui.warn(`hook flagged ${call.name}: ${hv.reason}`);
            this.messages.push({ role: "user", content: "[hook warning] " + hv.reason });
          }
          // 上游 PostToolUse 可修改工具输出（updatedToolOutput）—— 修改后影响模型看到的 tool_result
          if (hv.updatedToolOutput != null) { out.content = hv.updatedToolOutput; }
        }

        if (call.name === "ExitPlanMode" && out.ok && normalizeMode(this.config.permissionMode) === "plan") {
          // Approval flips the session back to ask so the plan can be executed.
          this.setMode("ask");
          this.ui.success("方案已批准 — 已切回询问模式");
        }

        this.messages.push({ role: "tool", tool_call_id: call.id, content: out.content });

        // Tool output can carry images (Read on a .png). The tool role only
        // accepts text, so images are queued and sent as a user message.
        if (Array.isArray(out.attachments) && out.attachments.length) {
          const imgs = out.attachments
            .map((a) => (a?.type === "image" && a.source?.data
              ? { kind: "image", name: a.source.media_type || "image", mime: a.source.media_type, data: a.source.data }
              : null))
            .filter(Boolean);
          if (imgs.length) pendingImages.push(...imgs);
        }
      }

      if (pendingImages.length) {
        const content = buildToolAttachmentContent(pendingImages, { vision: this.vision });
        this.messages.push({ role: "user", content });
        pendingImages.length = 0;
      }
    }

    this.ui.warn(`reached max turns (${this.config.maxTurns})`);
    return { maxTurnsReached: true };
  }

  /**
   * Compact the conversation when it approaches the context limit.
   *
   * Plain truncation throws away decisions made early in the session, so the
   * history is first summarised by the model itself. If that call fails (an
   * outage the router could not route around) we fall back to truncation
   * rather than losing the session entirely.
   */

  /**
   * Micro-compaction: 移除旧 tool_result 正文（保留 tool_use/tool_result 结构），
   * 只保留最近 keepRecent 个 tool_result 的完整内容。比全量压缩更轻——
   * 先试 micro，如果释放了足够空间就不用做全量压缩了。
   *
   * @param {number} [keepRecent] 保留最近几个 tool_result 完整（默认 3）
   * @returns {number} 释放的字符数（0 = 无事可做）
   */
  microCompact(keepRecent = 3) {
    let freed = 0;
    const toolMsgs = [];
    for (let i = 0; i < this.messages.length; i++) {
      const m = this.messages[i];
      if (m.role === 'tool' && typeof m.content === 'string') {
        toolMsgs.push({ idx: i, m });
      }
    }
    // 从后往前保留最近 keepRecent 个
    for (let i = 0; i < toolMsgs.length - keepRecent; i++) {
      const { idx, m } = toolMsgs[i];
      if (m.content.startsWith('[tool output removed')) { continue; } // 已清理过
      const oldLen = m.content.length;
      this.messages[idx] = {
        ...m,
        content: `[tool output removed: ${oldLen} chars]`,
      };
      freed += oldLen - `[tool output removed: ${oldLen} chars]`.length;
    }
    return freed;
  }

  async maybeCompact() {
    const approxChars = this.messages.reduce((sum, m) => {
      const c = typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? "");
      return sum + c.length + 20;
    }, 0);
    // CJK text is roughly one token per character, Latin text nearer four.
    // A flat /4 estimate under-counts Chinese by ~4x, so compaction fired far
    // too late and the request hit the upstream 400 first.
    const approxTokens = estimateTokens(this.messages);
    // Use the window resolved from the model catalogue, not the global config:
    // a 200k model must not be compacted on a 1M model schedule.
    const window = this.contextWindow || this.config.contextWindow;
    const limit = window * (this.config.compactThreshold || 0.8);
    if (approxTokens < limit) { return null; }

    // 先试 micro-compaction（更轻：清旧 tool_result，保留 tool_use/tool_result 结构）。
    // 释放了足够空间就不用做全量压缩了。
    const microFreed = this.microCompact();
    const afterMicro = estimateTokens(this.messages);
    if (microFreed > 0 && afterMicro < limit) {
      return { micro: true, freed: microFreed, approxTokens: afterMicro };
    }
    // micro 释放不够 → 继续走全量压缩

    // PreCompact fires before the history is rewritten, so a hook can archive
    // or annotate the full transcript while it still exists.
    if (this.hooks.has("PreCompact")) {
      try {
        const hv = await this.hooks.run("PreCompact", {
          trigger: "auto",
          approx_tokens: approxTokens,
          messages: this.messages.length,
        });
        if (hv.systemMessage) { this.ui.warn(hv.systemMessage); }
        if (hv.block) {
          this.ui.warn("compaction skipped by PreCompact hook: " + (hv.reason || ""));
          return null;
        }
      } catch {
        // A failing hook must not break compaction.
      }
    }

    // Split on a turn boundary. A blind slice can start the kept tail with a
    // tool result whose assistant tool_calls were just dropped, and upstream
    // rejects that pairing with a 400.
    const keepFrom = findKeepBoundary(this.messages, 6);
    if (keepFrom <= 0) { return null; }
    const middle = this.messages.slice(0, keepFrom);
    const keep = this.messages.slice(keepFrom);
    if (!middle.length) { return null; }

    let summary = null;
    try {
      summary = await this.summarise(middle);
    } catch {
      summary = null; // fall through to truncation
    }

    const opening = summary
      ? "[earlier conversation summarised\n\n" + summary + "]"
      : "[context compacted: " + middle.length + " earlier messages removed]";
    this.messages = [{ role: "user", content: opening }, ...keep];
    return { dropped: middle.length, approxTokens: approxTokens, summarised: !!summary };
  }


  /** Ask the model to condense a range of messages into a short brief. */
  async summarise(messages) {
    const transcript = messages
      .map(function (m) {
        const text = typeof m.content === "string" ? m.content : "[multi-part message]";
        const role = m.role === "user" ? "用户" : m.role === "assistant" ? "助手" : "工具";
        return role + ": " + String(text).slice(0, 600);
      })
      .join("\n\n")
      .slice(-12000);

    const result = await this.router.complete({
      messages: [
        {
          role: "system",
          content:
            "把下面的对话浓缩成简短摘要，保留：用户的目标、已做的决定与改动、关键文件路径、未完成事项。" +
            "用中文，200 字以内，只输出摘要本身。",
        },
        { role: "user", content: transcript },
      ],
      tools: [],
    });
    const text = String(result.text || "").trim();
    return text.length > 40 ? text.slice(0, 1200) : null;
  }

  stats() {
    return {
      messages: this.messages.length,
      turns: this.turnCount,
      memory: this.memory ? true : false,
    };
  }
}


/**
 * Rough token estimate that accounts for CJK.
 *
 * Latin text averages ~4 characters per token, CJK closer to 1. A flat /4
 * under-counted Chinese by roughly 4x, so a conversation about to overflow
 * looked comfortably small and compaction never fired in time.
 */
function estimateTokens(messages) {
  let tokens = 0;
  for (const m of messages) {
    const text = typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? "");
    // CJK 与拉丁文分别估算，口径见 src/tokens.js（此前这里有一份内联实现，
    // GUI 侧却各写各的 chars/4，同一段中文在三处显示三个数）。
    tokens += estimateTextTokens(text) + 8;
    if (Array.isArray(m.tool_calls)) {
      tokens += estimateTextTokens(JSON.stringify(m.tool_calls));
    }
  }
  return tokens;
}

/**
 * Index at which the kept tail may start so the cut never separates an
 * assistant tool_calls message from the tool results that answer it.
 *
 * Walks backwards from the desired keep length until it lands on a message
 * that is safe to start on (anything except a tool result).
 */
function findKeepBoundary(messages, want) {
  let idx = Math.max(0, messages.length - want);
  while (idx < messages.length && messages[idx] && messages[idx].role === "tool") {
    idx++;
  }
  // Dropping everything would make compaction pointless.
  if (idx >= messages.length) { return -1; }
  return idx;
}
