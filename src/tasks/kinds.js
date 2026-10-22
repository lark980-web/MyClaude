/**
 * Starting the kinds of task that are more than a shell command.
 *
 * The registry holds every task the same way; this module knows how to start
 * each kind and what its fields mean. The shapes follow Claude Code:
 *
 *   mcp_task     { serverName, toolName }  shown as "server/tool"
 *   monitor_*    { description, statusMessage, notified }
 *   workflow     { scriptPath }  the script is checked before it runs
 *
 * A monitor is the one kind that never finishes on its own: it reports events
 * for as long as the connection lives, so it ends only when cancelled or when
 * the connection drops.
 */
import { existsSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { registry, TASK_TYPES } from "./registry.js";

/**
 * Start a task that represents a call into an MCP server.
 *
 * The call itself is made by the MCP client; this records it so the task list
 * shows what the agent is waiting on, the same way a shell command does.
 *
 * @param {{serverName: string, toolName: string, args?: object}} spec
 * @returns {object} the registered task
 */
export function startMcpTask({ serverName, toolName, args = {} }) {
  const qualified = `${serverName}/${toolName}`;
  const task = registry.create({
    type: TASK_TYPES.MCP_TASK,
    label: qualified,
    meta: { serverName, toolName, args },
  });
  registry.start(task);
  return task;
}

/**
 * Start a monitor for a long-lived connection.
 *
 * The connection is owned by the caller; the task is the record the user and
 * the agent look at. `kind` chooses between the MCP and generic WebSocket
 * variants, which are separate types in Claude but behave the same here.
 *
 * @param {{kind?: "mcp"|"ws", description: string, cancel?: Function}} spec
 * @returns {object} the registered task
 */
export function startMonitor({ kind = "ws", description, cancel = null }) {
  const type = kind === "mcp" ? TASK_TYPES.MONITOR_MCP : TASK_TYPES.MONITOR_WS;
  const task = registry.create({
    type,
    label: description,
    meta: { description, statusMessage: "", notified: false },
  });
  // A monitor is running from the moment it is registered: there is no
  // pending phase to wait for.
  registry.start(task);
  if (typeof cancel === "function") { task.cancel = cancel; }
  return task;
}

/**
 * Update the one-line status a monitor reports.
 *
 * @param {object} task
 * @param {string} message
 */
export function setMonitorStatus(task, message) {
  if (!task) { return task; }
  task.meta.statusMessage = String(message || "");
  return task;
}

/**
 * The reason a workflow script cannot be run, or null when it can.
 *
 * A workflow runs a file, so the file has to exist and be a file. The check
 * happens before the task is created: a typo in a path should be an error the
 * caller sees, not a task that fails a moment later.
 *
 * @param {string} scriptPath
 * @param {string} [cwd]
 * @returns {string|null}
 */
export function workflowScriptBlocker(scriptPath, cwd = process.cwd()) {
  const raw = String(scriptPath || "").trim();
  if (!raw) { return "a workflow needs a script path"; }
  const full = isAbsolute(raw) ? raw : resolve(cwd, raw);
  if (!existsSync(full)) { return `no such script: ${full}`; }
  try {
    if (!statSync(full).isFile()) { return `not a file: ${full}`; }
  } catch (e) {
    return `cannot read ${full}: ${e.message}`;
  }
  return null;
}

/**
 * Create a workflow task for a validated script.
 *
 * @param {{scriptPath: string, steps?: string[], cwd?: string}} spec
 * @returns {{ok: true, task: object} | {ok: false, error: string}}
 */
export function startWorkflow({ scriptPath, steps = [], cwd = process.cwd() }) {
  const blocker = workflowScriptBlocker(scriptPath, cwd);
  if (blocker) { return { ok: false, error: blocker }; }
  const full = isAbsolute(scriptPath) ? scriptPath : resolve(cwd, scriptPath);
  const task = registry.create({
    type: TASK_TYPES.WORKFLOW,
    label: scriptPath,
    meta: { scriptPath: full, steps, cwd, currentStep: -1 },
  });
  registry.start(task);
  return { ok: true, task };
}

/**
 * Record which step of a workflow is running.
 *
 * @param {object} task
 * @param {number} index
 * @param {string} [name]
 */
export function setWorkflowStep(task, index, name = "") {
  if (!task) { return task; }
  task.meta.currentStep = index;
  if (name) { registry.appendOutput(task, `[step ${index + 1}] ${name}\n`); }
  return task;
}


/**
 * Start a dream: a background pass that consolidates project memory.
 *
 * In Claude a dream is not a command; it runs on its own to merge duplicate
 * memories, prune stale ones and check them against CLAUDE.md
 * (95_chunk-rcj0vzxn.js). It carries skipTranscript, a phase and the list of
 * files it touched, because it is quiet work that must not pollute the
 * conversation transcript.
 *
 * @param {{sessionsReviewing?: number, cancel?: Function}} [spec]
 * @returns {object} the registered task
 */
export function startDream({ sessionsReviewing = 0, cancel = null } = {}) {
  const task = registry.create({
    type: TASK_TYPES.DREAM,
    label: "整理项目记忆",
    meta: {
      skipTranscript: true,
      phase: "starting",
      sessionsReviewing,
      filesTouched: [],
    },
  });
  registry.start(task);
  if (typeof cancel === "function") { task.cancel = cancel; }
  return task;
}

/**
 * Move a dream to a new phase and record it.
 *
 * @param {object} task
 * @param {string} phase
 * @param {string[]} [files] files the phase touched
 */
export function setDreamPhase(task, phase, files = []) {
  if (!task) { return task; }
  task.meta.phase = String(phase || "");
  for (const f of files || []) {
    if (f && !task.meta.filesTouched.includes(f)) { task.meta.filesTouched.push(f); }
  }
  registry.appendOutput(task, `[dream] ${phase}\n`);
  return task;
}

/**
 * Start an auto-mode scan: the reviewer pass that screens an action.
 *
 * Claude describes auto mode as "no routine prompts; a reviewer model screens
 * actions" (933_chunk-0qdm07jf.js). The scan is quiet work — it only carries a
 * description and a status — so it is its own task type rather than a dream.
 *
 * @param {{description: string, cancel?: Function}} spec
 * @returns {object} the registered task
 */
export function startAutoModeScan({ description, cancel = null }) {
  const task = registry.create({
    type: TASK_TYPES.AUTO_MODE_SCAN,
    label: String(description || "审查动作"),
    meta: { description: String(description || "") },
  });
  registry.start(task);
  if (typeof cancel === "function") { task.cancel = cancel; }
  return task;
}