#!/usr/bin/env node
import { loadConfig, saveConfig, configPath } from "./config.js";
import { listOutputStyles } from "./output-style.js";
import { createProvider } from "./providers/openai.js";
import { Agent } from "./agent/agent.js";
import { TerminalUI } from "./ui/terminal.js";
import { allRegisteredTools } from "./tools/index.js";
import { createAgent, closeAgent } from "./agent/runtime.js";
import { runWithAutoContinue } from "./agent/autorun.js";
import { setAutonomous } from "./tools/extended.js";
import {
  newSessionId,
  saveSession,
  listSessions,
  loadSession,
  deleteSession,
  latestSession,
  pruneSessions,
  createAutoSaver,
  sessionFile,
  savePlan,
} from "./session.js";
import { resolveAttachments, describeAttachment } from "./attachments.js";
import { loadCommands, findCommand, expandCommand } from "./commands.js";
import { loadSkills } from "./skills.js";
import { normalizeMode, PERMISSION_MODES } from "./agent/modes.js";
import { VERSION } from "./version.js";
import { GATEWAY_KEY_ENV, costLineFor, NO_PRICE_NOTICE } from "./models.js";
import { inspectProject, renderProjectMemory, renderTranscriptMarkdown } from "./project-memory.js";
import { withCommandScope } from "./command-scope.js";
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { registry as taskRegistry } from "./tasks/registry.js";
import { loadPlugins, pluginSummaries } from "./plugins.js";
import { setPlanSessionId } from "./tools/extended.js";

const HELP = `MyClaude — terminal AI coding agent

Usage:
  myclaude                 interactive TUI (default in a terminal)
  myclaude --plain         simple readline REPL
  myclaude --gui           web GUI in your browser
  myclaude -p "prompt"     one-shot, print answer

Options:
  --auto, --yes            auto-approve every tool call
  --full-access          full access: skip prompts and deny rules
  --plan                   read-only; deny all tool calls
  --gui [--port N]         start the local web UI (default port 7788)
  --no-open                with --gui, do not open a browser
  --plain                  use the readline REPL instead of Ink TUI
  --continue               resume the most recent session in this directory
  --resume <id>            resume a specific saved session
  --config-path            print config file path
  -p, --print <prompt>   run one turn non-interactively, print the answer, exit
  --allowed-tools <tools...>  comma/space separated tools to allow
  --disallowed-tools <t...>   tools to deny
  -v, --version            print version
  -h, --help               this help

Sessions are saved automatically to ~/.myclaude/sessions/ after every turn.

Commands (interactive):
  /help              show command list
  /exit, /quit       exit
  /clear             clear conversation history
  /rewind            undo the last turn and restore the files it changed
  /compact           force context compaction now
  /cost              show token usage and estimated spend for this session
  /doctor            check config, gateway, tools and permissions
  /skills            list available skills
  /plugin [名]        列出已安装的插件
  /hooks [events]    列出已配置的钩子 / 可用事件
  /todos             查看 TodoWrite 待办
  /context           上下文用量明细
  /skill <名>        按名执行技能
  /release-notes     版本说明
  /add-dir <路径>    追加工作目录
  /auto [on|off]     自主模式：回合上限后自动续跑（默认关）
  /agents            子代理定义
  /mcp login <名>      登录需要 OAuth 的 MCP 服务器
  /mcp logout <名>     清除已保存的 MCP 令牌
  /model [name]      show or set model
  /provider [name]   show or set provider
  /base [url]        show or set base URL
  /key [key]         show or set API key
  /mode [模式]          切换权限模式（ask/acceptEdits/auto/dontAsk/plan/bypassPermissions/fullAccess）
  /attach <path...>  attach images/text files to the next message
  /attachments       list pending attachments
  /detach            drop pending attachments
  /vision [on|off]   send image attachments to the model
  /tools             list tools
  /stats             session stats
  /config            show resolved config
  /models            list models from provider
  /save [name]       save conversation now (auto-saves after every turn)
  /sessions          list saved sessions
  /resume <id>       load a saved session
  /continue          load the most recent session in this directory
  /session           show the current session id and file
  /rm <id>           delete a saved session
`;

function parseArgs(argv) {
  const opts = {
    gui: argv.includes("--gui") || argv.includes("--web"),
    plain: argv.includes("--plain"),
    noOpen: argv.includes("--no-open"),
    port: Number(process.env.PORT) || 7788,
    auto: argv.includes("--auto") || argv.includes("--yes"),
    fullAccess: argv.includes("--full-access") || argv.includes("--god"),
    plan: argv.includes("--plan"),
    oneShot: null,
    help: argv.includes("--help") || argv.includes("-h"),
    version: argv.includes("--version") || argv.includes("-v"),
    configPath: argv.includes("--config-path"),
    continueSession: argv.includes("--continue") || argv.includes("-c"),
    outputFormat: null,
    allowedTools: [],
    disallowedTools: [],
    resume: null,
  };
    const gatherVariadic = (flag) => {
    const idx = argv.findIndex((a) => a === flag);
    if (idx < 0) return [];
    const vals = [];
    for (let k = idx + 1; k < argv.length && !argv[k].startsWith("-"); k++) {
      vals.push(...argv[k].split(","));
    }
    return vals.map((v) => v.trim()).filter(Boolean);
  };
  opts.allowedTools = gatherVariadic("--allowed-tools").concat(gatherVariadic("--allowedTools"));
  opts.disallowedTools = gatherVariadic("--disallowed-tools").concat(gatherVariadic("--disallowedTools"));
  const ofIdx = argv.findIndex((a) => a === "--output-format");
  if (ofIdx >= 0) opts.outputFormat = argv[ofIdx + 1] ?? null;
const resumeIdx = argv.findIndex((a) => a === "--resume" || a === "-r");
  if (resumeIdx >= 0) opts.resume = argv[resumeIdx + 1] ?? null;
  const pi = argv.findIndex((a) => a === "-p" || a === "--print");
  if (pi >= 0) opts.oneShot = argv[pi + 1] ?? null;
  const portIdx = argv.findIndex((a) => a === "--port");
  if (portIdx >= 0) {
    const n = Number(argv[portIdx + 1]);
    if (Number.isInteger(n) && n > 0 && n < 65536) opts.port = n;
  }
  return opts;
}

/** Metadata written alongside every auto-saved session. */
function sessionMeta(agent, config) {
  return {
    cwd: process.cwd(),
    model: config.model,
    provider: config.provider,
    permissionMode: agent.mode ?? config.permissionMode,
    turnCount: agent.turnCount,
    version: VERSION,
  };
}


/** /review 的审查提示词：arg 为空审未提交改动，否则审与目标分支/PR 的差异。 */
function reviewPrompt(arg) {
  const target = String(arg || "").trim();
  const scope = target
    ? `审查目标：工作区与 "${target}" 的差异（git diff ${target}...HEAD；若 arg 是 PR 编号且 gh 可用则 gh pr diff ${target}）`
    : "审查目标：当前未提交的改动（git diff HEAD；若为空再看最近一次提交 git show --stat HEAD）";
  return [
    "你是严格的代码审查者。请完成一次代码审查并输出报告。",
    scope,
    "步骤：",
    "1) 用 Bash 查看改动范围与完整 diff；改动为空时明确说明「没有待审查的改动」并结束。",
    "2) 逐文件阅读改动及其周边上下文（Read/Grep），不要只看 diff 猜测。",
    "3) 输出报告：按 [严重] [主要] [次要] [建议] 四级列出问题，每条包含 文件:行号、问题说明、具体修复建议；重点检查正确性、边界条件、安全（注入/秘钥/路径）、并发与性能、错误处理、命名一致性。",
    "4) 报告以一句话结论收尾：可合并 / 需修改（附理由）。全部用中文输出。"
  ].join("\n");
}

async function handleCommand(raw, ctx) {
  const { agent, config, provider, ui } = ctx;
  const [cmd, ...rest] = raw.slice(1).split(/\s+/);
  const arg = rest.join(" ");

  switch (cmd) {
    case "exit":
    case "quit":
    case "q":
      await agent.sessionEnd("exit");
      return { exit: true };
    case "help":
      ui.info(HELP);
      return {};
    case "rewind": {
      // Roll back the last turn, including the files it changed. The file part
      // is what makes this a real undo: the conversation alone would rewind
      // while the workspace kept the half-finished edit.
      const keepFiles = /\bkeep-files\b/.test(arg);
      const res = agent.rewind(undefined, { restoreFiles: !keepFiles });
      if (!res.rewound) {
        ui.warn("nothing to rewind");
        return {};
      }
      if (res.files && (res.files.restored.length || res.files.deleted.length)) {
        ui.success(
          `rewound ${res.rewound} messages · restored ${res.files.restored.length} file(s)` +
          (res.files.deleted.length ? `, removed ${res.files.deleted.length} created file(s)` : "")
        );
        for (const f of res.files.restored) { ui.info("  restored " + f); }
        for (const f of res.files.deleted) { ui.info("  removed  " + f); }
        if (res.files.failed.length) {
          ui.warn(`${res.files.failed.length} file(s) could not be restored`);
          for (const f of res.files.failed) { ui.warn("  " + f.path + ": " + f.error); }
        }
      } else {
        ui.success(`rewound ${res.rewound} messages` + (keepFiles ? " (files kept)" : ", no files changed"));
      }
      ctx.autoSaver?.save({ force: true });
      return {};
    }
    case "compact": {
      // Force a compaction now instead of waiting for the threshold.
      const before = agent.messages.length;
      const r = await agent.maybeCompact();
      if (!r) {
        ui.info(`nothing to compact (${before} messages, under the threshold)`);
      } else {
        ui.success(
          `compacted: dropped ${r.dropped} messages (${before} → ${agent.messages.length})` +
          (r.summarised ? ", summarised by the model" : ", truncated")
        );
      }
      ctx.autoSaver?.save({ force: true });
      return {};
    }
    case "clear":
      agent.reset();
      ctx.autoSaver?.rotate();
      ctx.autoSaver?.save({ force: true });
      ui.success("conversation cleared");
        await agent.sessionEnd("clear");
      return {};
    case "model":
      if (arg) {
        saveConfig({ model: arg });
        config.model = arg;
        provider.model = arg;
        ui.success(`model = ${arg}`);
      } else {
        ui.info(`model = ${config.model}`);
      }
      return {};
    case "provider":
      if (arg) {
        saveConfig({ provider: arg });
        config.provider = arg;
        ui.success(`provider = ${arg} (restart to apply)`);
      } else {
        ui.info(`provider = ${config.provider}`);
      }
      return {};
    case "base":
      if (arg) {
        saveConfig({ baseUrl: arg });
        config.baseUrl = arg;
        provider.baseUrl = arg.replace(/\/+$/, "");
        ui.success(`baseUrl = ${arg}`);
      } else {
        ui.info(`baseUrl = ${config.baseUrl}`);
      }
      return {};
    case "key":
      if (arg) {
        saveConfig({ apiKey: arg });
        config.apiKey = arg;
        provider.apiKey = arg;
        ui.success("api key updated");
      } else {
        ui.info(`apiKey = ${config.apiKey ? "(set)" : "(empty)"}`);
      }
      return {};
    case "mode":
      const wanted = normalizeMode(arg);
      if (arg && wanted) {
        saveConfig({ permissionMode: wanted });
        config.permissionMode = wanted;
        agent.setMode?.(wanted);
        ui.success(`permissionMode = ${wanted}`);
      } else if (!arg) {
        ui.info(`permissionMode = ${agent.mode ?? config.permissionMode}\n  可选: ${PERMISSION_MODES.map((x) => x.id).join(" | ")}`);
      } else {
        ui.warn(`无效模式：${arg}  (可选: ${PERMISSION_MODES.map((x) => x.id).join(" | ")})`);
      }
      return {};
    case "attach": {
      if (!arg) {
        ui.warn("用法：/attach <路径> [更多路径…]");
        return {};
      }
      const paths = arg.match(/"[^"]+"|\S+/g).map((p) => p.replace(/^"|"$/g, ""));
      const resolved = await resolveAttachments(paths);
      for (const a of resolved) {
        if (a.kind === "error") ui.warn(`${a.name}: ${a.error}`);
        else {
          ctx.pendingAttachments.push(a);
          ui.success(`attached ${describeAttachment(a)}`);
        }
      }
      return {};
    }
    case "attachments":
      if (!ctx.pendingAttachments.length) ui.info("(no pending attachments)");
      else ui.info(ctx.pendingAttachments.map((a) => `  ${describeAttachment(a)}`).join("\n"));
      return {};
    case "detach":
      ctx.pendingAttachments.length = 0;
      ui.success("attachments cleared");
      return {};
    case "vision": {
      const on = arg === "on" ? true : arg === "off" ? false : null;
      if (on === null && arg) {
        ui.warn("用法：/vision on|off");
        return {};
      }
      if (on !== null) {
        config.vision = on;
        saveConfig({ vision: on });
        agent.setVision?.(on);
      }
      ui.info(`vision = ${config.vision !== false ? "on" : "off"}`);
      return {};
    }
    case "mcp": {
      // "/mcp login <server>" starts the OAuth device flow for one server.
      if (rest[0] === "login") {
        const target = rest[1];
        if (!target) {
          ui.info("用法：/mcp login <服务器名>");
          return {};
        }
        const spec = (config.mcpServers || {})[target];
        if (!spec) {
          ui.info(`没有名为 "${target}" 的 MCP 服务器。`);
          return {};
        }
        const manager = agent.mcpManager;
        if (!manager || !manager.authorize) {
          ui.info("当前会话没有可用的 MCP 管理器。");
          return {};
        }
        try {
          ui.info(`正在为 "${target}" 发起 OAuth 登录…`);
          await manager.authorize(target, spec);
          ui.info(`"${target}" 登录成功，令牌已保存。`);
        } catch (e) {
          ui.warn(`"${target}" 登录失败：${e.message}`);
        }
        return {};
      }
      // "/mcp logout <server>" forgets the stored token.
      if (rest[0] === "logout") {
        const target = rest[1];
        if (!target) {
          ui.info("用法：/mcp logout <服务器名>");
          return {};
        }
        agent.mcpManager?.tokenStore?.clear?.(target);
        ui.info(`已清除 "${target}" 的令牌。`);
        return {};
      }
      const status = agent.mcpManager?.status?.() || [];
      if (!status.length) {
        ui.info("(no MCP servers connected) — add them under mcpServers in " + configPath());
      } else {
        ui.info(
          status
            .map((s) => `${s.name}: ${s.tools} tool(s)${s.info?.name ? ` — ${s.info.name} ${s.info.version ?? ""}` : ""}`)
            .join("\n")
        );
      }
      return {};
    }
    case "tools":
      ui.info(allRegisteredTools().map((t) => `${t.name.padEnd(18)} ${t.description.split(".")[0]}`).join("\n"));
      return {};
    case "tasks": {
      // Every kind of long-running job, not just shell commands. Each type has
      // one field worth showing beyond the label: what the agent is waiting on,
      // or how far a workflow has got.
      const all = taskRegistry.list();
      if (!all.length) {
        ui.info("(no tasks) — start one with Bash(run_in_background=true) or Task(run_in_background=true)");
        return {};
      }
      const detailOf = (t) => {
        if (t.type === "mcp_task") { return `${t.meta.serverName}/${t.meta.toolName}`; }
        if (t.type === "monitor_mcp" || t.type === "monitor_ws") { return t.meta.statusMessage || t.meta.description || ""; }
        if (t.type === "workflow") {
          const step = Number(t.meta.currentStep);
          const total = Array.isArray(t.meta.steps) ? t.meta.steps.length : 0;
          return step >= 0 && total ? `step ${step + 1}/${total}` : "";
        }
        return t.label || "";
      };
      ui.info(
        all
          .map((t) => {
            const age = Math.round(((t.finishedAt || Date.now()) - t.createdAt) / 1000);
            const detail = String(detailOf(t)).slice(0, 44);
            return `  ${t.id}  ${t.type.padEnd(12)} ${t.status.padEnd(10)} ${String(age).padStart(4)}s  ${detail}`;
          })
          .join("\n")
      );
      return {};
    }
    // /fork (and its alias /branch) split the conversation at this point so
    // two approaches can be tried from the same history. The original is left
    // untouched and nothing outside the sessions directory is involved, so
    // git history stays clean.
    case "fork":
    case "branch": {
      const saver = ctx.autoSaver;
      if (!saver) {
        ui.info("(no active session to fork)");
        return {};
      }
      // Flush first: the fork must include the turn that was just written,
      // otherwise the new branch starts one message behind.
      try { saver.save({ force: true }); } catch {}
      const { forkSession } = await import("./session.js");
      const res = forkSession(saver.id, { title: rest.join(" ").trim() || null });
      if (!res.ok) {
        // "no such session" nearly always means the conversation has not been
        // written yet, which is the case when there is nothing in it to fork.
        const hint = /no such session/.test(res.error)
          ? "（当前会话还没有内容，先对话再分叉）"
          : "";
        ui.warn(`分叉失败：${res.error}${hint}`);
        return {};
      }
      // Continue in the fork, exactly as /resume would.
      const data = loadSession(res.id);
      agent.messages = (data && data.messages) || [];
      ctx.autoSaver?.rotate(res.id);
      ui.success(`已分叉出 ${res.id}（${res.messages} 条消息），当前会话已切换过去`);
      ui.info(`原会话 ${saver.id} 保持不变`);
      return {};
    }
    case "title": {
      // Name the current conversation. With no argument it reports the name.
      const saver = ctx.autoSaver;
      if (!saver) {
        ui.info("(no active session to name)");
        return {};
      }
      const name = rest.join(" ").trim();
      if (!name) {
        const cur = loadSession(saver.id);
        ui.info(cur && cur.title ? `当前会话标题：${cur.title}` : "(未命名)");
        ui.info("用法：/title <名称>");
        return {};
      }
      const { setSessionTitle } = await import("./session.js");
      if (!setSessionTitle(saver.id, name)) {
        ui.warn(`无法命名会话 ${saver.id}（会话不存在）`);
        return {};
      }
      ui.info(`已将会话命名为「${name.slice(0, 120)}」`);
      return {};
    }
    case "status": {
      // One line per thing worth knowing about the current session.
      // Claude shows the same cluster in /status; keeping it in one place
      // saves digging through /config, /models and /tasks separately.
      const mode = config.permissionMode || "ask";
      const st = agent && agent.stats ? agent.stats() : {};
      const mcpCount = Object.keys(config.mcpServers || {}).length;
      const rows = [
        `模型        ${config.model}`,
        `供应商      ${config.provider || "-"}`,
        `权限模式    ${mode}`,
        `思考深度    ${config.effort || "默认"}`,
        `MCP 服务器  ${mcpCount} 个`,
        `后台任务    ${Object.keys(st.tasks || st || {}).length} 个`,
        `快速模式    ${config.fastMode ? "开" : "关"}`,
        `额外目录      ${(config.additionalDirectories || []).length ? (config.additionalDirectories || []).join("、") : "无"}`,
      ];
      ui.info(rows.join("\n"));
      return {};
    }
    case "effort": {
      // /effort controls how long the model thinks before answering.
      // No argument reports the current value; "off" restores the default.
      const valid = ["high", "medium", "low", "off"];
      const want = String(rest[0] || "").toLowerCase();
      if (!want) {
        ui.info(`思考深度：${config.effort || "默认（未设置）"}`);
        ui.info("用法：/effort high|medium|low|off");
        return {};
      }
      if (!valid.includes(want)) {
        ui.warn(`无效值 ${want}，可选：${valid.join(" / ")}`);
        return {};
      }
      const value = want === "off" ? null : want;
      config.effort = value;
      saveConfig({ effort: value });
      ui.info(value ? `思考深度已设为 ${value}` : "思考深度已恢复默认");
      return {};
    }
    case "fast": {
      // /fast toggles fast mode: the same model, tuned for quicker output.
      const on = "1" === rest[0] ? true : "0" === rest[0] ? false : !config.fastMode;
      config.fastMode = on;
      saveConfig({ fastMode: on });
        ui.info(on ? "快速模式已开启 — 每轮只带最近 " + (config.fastModeMessages || 24) + " 条历史" : "快速模式已关闭 — 每轮发送完整历史");
      return {};
    }
    // /loop runs a prompt repeatedly. Claude drives its loop from a cron and
    // reads the tasks from loop.md; here the prompt can be given inline or
    // come from loop.md, and the run is bounded by default — an unbounded loop
    // would keep spending tokens after the user has stopped watching.
    // A dream is Claude’s background pass that tidies project memory: it merges
    // duplicates, drops stale notes and checks them against CLAUDE.md.
    // It is not a command in Claude — it runs on its own — but exposing it
    // makes the work visible and lets it be cancelled.
    // MyClaude keeps one memory file rather than Claude’s personal/team split,
    // so the consolidation targets that file.
    case "dream": {
      const { startDream, setDreamPhase } = await import("./tasks/kinds.js");
      const { memoryFilePath } = await import("./agent/permissions.js");
      const file = memoryFilePath(process.cwd());
      const task = startDream({ sessionsReviewing: 1 });
      setDreamPhase(task, "reading", [file]);
      let existing = "";
      if (existsSync(file)) {
        try { existing = readFileSync(file, "utf8"); } catch { existing = ""; }
      }
      if (!existing.trim()) {
        setDreamPhase(task, "nothing-to-do");
        taskRegistry.complete(task, null);
        ui.info("记忆文件为空，没有需要整理的内容。");
        return {};
      }
      setDreamPhase(task, "consolidating", [file]);
      const prompt =
        "整理项目记忆文件。删除重复或过时的条目，合并相近的内容，" +
        "保留仍然准确的说明。不要添加新内容，也不要改变意思。" +
        "只输出整理后的完整文件内容，不要解释。\n\n当前内容：\n" + existing;
      await agent.run(prompt);
      setDreamPhase(task, "done", [file]);
      taskRegistry.complete(task, null);
      ui.success("记忆整理完成（" + file + "）");
      return {};
    }
    case "loop": {
      const rest2 = rest.slice();
      let cycles = 1;
      let intervalSec = 0;
      // Flags first: --cycles N --every SEC
      const words = [];
      for (let i = 0; i < rest2.length; i++) {
        const w = rest2[i];
        if (w === "--cycles") { cycles = Number(rest2[++i]) || 1; continue; }
        if (w === "--every") { intervalSec = Number(rest2[++i]) || 0; continue; }
        words.push(w);
      }
      let prompt = words.join(" ").trim();
      // No inline prompt: fall back to loop.md in the working directory.
      if (!prompt) {
        const loopFile = join(process.cwd(), "loop.md");
        if (!existsSync(loopFile)) {
          ui.info("用法：/loop <提示词> [--cycles N] [--every 秒]");
          ui.info("或在工作目录放一个 loop.md，然后直接 /loop");
          return {};
        }
        prompt = readFileSync(loopFile, "utf8").trim();
        ui.info(`使用 loop.md（${prompt.length} 字符）`);
      }
      if (cycles < 1) cycles = 1;
      if (cycles > 25) { ui.warn("循环次数上限 25，已按 25 处理"); cycles = 25; }
      ui.info(`开始循环：${cycles} 次${intervalSec ? `，间隔 ${intervalSec}s` : ""}`);
      for (let n = 1; n <= cycles; n++) {
        ui.info(`--- 第 ${n}/${cycles} 次 ---`);
        await agent.run(prompt);
        if (n < cycles && intervalSec > 0) {
          await new Promise((r) => setTimeout(r, intervalSec * 1000));
        }
      }
      ui.success(`循环结束，共 ${cycles} 次`);
      return {};
    }
    case "plan": {
      // Claude shows the current plan and offers "/plan open" to edit it in the
      // user`s editor. The plan is whatever ExitPlanMode last proposed, or the
      // copy saved for this session.
      const { readPlan, planFile } = await import("./session.js");
      const { getLastPlan } = await import("./tools/extended.js");
      const sub = String(rest[0] || "").toLowerCase();
      const id = ctx.autoSaver && ctx.autoSaver.id ? ctx.autoSaver.id : null;
      const fromDisk = id ? readPlan(id) : null;
      const plan = fromDisk != null ? fromDisk : getLastPlan();
      if (plan == null || !String(plan).trim()) {
        ui.info("(no plan yet) — 在计划模式下让模型先提出方案，批准后这里会显示");
        return {};
      }
      if (sub === "open") {
        const target = id ? planFile(id) : null;
        if (!target || !existsSync(target)) {
          // Nothing on disk yet: write it out so the editor has a file to open.
          if (id) { savePlan(id, plan); } else {
            ui.warn("当前会话没有计划文件可打开");
            return {};
          }
        }
        const file = planFile(id);
        const editor = process.env.EDITOR || (process.platform === "win32" ? "notepad" : "vi");
        try {
          spawn(editor, [file], { detached: true, stdio: "ignore", shell: process.platform === "win32" }).unref();
          ui.success(`已在 ${editor} 中打开：${file}`);
        } catch (e) {
          ui.warn(`打开编辑器失败：${e && e.message}\n文件：${file}`);
        }
        return {};
      }
      ui.info(String(plan));
      ui.info("在编辑器中修改：/plan open");
      return {};
    }

    case "todos": {
      const { getTodos } = await import("./tools/extra.js");
      const list = getTodos();
      if (!list.length) { ui.info("(no todos) — TodoWrite 工具可创建"); return {}; }
      ui.info(list.map((t, i) => `  ${i + 1}. [${t.status || "pending"}] ${t.content || ""}`).join("\n"));
      return {};
    }
    case "context": {
      // Claude Code 的 /context：按来源分解 + 可视化水位条，而不是一行总数。
      const segLen = (s) => (typeof s === "string" ? s.length : JSON.stringify(s ?? "").length);
      const sysChars = segLen(agent.systemPrompt || "");
      const msgsChars = agent.messages.reduce((sum, m) => sum + segLen(m.content) + 24, 0);
      const est = (chars) => Math.round(chars / 2.5); // CJK 偏重：/2.5 而非 /4
      const sysTok = est(sysChars);
      const histTok = est(msgsChars);
      const toolCount = allRegisteredTools().length;
      const win = agent.contextWindow || config.contextWindow || 200000;
      const limit = Math.round(win * (config.compactThreshold || 0.8));
      const free = Math.max(0, limit - sysTok - histTok);
      const bar = (label, tokens, width = 32) => {
        const share = Math.max(0, Math.min(1, tokens / limit));
        const fill = Math.round(share * width);
        return "  " + label.padEnd(10, " ") + "│" + "█".repeat(fill) + "░".repeat(width - fill) + "│ ~" + tokens + " tok";
      };
      ui.info([
        "上下文分解（压缩线 " + limit + " / 窗口 " + win + " tokens）",
        bar("系统提示", sysTok),
        bar("历史消息", histTok),
        bar("剩余", free),
        "",
        "  消息        " + agent.messages.length + " 条（" + agent.turnCount + " 回合）· 工具 " + toolCount + " 个",
        "  累计 tokens 输入 " + (agent.totalInputTokens || 0) + " / 输出 " + (agent.totalOutputTokens || 0),
        "  快速模式    " + (config.fastMode ? "开（每轮只带最近 " + (config.fastModeMessages || 24) + " 条）" : "关"),
      ].join("\n"));
      return {};
    }
    case "bashes": {
      // Claude Code 的 /bashes：列出后台 shell。MyClaude 的 /tasks 是超集
      // （含全部后台任务 + 输出读取 + 终止），直接别名。
      return handleCommand("/tasks", ctx);
    }
    case "output-style": {
      // Claude Code 的 /output-style：无参列出全部风格并标当前；带参切换并
      // 重建系统提示。自定义风格是 output-styles/<name>.md。
      const styles = listOutputStyles();
      if (!arg) {
        ui.info("可用输出风格：");
        for (const s of styles) {
          const mark = (config.outputStyle || "default") === s.name ? " ← 当前" : "";
          ui.info("  " + s.name + "（" + s.label + "）" + (s.description ? " — " + s.description : "") + mark);
        }
        ui.info("切换：/output-style <名称>");
        return {};
      }
      const pick = styles.find((s) => s.name === arg);
      if (!pick) { ui.warn("未知风格：" + arg + "（可用：" + styles.map((s) => s.name).join(", ") + "）"); return {}; }
      config.outputStyle = pick.name;
      saveConfig({ outputStyle: pick.name });
      agent.setOutputStyle(pick.name);
      ui.success("输出风格 → " + pick.name + "（" + pick.label + "）");
      return {};
    }
    case "skill": {
      const name = rest[0];
      if (!name) { ui.warn("用法：/skill <技能名>"); return {}; }
      const { loadSkills } = await import("./skills.js");
      const skills = await loadSkills(process.cwd());
      const hit = skills.find((s) => s.name === name);
      if (!hit) {
        ui.warn(`没有名为 ${name} 的技能。可用：${skills.map((s) => s.name).join(", ") || "(无)"}`);
        return {};
      }
      ui.info(`执行技能 ${hit.name}…`);
      await agent.run(hit.body || "");
      return {};
    }
    case "release-notes": {
      const f = join(process.cwd(), "docs", "CHANGELOG.md");
      if (!existsSync(f)) { ui.info("(no release notes) — docs/CHANGELOG.md 不存在"); return {}; }
      ui.info(readFileSync(f, "utf8"));
      return {};
    }
    case "add-dir": {
      if (!rest[0]) {
        const dirs = config.additionalDirectories || [];
        ui.info(dirs.length ? "额外工作目录：\n  " + dirs.join("\n  ") : "(no extra dirs) — 用法：/add-dir <路径>");
        return {};
      }
      const { resolve } = await import("node:path");
      const abs = resolve(rest[0]);
      if (!existsSync(abs) || !statSync(abs).isDirectory()) { ui.warn(`不是目录：${abs}`); return {}; }
      config.additionalDirectories = config.additionalDirectories || [];
      if (!config.additionalDirectories.includes(abs)) config.additionalDirectories.push(abs);
      saveConfig({ additionalDirectories: config.additionalDirectories });
      ui.success(`已添加工作目录 ${abs}（已写入系统提示）`);
      return {};
    }
    case "auto": {
      const on = rest[0] === "on" ? true : rest[0] === "off" ? false : !config.autoRun;
      config.autoRun = on;
      setAutonomous(on);
      saveConfig({ autoRun: on });
      if (on) {
        ui.info("自主模式已开启 — 回合上限后自动续跑（上限 10 轮 / 60 分钟），AskUserQuestion 已屏蔽");
        ui.info("权限将自动切换到 auto；随时 /exit 或停止可中断");
      } else {
        ui.info("自主模式已关闭 — 每轮发送完整历史");
      }
      return {};
    }
    case "agents": {
      const { loadAgents } = await import("./skills.js");
      const agents = loadAgents(process.cwd());
      if (!agents.length) {
        ui.info("(no agents) — 在 .myclaude/agents/<名>.md 放定义文件：\n  ---\n  name: 我的代理\n  description: 一句话说明\n  ---\n  （正文为该子代理的操作指令）");
        return {};
      }
      ui.info("已定义的子代理：\n" + agents.map((a) => `  ${a.name}${a.description ? " — " + a.description : ""}`).join("\n"));
      ui.info("用法：Task 工具的 subagent_type 直接填代理名");
      return {};
    }
    case "hooks": {
      // The engine and the GUI CRUD existed, but there was no way to see or
      // change hooks from the terminal.
      const { HOOK_EVENTS } = await import("./hooks.js");
      const configured = (config.hooks && typeof config.hooks === "object") ? config.hooks : {};
      const sub = String(rest[0] || "").toLowerCase();
      if (sub === "events") {
        ui.info(HOOK_EVENTS.join("\n"));
        return {};
      }
      if (sub === "remove" || sub === "rm") {
        const event = rest[1];
        if (!event || !configured[event]) {
          ui.warn("用法：/hooks remove <事件名>");
          return {};
        }
        delete config.hooks[event];
        saveConfig({ hooks: config.hooks });
        ui.success(`已移除 ${event} 的钩子`);
        return {};
      }
      // No argument: list what is configured, grouped by event.
      const rows = [];
      for (const event of HOOK_EVENTS) {
        const groups = configured[event];
        if (!Array.isArray(groups) || !groups.length) { continue; }
        const cmds = [];
        for (const g of groups) {
          for (const h of (g && g.hooks) || []) {
            if (h && h.command) { cmds.push(String(h.command)); }
          }
        }
        rows.push(`  ${event}  ${cmds.join("; ") || "(无命令)"}`);
      }
      if (!rows.length) {
        ui.info("(no hooks) — 在 config.json 的 hooks 里配置，或用 /hooks events 看可用事件");
        return {};
      }
      ui.info("已配置的钩子：\n" + rows.join("\n"));
      ui.info("事件清单：/hooks events ｜ 移除：/hooks remove <事件>");
      return {};
    }
    case "memory": {
      // /memory shows the project memory; "/memory add <text>" appends to it.
      // Editing was display-only before, which meant the file could be read
      // but not changed without leaving the agent.
      const sub = String(rest[0] || "").toLowerCase();
      if (sub === "add") {
        const text = rest.slice(1).join(" ").trim();
        if (!text) {
          ui.warn("用法：/memory add <要记住的内容>");
          return {};
        }
        const { memoryFilePath, appendMemory } = await import("./agent/permissions.js");
        const file = appendMemory(text, process.cwd());
        ui.success(`已记入 ${file}`);
        return {};
      }
      if (sub === "path") {
        const { memoryFilePath } = await import("./agent/permissions.js");
        ui.info(memoryFilePath(process.cwd()));
        return {};
      }
      const { loadMemory } = await import("./agent/permissions.js");
      const mem = loadMemory(process.cwd());
      if (mem) ui.info(mem);
      else ui.info("(no MYCLAUDE.md found in this project or ancestors)");
      return {};
    }
    case "permissions": {
      const p = config.permissions || {};
      const fmt = (k) => (p[k]?.length ? p[k].map((r) => `  ${k}: ${r}`).join("\n") : `  ${k}: (none)`);
      ui.info(["allow", "deny", "ask"].map(fmt).join("\n"));
      return {};
    }
    case "reload-memory":
      agent.reloadMemory();
      ui.success("project memory reloaded");
      return {};
    case "stats": {
      const s = agent.stats();
      ui.info(`messages=${s.messages} turns=${s.turns}`);
      return {};
    }
        case "review": {
      // Claude Code 的 /review：把审查提示词当普通回合跑，agent 用自己的
      // Bash/Read 工具拉 diff、读上下文、产出分级报告。复用 customPrompt
      // 通道，走同一套 run/save/compact 路径。
      return { customPrompt: reviewPrompt(arg), customName: "review", custom: {} };
    }
case "init": {
      // Summarise the project into MYCLAUDE.md, which loadMemory() then feeds
      // back into the system prompt on every start. Written from facts on disk
      // rather than by asking the model, so it works offline and cannot invent
      // commands that do not exist.
      const root = process.cwd();
      const target = join(root, "MYCLAUDE.md");
      if (existsSync(target) && !/\bforce\b/.test(arg)) {
        ui.warn("MYCLAUDE.md already exists — run /init force to regenerate");
        return {};
      }
      const info = inspectProject(root);
      const body = renderProjectMemory(info);
      writeFileSync(target, body, "utf8");
      ui.success(`wrote ${target}`);
      for (const line of body.split("\n").filter((l) => l.startsWith("# ") || l.startsWith("## "))) {
        ui.info("  " + line);
      }
      agent.reloadMemory();
      ui.info("project memory reloaded");
      return {};
    }
    case "export": {
      // Dump the conversation as Markdown so it can be pasted into a doc or an
      // issue. The GUI has its own export; this is the terminal equivalent.
      const out = arg || join(process.cwd(), "myclaude-export-" + Date.now() + ".md");
      const md = renderTranscriptMarkdown(agent, config);
      writeFileSync(out, md, "utf8");
      ui.success(`exported ${agent.messages.length} messages → ${out}`);
      return {};
    }
    case "cost": {
      // Prices come from the catalogue, not from a second table, so /cost can
      // never disagree with the model picker. An entry without a verified rate
      // reports that explicitly: showing $0.0000 would look like a free model.
      const inTok = Number(agent.totalInputTokens) || 0;
      const outTok = Number(agent.totalOutputTokens) || 0;
      const usage = agent.usage || agent.lastUsage || {};
      const cachedTok =
        Number(
          agent.totalCachedTokens ??
            agent.totalCachedInputTokens ??
            agent.totalCacheReadTokens ??
            usage.cachedTokens ??
            usage.cached_tokens ??
            usage.promptTokensDetails?.cachedTokens ??
            usage.prompt_tokens_details?.cached_tokens ??
            0
        ) || 0;
      const priceLine = costLineFor(config.model, inTok, outTok);
      const priced = priceLine !== NO_PRICE_NOTICE;

      ui.info(`模型        ${config.model}`);
      ui.info(`输入        ${inTok.toLocaleString()} tokens`);
      ui.info(`输出        ${outTok.toLocaleString()} tokens`);
      if (cachedTok > 0) ui.info(`缓存命中    ${cachedTok.toLocaleString()} tokens`);
      ui.info(`总计        ${(inTok + outTok).toLocaleString()} tokens`);
      ui.info(
        priced
          ? `计价        ${priceLine}（按公开标价估算，未应用缓存折扣）`
          : `计价        ${priceLine}`
      );
      return {};
    }
    case "doctor": {
      // A quick environment check: every line answers "is this wired up?".
      const row = (ok, label, detail) => {
        const mark = ok === true ? "ok  " : ok === "warn" ? "warn" : "FAIL";
        const line = `${mark}  ${label.padEnd(16)} ${detail || ""}`.trimEnd();
        if (ok === false) ui.error(line); else if (ok === "warn") ui.warn(line); else ui.info(line);
      };
      ui.info(`MyClaude ${VERSION}`);
      ui.info("");
      row(Boolean(config.model), "model", String(config.model || "(unset)"));
      row(Boolean(config.baseUrl), "baseUrl", String(config.baseUrl || "(unset)"));
      const keySet = Boolean(config.apiKey) || Boolean(process.env[GATEWAY_KEY_ENV]);
      row(keySet ? true : "warn", "apiKey", keySet ? "(set)" : "not set (gateway may not need one)");
      row(Boolean(config.permissionMode), "mode", String(config.permissionMode || "ask"));
      row(true, "tools", `${agent.tools.length} registered`);
      row(Boolean(config.mcpServers && Object.keys(config.mcpServers).length) ? true : "warn",
        "mcp", config.mcpServers ? `${Object.keys(config.mcpServers).length} server(s)` : "none configured");
      row(Boolean(config.hooks) ? true : "warn", "hooks",
        config.hooks ? `${Object.keys(config.hooks).length} event(s)` : "none configured");
      row(agent.checkpoints.size > 0 ? true : "warn", "checkpoints",
        agent.checkpoints.size > 0 ? `${agent.checkpoints.size} file(s) captured` : "nothing captured this turn");
      row(true, "sessions", ctx.autoSaver ? `current ${ctx.autoSaver.id}` : "not saving");
      ui.info("");
      try {
        const models = await provider.listModels();
        row(true, "gateway", `reachable, ${models.length} model(s)`);
      } catch (e) {
        row(false, "gateway", String(e.message || e).slice(0, 80));
      }
      return {};
    }
    case "config":
      ui.info(JSON.stringify(config, null, 2));
      return {};
    case "models":
      try {
        const models = await provider.listModels();
        ui.info(models.map((m) => `  ${m}`).join("\n"));
      } catch (e) {
        ui.error(e.message);
      }
      return {};
    case "save": {
      const id = arg || ctx.autoSaver?.id || newSessionId();
      const file = ctx.autoSaver && id === ctx.autoSaver.id
        ? ctx.autoSaver.flush()
        : saveSession(id, agent.messages, sessionMeta(agent, config));
      ui.success(`saved ${agent.messages.length} messages → ${file}`);
      return {};
    }
    case "session": {
      const saver = ctx.autoSaver;
      if (!saver) {
        ui.info("(auto-save disabled for this run)");
        return {};
      }
      ui.info(`id: ${saver.id}\nfile: ${saver.file || sessionFile(saver.id)}`);
      return {};
    }
    case "continue": {
      const latest = latestSession({ cwd: process.cwd() }) || latestSession();
      if (!latest) {
        ui.warn("(no saved sessions to continue)");
        return {};
      }
      const data = loadSession(latest.id);
      if (!data) {
        ui.error(`未找到会话：${latest.id}`);
        return {};
      }
      agent.messages = data.messages || [];
      ctx.autoSaver?.rotate(latest.id);
      ui.success(`continued ${agent.messages.length} messages from ${latest.id}`);
      return {};
    }
    case "sessions": {
      const list = listSessions();
      if (!list.length) {
        ui.info("(no saved sessions)");
      } else {
        ui.info(
          list
            .map((s) => {
              const when = s.updatedAt ?? s.savedAt ?? "?";
              return `${s.id}  ${String(s.messages).padStart(3)} msgs  ${when}${s.cwd ? `  ${s.cwd}` : ""}`;
            })
            .join("\n")
        );
      }
      return {};
    }
    case "resume": {
      if (!arg) {
        ui.warn("用法：/resume <会话 id>");
        return {};
      }
      const data = loadSession(arg);
      if (!data) {
        ui.error(`未找到会话：${arg}`);
        return {};
      }
      agent.messages = data.messages || [];
      ctx.autoSaver?.rotate(arg);
      ui.success(`resumed ${agent.messages.length} messages from ${arg}`);
      return {};
    }
    case "rm": {
      if (!arg) {
        ui.warn("用法：/rm <会话 id>");
        return {};
      }
      ui.success(deleteSession(arg) ? `已删除 ${arg}` : `未找到：${arg}`);
      return {};
    }
    case "plugin": {
      // "/plugin <name>" shows one plugin in detail.
      if (rest[0]) {
        const all = loadPlugins(process.cwd());
        const one = all.find((x) => x.name === rest[0] || x.name.toLowerCase() === rest[0].toLowerCase());
        if (!one) {
          ui.info(`没有名为 "${rest[0]}" 的插件。`);
          return {};
        }
        ui.info(`插件 ${one.name}（${one.scope}）`);
        ui.info(`  目录      ${one.root}`);
        ui.info(`  版本      ${one.manifest.version || "未标注"}`);
        if (one.manifest.description) { ui.info(`  说明      ${one.manifest.description}`); }
        ui.info(`  组件      ${one.components.length ? one.components.join(", ") : "无"}`);
        if (one.problem) {
          ui.warn(`  未加载    ${one.problem} — ${one.reason}`);
        }
        return {};
      }
      const summaries = pluginSummaries(process.cwd());
      if (!summaries.length) {
        ui.info("(no plugins) — add a directory with plugin.json under .myclaude/plugins/ or ~/.myclaude/plugins/");
        return {};
      }
      ui.info(`plugins (${summaries.length}):\n${summaries.join("\n")}`);
      return {};
    }
    case "skills": {
      const list = loadSkills(process.cwd());
      if (!list.length) {
        ui.info(
          "(no skills) — add a directory containing SKILL.md under " +
            ".myclaude/skills/ or ~/.myclaude/skills/"
        );
        return {};
      }
      ui.info(
        `skills (${list.length}):\n` +
          list
            .map((s) => `  /${s.name.padEnd(16)} ${s.description}${s.scope === "user" ? "  (user)" : ""}`)
            .join("\n")
      );
      return {};
    }
    case "commands": {
      const list = loadCommands(process.cwd());
      if (!list.length) {
        ui.info("(no custom commands) — add Markdown files under .myclaude/commands/ or ~/.myclaude/commands/");
        return {};
      }
      ui.info(
        list
          .map((c) => `  /${c.name.padEnd(16)} ${c.description}${c.scope === "user" ? "  (user)" : ""}`)
          .join("\n")
      );
      return {};
    }
    default: {
      // Not a built-in: try a user/project command file before giving up.
      const custom = findCommand(cmd, process.cwd());
      if (!custom) {
        ui.warn(`未知命令：/${cmd}`);
        return {};
      }
      return { customPrompt: expandCommand(custom, arg), customName: cmd, custom };
    }
  }
}

async function runPlain({ config, provider, agent, autoSaver, ui }) {
  ui.start();
  ui.banner(config);

  const ctx = { agent, config, provider, ui, pendingAttachments: [], autoSaver };
  let running = true;
  // Claude Code 的 Esc+Esc：把上一条用户消息召回输入行，编辑后重新提交。
  // 提交时若与召回的内容一致，先 rewind 到该消息前再跑，历史不重复。
  let editPrevious = false;
  let lastUserText = "";
  ui.onEditPrevious = () => {
    if (!lastUserText) { ui.warn("还没有可编辑的历史消息"); return; }
    editPrevious = true;
    ui.rl?.write(lastUserText);
  };
  while (running) {
    let input;
    try {
      input = await ui.prompt();
    } catch {
      break;
    }
    const trimmed = input.trim();
    if (!trimmed) continue;

    let wasRewound = false;
    if (editPrevious) {
      editPrevious = false;
      if (trimmed === lastUserText) {
        agent.rewind(trimmed);
        wasRewound = true;
        ui.info("已回退到上一条消息，重新执行");
      }
    }
    lastUserText = trimmed;

    if (trimmed.startsWith("/")) {
      const r = await handleCommand(trimmed, ctx);
      if (r.exit) running = false;
      // A custom command expands into a normal turn, so it must go through the
      // same run/save/compact path as typed input.
      if (r.customPrompt) {
        ui.info(`执行自定义命令 /${r.customName}\n`);
        const files = ctx.pendingAttachments.splice(0);
        await withCommandScope(agent, config, provider, r.custom || {}, async () => {
          agent.run(r.customPrompt, { attachments: files });
        });
        const compact = await agent.maybeCompact();
        if (compact) ui.info(`context compacted (dropped ${compact.dropped} messages)`);
        autoSaver?.save();
      }
      continue;
    }

    const files = ctx.pendingAttachments.splice(0);
    if (wasRewound) {
      // Esc+Esc 重跑：rewind 已把用户消息放回，不能再 append 一份。
      wasRewound = false;
      await agent.run("", { attachments: files, reuseLastUser: true });
    } else {
          }
    await agent.run(trimmed, { attachments: files });
    const compact = await agent.maybeCompact();
    if (compact) ui.info(`context compacted (dropped ${compact.dropped} messages)`);
    autoSaver?.save();
  }
  autoSaver?.dispose();
  ui.stop();
}

async function runTui({ config, provider, agent, autoSaver }) {
  const { startTui } = await import("./ui/ink-ui.js");

  let exiting = false;
  let bridge;
  let bridgeUi;
  const pendingAttachments = [];

  const tui = startTui({
    config,
    getStats: () => ({ turns: agent.turnCount, messages: agent.messages.length }),
    onSubmit: async (text) => {
      agent.ui = bridgeUi;
      bridge.setBusy(true);
      const files = pendingAttachments.splice(0);
      bridge.setAttachments(pendingAttachments);
      try {
        await (config.autoRun
        ? runWithAutoContinue(agent, { message: text, attachments: files }, { ui })
        : agent.run(text, { attachments: files }));
        const compact = await agent.maybeCompact();
        if (compact) bridge.info(`context compacted (dropped ${compact.dropped} messages)`);
      } finally {
        autoSaver?.save();
        bridge.setBusy(false);
        bridge.setMode(agent.mode ?? config.permissionMode);
      }
    },
    onCommand: async (text) => {
      agent.ui = bridgeUi;
      const r = await handleCommand(text, { agent, config, provider, ui: bridgeUi, pendingAttachments, autoSaver });
      bridge.setAttachments(pendingAttachments);
      bridge.setMode(agent.mode ?? config.permissionMode);
      if (r.exit) {
        exiting = true;
        tui.instance.unmount();
        return;
      }
      // Custom command: run it as a normal turn with the same busy handling.
      if (r.customPrompt) {
        bridge.info(`执行自定义命令 /${r.customName}`);
        bridge.setBusy(true);
        const files = pendingAttachments.splice(0);
        bridge.setAttachments(pendingAttachments);
        try {
          await withCommandScope(agent, config, provider, r.custom || {}, async () => {
            agent.run(r.customPrompt, { attachments: files });
          });
          const compact = await agent.maybeCompact();
          if (compact) bridge.info(`context compacted (dropped ${compact.dropped} messages)`);
        } finally {
          autoSaver?.save();
          bridge.setBusy(false);
          bridge.setMode(agent.mode ?? config.permissionMode);
        }
      }
    },
    onExit: () => {
      exiting = true;
    },
  });

  bridge = tui.bridge;

  bridgeUi = {
    streamText: (t) => bridge.streamText(t),
    endStream: () => bridge.endStream(),
    info: (t) => bridge.info(t),
    warn: (t) => bridge.warn(t),
    error: (t) => bridge.error(t),
    success: (t) => bridge.success(t),
    toolStart: (n, a) => bridge.toolStart(n, a),
    toolEnd: (n, ok, el, out) => bridge.toolEnd(n, ok, el, out),
    confirmTool: (n, a) => bridge.confirmTool(n, a),
    askQuestions: (questions) => bridge.askQuestions(questions),
  };

  bridge.abort = () => agent.abort();

  agent.ui = bridgeUi;
  await tui.waitUntilExit();
  autoSaver?.dispose();
  process.exitCode = exiting ? 0 : 0;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  if (opts.help) {
    console.log(HELP);
    return;
  }
  if (opts.version) {
    console.log("myclaude " + VERSION);
    return;
  }
  if (opts.configPath) {
    console.log(configPath());
    return;
  }

  const config = loadConfig();
  if (opts.auto) config.permissionMode = "auto";
  if (opts.plan) config.permissionMode = "plan";
  // Checked last so it wins over --auto when both are given: it is the
  // deliberately broadest mode and silently ignoring it would be confusing.
  if (opts.fullAccess) config.permissionMode = "fullAccess";

  const provider = createProvider(config);

  // CLI 权限旗标（对齐 Claude Code --allowed-tools/--disallowed-tools）：
  // 合并进 config.permissions，对 TUI 与 -p 都生效。
  if (opts.allowedTools.length || opts.disallowedTools.length) {
    config.permissions = config.permissions || {};
    if (opts.allowedTools.length) { config.permissions.allow = [...(config.permissions.allow || []), ...opts.allowedTools]; }
    if (opts.disallowedTools.length) { config.permissions.deny = [...(config.permissions.deny || []), ...opts.disallowedTools]; }
  }
  if (opts.oneShot) {
    const jsonOut = opts.outputFormat === "json";
    const jsonl = opts.outputFormat === "stream-json";
    const emit = jsonl ? (ev) => { try { console.log(JSON.stringify(ev)); } catch {} } : null;
    const ui = jsonl
      ? { streamText(t) { emit({ type: "text", text: t }); }, endStream() {}, info(t) { emit({ type: "info", text: String(t) }); }, warn(t) { emit({ type: "warn", text: String(t) }); }, error(t) { emit({ type: "error", text: String(t) }); }, success(t) { emit({ type: "success", text: String(t) }); }, toolStart(n, a) { emit({ type: "tool_use", name: n, args: a }); }, toolEnd(n, ok, el, out) { emit({ type: "tool_result", name: n, ok: !!ok, elapsed: el }); }, confirmTool: async () => true }
      : jsonOut
      ? { streamText() {}, endStream() {}, info() {}, warn() {}, error() {}, success() {}, toolStart() {}, toolEnd() {}, confirmTool: async () => true }
      : new TerminalUI({ useColor: process.stdout.isTTY });
    // -p 与 --resume/--continue 组合时必须加载历史，否则"继续会话"跑在空上下文里。
    let resumeId = opts.resume || null;
    if (!resumeId && opts.continueSession) {
      const latest = latestSession({ cwd: process.cwd() });
      if (latest) resumeId = latest.id;
    }
    let resumedMessages = [];
    if (resumeId) {
      const loaded = loadSession(resumeId);
      if (loaded) { resumedMessages = loaded.messages || []; }
      else { console.error("找不到会话: " + resumeId); process.exit(1); }
    }
    const agent = await createAgent({
      provider,
      config,
      ui,
      providerFactory: () => createProvider(config),
      sessionKey: resumeId || undefined,
      sessionSource: resumeId ? "resume" : "startup",
    });
    if (resumedMessages.length) { agent.messages = resumedMessages; }
    const oneShotSaver = createAutoSaver({
      id: resumeId || undefined,
      getMessages: () => agent.messages,
      getMeta: () => ({ cwd: process.cwd(), model: config.model, provider: config.provider, ui: "cli" }),
    });
    try {
      const result = await agent.run(opts.oneShot);
      if (result.error) process.exitCode = 1;
      try { oneShotSaver.save({ force: true }); } catch {}
      if (jsonl) {
        const lastAsst2 = [...agent.messages].reverse().find((m) => m.role === "assistant");
        emit({ type: "result", result: lastAsst2 ? (typeof lastAsst2.content === "string" ? lastAsst2.content : JSON.stringify(lastAsst2.content)) : "", sessionId: oneShotSaver.id, turns: agent.turnCount, inputTokens: agent.totalInputTokens || 0, outputTokens: agent.totalOutputTokens || 0 });
      }
      if (jsonOut) {
        const lastAsst = [...agent.messages].reverse().find((m) => m.role === "assistant");
        const text = lastAsst ? (typeof lastAsst.content === "string" ? lastAsst.content : JSON.stringify(lastAsst.content)) : "";
        console.log(JSON.stringify({ result: text, sessionId: oneShotSaver.id, turns: agent.turnCount, inputTokens: agent.totalInputTokens || 0, outputTokens: agent.totalOutputTokens || 0 }));
      }
    } finally {
      closeAgent(agent);
    }
    return;
  }

  if (opts.gui) {
    const { startGui } = await import("./ui/gui-server.js");
    let address;
    try {
      ({ address } = await startGui({ config, port: opts.port, open: !opts.noOpen }));
    } catch (e) {
      console.error(String((e && e.message) || e));
      process.exit(1);
    }
    console.log(`MyClaude GUI running at ${address}`);
    console.log("Press Ctrl+C to stop.");
    await new Promise(() => {});
    return;
  }

  const ui = new TerminalUI();
  const agent = await createAgent({
    provider,
    config,
    ui,
    providerFactory: () => createProvider(config),
      sessionSource: (opts.resume || opts.continueSession) ? "resume" : "startup",
  });

  const autoSaver = createAutoSaver({
    id: opts.resume || undefined,
    getMessages: () => agent.messages,
    getMeta: () => sessionMeta(agent, config),
  });

  // The tools need the session id so an approved plan can be written to disk
  // and shown again later by /plan.
  setPlanSessionId(autoSaver.id);
  setAutonomous(config.autoRun);

  // --resume <id> / --continue: restore history before the first prompt.
  if (opts.resume || opts.continueSession) {
    const target = opts.resume ? loadSession(opts.resume) : loadSession(latestSession({ cwd: process.cwd() })?.id ?? "");
    if (target) {
      agent.messages = target.messages || [];
      ui.info(`resumed ${agent.messages.length} messages from ${target.id}`);
    } else {
      ui.warn(opts.resume ? `未找到会话：${opts.resume}` : "no previous session to continue");
    }
  }
  pruneSessions();

  if (opts.plain || !process.stdout.isTTY) {
    try {
      await runPlain({ config, provider, agent, autoSaver, ui });
    } finally {
      closeAgent(agent);
    }
    return;
  }

  try {
    await runTui({ config, provider, agent, autoSaver });
  } finally {
    closeAgent(agent);
  }
}

main().catch((e) => {
  console.error(`fatal: ${e?.stack || e?.message || e}`);
  process.exit(1);
});




