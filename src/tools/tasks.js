/**
 * Background task registry: Bash(run_in_background=true) spawns a detached
 * child whose stdout/stderr stream into an owned output file. BashOutput and
 * KillShell read/stop those tasks by id. Mirrors Claude Code's task model
 * closely enough that the agent can reason about "task_id" style results.
 */
import { spawn } from "node:child_process";
import { readFile, stat, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

/**
 * @typedef {{ id: string, command: string, cwd: string, shell: string,
 *             startedAt: number, status: "running"|"exited"|"killed"|"error",
 *             exitCode: number|null, signal: string|null, pid: number|null,
 *             outputPath: string, notifyOnExit: boolean }} Task
 */

/** @type {Map<string, Task>} */
const tasks = new Map();
/** @type {Map<string, import("node:child_process").ChildProcess>} */
const procs = new Map();
/** @type {Set<import("node:fs").WriteStream>} */
const streams = new Set();

let outputDir = null;

async function getOutputDir() {
  if (outputDir) return outputDir;
  const { mkdir } = await import("node:fs/promises");
  outputDir = join(tmpdir(), "myclaude-tasks");
  await mkdir(outputDir, { recursive: true });
  return outputDir;
}

function describe(t) {
  return `${t.id}\t${t.status}\t${t.command}`;
}

export function listTasks() {
  return [...tasks.values()].map(describe).join("\n") || "(no tasks)";
}

export function getTask(id) {
  return tasks.get(id) || null;
}

export function taskSummaries() {
  return [...tasks.values()].map((t) => ({
    id: t.id,
    command: t.command,
    cwd: t.cwd,
    status: t.status,
    exitCode: t.exitCode,
    pid: t.pid,
    startedAt: t.startedAt,
  }));
}

/**
 * Start a background command. Resolves as soon as the process is spawned;
 * the caller keeps polling with BashOutput semantics.
 */
export async function startBackground({ command, cwd = process.cwd(), timeout_ms = 600000, notify = true }) {
  const dir = await getOutputDir();
  const id = `task_${randomUUID().slice(0, 8)}`;
  const outputPath = join(dir, `${id}.log`);

  const { createWriteStream } = await import("node:fs");
  const out = createWriteStream(outputPath, { flags: "w" });
  streams.add(out);

  // Same reasoning as the foreground Bash tool: cmd.exe starts in ~80ms while
  // powershell.exe takes seconds, and windowsVerbatimArguments keeps quotes and
  // "&" intact instead of letting the shell parse the string twice.
  const isWin = process.platform === "win32";
  const shell = isWin ? "cmd.exe" : "/bin/sh";
  const args = isWin ? ["/d", "/s", "/c", command] : ["-c", command];

  /** @type {Task} */
  const task = {
    id,
    command,
    cwd,
    shell,
    startedAt: Date.now(),
    status: "running",
    exitCode: null,
    signal: null,
    pid: null,
    outputPath,
    notifyOnExit: notify,
  };
  tasks.set(id, task);

  return new Promise((resolve) => {
  const child = spawn(shell, args, { cwd, windowsHide: true, detached: false, windowsVerbatimArguments: isWin });
    task.pid = child.pid ?? null;
    procs.set(id, child);

    const write = (buf) => {
      if (!out.write(buf)) {
        out.once("drain", () => {});
      }
    };
    child.stdout?.on("data", write);
    child.stderr?.on("data", write);

    let timer = setTimeout(() => {
      killTask(id);
    }, timeout_ms);

    child.on("error", (e) => {
      task.status = "error";
      task.exitCode = -1;
      out.write(`[spawn error] ${e.message}\n`);
      cleanup();
    });

    child.on("close", (code, signal) => {
      // A kill is recorded immediately so callers never observe "running"
      // between killTask() and the process actually exiting.
      if (task.status !== "killed") task.status = signal ? "killed" : "exited";
      task.exitCode = code;
      task.signal = signal;
      out.write(`\n[task ${id} finished with exit code ${code ?? "?"}${signal ? ` (signal ${signal})` : ""}]\n`);
      cleanup();
    });

    function cleanup() {
      clearTimeout(timer);
      procs.delete(id);
      out.end();
      streams.delete(out);
    }

    // Resolve once we know the child actually started (or failed immediately).
    setImmediate(() =>
      resolve({
        ok: task.status === "running",
        id,
        pid: task.pid,
        outputPath,
        status: task.status,
      })
    );
  });
}

export function killTask(id) {
  const proc = procs.get(id);
  const task = tasks.get(id);
  if (!proc || !task) {
    if (task && task.status !== "running") return { ok: true, id, note: "already finished" };
    return { ok: false, id, error: `unknown task: ${id}` };
  }
  try {
    if (process.platform === "win32") {
      spawn("taskkill", ["/pid", String(proc.pid), "/T", "/F"], { windowsHide: true });
    } else {
      proc.kill("SIGTERM");
    }
  } catch (e) {
    return { ok: false, id, error: e.message };
  }
  // Mark as killed right away: taskkill is asynchronous, and callers poll
  // immediately after this returns.
  task.status = "killed";
  task.signal = "SIGTERM";
  return { ok: true, id, pid: proc.pid };
}

/**
 * Read a task's output. Supports tail-style offsets so the agent can poll for
 * new bytes without re-reading the whole log.
 */
export async function readTaskOutput(id, { offset = 0, limit = 60000 } = {}) {
  const task = tasks.get(id);
  if (!task) return { ok: false, error: `unknown task: ${id}` };
  try {
    const raw = await readFile(task.outputPath, "utf8");
    const slice = raw.slice(offset, offset + limit);
    const hasMore = raw.length > offset + limit;
    return {
      ok: true,
      id,
      status: task.status,
      exitCode: task.exitCode,
      pid: task.pid,
      command: task.command,
      output: slice,
      nextOffset: offset + slice.length,
      hasMore,
      totalBytes: raw.length,
    };
  } catch (e) {
    if (e.code === "ENOENT") {
      return { ok: true, id, status: task.status, output: "", nextOffset: 0, hasMore: false };
    }
    return { ok: false, id, error: `${e.code || "ERR"}: ${e.message}` };
  }
}

/** Stop reading a task and wait for it to settle. */
export async function waitTask(id, { timeout = 120000 } = {}) {
  const task = tasks.get(id);
  if (!task) return { ok: false, error: `unknown task: ${id}` };
  if (task.status !== "running") return { ok: true, status: task.status, exitCode: task.exitCode };
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
    if (task.status !== "running") break;
  }
  return { ok: task.status !== "running", status: task.status, exitCode: task.exitCode, timedOut: task.status === "running" };
}

export function clearFinishedTasks() {
  for (const [id, t] of tasks) {
    if (t.status !== "running") tasks.delete(id);
  }
}

/** Best-effort cleanup for process exit. */
export function killAllTasks() {
  for (const id of [...procs.keys()]) killTask(id);
}

for (const sig of ["exit", "SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    killAllTasks();
    if (sig === "exit") return;
  });
}
