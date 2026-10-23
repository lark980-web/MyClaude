#!/usr/bin/env node
import { loadConfig, saveConfig, configPath } from "./config.js";
import { createProvider } from "./providers/openai.js";
import { Agent } from "./agent/agent.js";
import { TerminalUI } from "./ui/terminal.js";
import { allRegisteredTools } from "./tools/index.js";
import { createAgent, closeAgent } from "./agent/runtime.js";
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
import { registry as taskRegistry } from "./tasks/registry.js";
import { loadPlugins, pluginSummaries } from "./plugins.js";

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
    resume: null,
  };
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


async function handleCommand(raw, ctx) {
  const { agent, config, provider, ui } = ctx;
  const [cmd, ...rest] = raw.slice(1).split(/\s+/);
  const arg = rest.join(" ");

  switch (cmd) {
    case "exit":
    case "quit":
    case "q":
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
        `快速模式    ${config.fastMode ? "开" : "关"}`
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
      ui.info(on ? "已开启快速模式" : "已关闭快速模式");
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
  while (running) {
    let input;
    try {
      input = await ui.prompt();
    } catch {
      break;
    }
    const trimmed = input.trim();
    if (!trimmed) continue;

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
        await agent.run(text, { attachments: files });
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

  if (opts.oneShot) {
    const ui = new TerminalUI({ useColor: process.stdout.isTTY });
    const agent = await createAgent({
      provider,
      config,
      ui,
      providerFactory: () => createProvider(config),
    });
    try {
      const result = await agent.run(opts.oneShot);
      if (result.error) process.exitCode = 1;
    } finally {
      closeAgent(agent);
    }
    return;
  }

  if (opts.gui) {
    const { startGui } = await import("./ui/gui-server.js");
    const { address } = await startGui({ config, port: opts.port, open: !opts.noOpen });
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
  });

  const autoSaver = createAutoSaver({
    id: opts.resume || undefined,
    getMessages: () => agent.messages,
    getMeta: () => sessionMeta(agent, config),
  });

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




