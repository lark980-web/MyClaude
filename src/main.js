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

const HELP = `MyClaude — terminal AI coding agent

Usage:
  myclaude                 interactive TUI (default in a terminal)
  myclaude --plain         simple readline REPL
  myclaude --gui           web GUI in your browser
  myclaude -p "prompt"     one-shot, print answer

Options:
  --auto, --yes            auto-approve every tool call
--full-access            full access: skip prompts and deny rules
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
    version: "0.2.0",
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
        ui.warn(`unknown mode: ${arg}  (可选: ${PERMISSION_MODES.map((x) => x.id).join(" | ")})`);
      }
      return {};
    case "attach": {
      if (!arg) {
        ui.warn("usage: /attach <path> [more paths…]");
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
        ui.warn("usage: /vision [on|off]");
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
      const { taskSummaries } = await import("./tools/tasks.js");
      const list = taskSummaries();
      if (!list.length) {
        ui.info("(no background tasks) — start one with Bash(run_in_background=true)");
      } else {
        ui.info(
          list
            .map((t) => `${t.id}  ${t.status}${t.exitCode != null ? ` (exit ${t.exitCode})` : ""}  ${t.command}`)
            .join("\n")
        );
      }
      return {};
    }
    case "memory": {
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
        ui.error(`session not found: ${latest.id}`);
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
        ui.warn("usage: /resume <id>");
        return {};
      }
      const data = loadSession(arg);
      if (!data) {
        ui.error(`session not found: ${arg}`);
        return {};
      }
      agent.messages = data.messages || [];
      ctx.autoSaver?.rotate(arg);
      ui.success(`resumed ${agent.messages.length} messages from ${arg}`);
      return {};
    }
    case "rm": {
      if (!arg) {
        ui.warn("usage: /rm <id>");
        return {};
      }
      ui.success(deleteSession(arg) ? `deleted ${arg}` : `not found: ${arg}`);
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
        ui.warn(`unknown command: /${cmd}`);
        return {};
      }
      return { customPrompt: expandCommand(custom, arg), customName: cmd };
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
        await agent.run(r.customPrompt, { attachments: files });
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
          await agent.run(r.customPrompt, { attachments: files });
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
    console.log("myclaude 0.18.0");
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
      ui.warn(opts.resume ? `session not found: ${opts.resume}` : "no previous session to continue");
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




