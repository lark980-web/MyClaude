import { findTool, toolSchemas } from "../tools/index.js";
import { ProviderRouter } from "../providers/router.js";
import { PermissionEngine, loadMemory } from "./permissions.js";
import { normalizeMode, isCommonFileCommand, FILE_EDIT_TOOLS } from "./modes.js";
import { SYSTEM_PROMPT } from "./prompt.js";
import { buildUserContent, buildToolAttachmentContent, resolveAttachments } from "../attachments.js";
import { setQuestionPresenter } from "../tools/extended.js";
import { HookRunner } from "../hooks.js";
import { stripReasoning } from "./think.js";
import { contextWindowOf, maxTokensOf, supportsVision, findModel } from "../models.js";

/** Tools that never touch the filesystem, so they never need approval. */
const NON_MUTATING_TOOLS = new Set([
  "TodoWrite",
  "AskUserQuestion",
  "ExitPlanMode",
  "BashOutput",
  "GitStatus",
  "GitDiff",
  "GitLog",
]);

export class Agent {
  constructor({ provider, config, ui, tools = toolSchemas(), permissions }) {
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
    // Resolve the model's real limits instead of assuming one global number:
    // the catalogue carries per-model context window and token ceiling, and a
    // 1M-token model must not be compacted on a 200k model's schedule.
    this.contextWindow = contextWindowOf(config.model);
    this.maxTokens = maxTokensOf(config.model);
    this.turnCount = 0;
    // Guards the Stop hook so it can only extend a run once.
    this.stopHookUsed = false;
    this.sessionKey = "default";
    this.mcp = null;
    this.totalInputTokens = 0;
    this.totalOutputTokens = 0;
    this.permissions =
      permissions instanceof PermissionEngine
        ? permissions
        : new PermissionEngine(config.permissions || {});
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
    const parts = [SYSTEM_PROMPT];
    if (this.memory) {
      parts.push(
        `\n\n# Project memory (MYCLAUDE.md)\n\nThe following project instructions take precedence over generic defaults:\n\n${this.memory}`
      );
    }
    if (this.config.permissionMode === "plan") {
      parts.push(
        `\n\n# Plan mode\nYou are in plan mode: you MUST NOT use Write, Edit, MultiEdit, NotebookEdit or any ` +
          `state-changing tool. Read-only exploration is allowed. When the plan is ready, call ExitPlanMode ` +
          `with the full plan text so the user can approve execution.`
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

  setVision(enabled) {
    this.config.vision = !!enabled;
    this.systemPrompt = this.buildSystemPrompt();
    return this.config.vision;
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
   * Drop the trailing assistant/tool exchange so the last user message can be
   * answered again. Used by the GUI "Retry" action.
   *
   * @param {string} [text] replace the last user message with this text (edit & resend)
   * @returns {{ rewound: number, lastUser: object|null }}
   */
  rewind(text) {
    let lastUser = -1;
    for (let i = this.messages.length - 1; i >= 0; i--) {
      if (this.messages[i].role === "user") { lastUser = i; break; }
    }
    if (lastUser < 0) return { rewound: 0, lastUser: null };
    const dropped = this.messages.length - lastUser - 1;
    this.messages = this.messages.slice(0, lastUser + 1);
    if (typeof text === "string" && text.trim()) {
      this.messages[lastUser] = { role: "user", content: text };
    }
    return { rewound: dropped, lastUser: this.messages[lastUser] };
  }

  abort() {
    this.abortController?.abort();
  }

  buildRequestMessages() {
    return [{ role: "system", content: this.systemPrompt }, ...this.messages];
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
      // File edits and routine build/test commands go through; anything that
      // could delete, publish or reach the network still asks.
      if (FILE_EDIT_TOOLS.has(toolName)) return true;
      if (toolName === "Bash" && isCommonFileCommand(args && args.command)) return true;
    }

    if (mode === "auto") return true;

    if (mode === "dontAsk") {
      // The user opted out of prompts entirely: refuse rather than ask.
      this.ui.warn(`don't ask: ${toolName} was auto-denied`);
      return false;
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
  async run(userInput, { attachments, reuseLastUser } = {}) {
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
      }
      const resolved = await resolveAttachments(attachments);
      const bad = resolved.filter((a) => a.kind === "error");
      for (const a of bad) this.ui.warn(`attachment skipped: ${a.name} — ${a.error}`);
      const usable = resolved.filter((a) => a.kind !== "error");

      this.messages.push({
        role: "user",
        content: buildUserContent(userInput, usable, { vision: this.vision }),
      });
    }

    const pendingImages = [];
    // Each run gets its own Stop-hook budget.
    this.stopHookUsed = false;

    for (let turn = 0; turn < this.config.maxTurns; turn++) {
      this.turnCount++;
      this.abortController = new AbortController();

      let streamed = "";
      let result;
      try {
        result = await this.router.streamChat({
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

      const { text, toolCalls } = result;

      // Accumulate reported usage; endpoints that omit it leave the counters
      // at zero rather than guessing.
      if (result.usage) {
        this.totalInputTokens += result.usage.promptTokens || 0;
        this.totalOutputTokens += result.usage.completionTokens || 0;
      }

      if (!toolCalls.length) {
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

      for (const call of toolCalls) {
        const tool = findTool(call.name);
        if (!tool) {
          this.messages.push({
            role: "tool",
            tool_call_id: call.id,
            content: `ERROR: unknown tool "${call.name}"`,
          });
          this.ui.error(`unknown tool: ${call.name}`);
          continue;
        }

        // PreToolUse runs before the interactive prompt so a hook can settle the
        // decision without bothering the user (allow) or veto it outright (block).
        let hookPermission = null;
        if (this.hooks.has("PreToolUse", call.name)) {
          const hv = await this.hooks.run("PreToolUse", {
            tool_name: call.name,
            tool_input: call.arguments,
          });
          hookPermission = hv.permission;
          if (hv.systemMessage) { this.ui.warn(hv.systemMessage); }
          if (hv.block) {
            this.messages.push({
              role: "tool",
              tool_call_id: call.id,
              content: "ERROR: blocked by hook: " + hv.reason,
            });
            this.ui.warn(`blocked by hook: ${call.name} — ${hv.reason}`);
            continue;
          }
        }

        const approved = hookPermission === "allow"
          ? true
          : hookPermission === "deny"
            ? false
            : await this.askPermission(call.name, call.arguments);
        if (!approved) {
          this.messages.push({
            role: "tool",
            tool_call_id: call.id,
            content: "ERROR: permission denied by user",
          });
          this.ui.warn(`denied: ${call.name}`);
          continue;
        }

        this.ui.toolStart(call.name, call.arguments);
        const started = Date.now();
        let out;
        try {
          out = tool.mcp
            ? await this.mcp.call(tool.mcpToolName || call.name, call.arguments)
            : await tool.run(call.arguments, { sessionKey: this.sessionKey });
          if (!out || typeof out !== "object") out = { ok: true, content: String(out ?? "") };
        } catch (e) {
          out = { ok: false, content: `tool threw: ${e.message}` };
        }
        const elapsed = Date.now() - started;
        // The 5th argument carries structured payloads (git diffs, task ids)
        // for UIs that can render more than plain text.
        const extra = {};
        if (Array.isArray(out.attachments)) { extra.attachments = out.attachments; }
        if (out.git) { extra.git = out.git; }
        if (Array.isArray(out.diff)) { extra.diff = out.diff; }
        if (out.taskId) { extra.taskId = out.taskId; }
        this.ui.toolEnd(call.name, out.ok, elapsed, out.content, extra);

        // PostToolUse sees the result, so it can lint, scan or audit it. A block
        // here cannot undo the call, but its reason is fed back to the model.
        if (this.hooks.has("PostToolUse", call.name)) {
          const hv = await this.hooks.run("PostToolUse", {
            tool_name: call.name,
            tool_input: call.arguments,
            tool_response: out.content,
            tool_ok: out.ok,
          });
          if (hv.systemMessage) { this.ui.warn(hv.systemMessage); }
          if (hv.context) { this.messages.push({ role: "user", content: "[hook context]\n" + hv.context }); }
          if (hv.block) {
            this.ui.warn(`hook flagged ${call.name}: ${hv.reason}`);
            this.messages.push({ role: "user", content: "[hook warning] " + hv.reason });
          }
        }

        if (call.name === "ExitPlanMode" && out.ok && normalizeMode(this.config.permissionMode) === "plan") {
          // Approval flips the session back to ask so the plan can be executed.
          this.setMode("ask");
          this.ui.success("方案已批准 — 已切回询问模式");
        }

        this.messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: out.content,
        });

        // Tool output can carry images (Read on a .png). The tool role only
        // accepts text, so images are queued and sent as a user message.
        if (Array.isArray(out.attachments) && out.attachments.length) {
          const extra = out.attachments
            .map((a) => (a?.type === "image" && a.source?.data
              ? { kind: "image", name: a.source.media_type || "image", mime: a.source.media_type, data: a.source.data }
              : null))
            .filter(Boolean);
          if (extra.length) pendingImages.push(...extra);
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
    // Count CJK characters separately: they are ~1 token each.
    const cjk = (text.match(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/g) || []).length;
    const rest = text.length - cjk;
    tokens += cjk + Math.ceil(rest / 4) + 8;
    // Tool call payloads are JSON and cost tokens too.
    if (Array.isArray(m.tool_calls)) {
      tokens += Math.ceil(JSON.stringify(m.tool_calls).length / 4);
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
