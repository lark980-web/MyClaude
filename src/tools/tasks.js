/**
 * Background task registry: Bash(run_in_background=true) spawns a detached
 * child whose stdout/stderr stream into an owned output file. BashOutput and
 * KillShell read/stop those tasks by id.
 *
 * The state lives in the shared task registry (src/tasks/registry.js) so a
 * shell command shows up next to the other kinds of long-running work
 * instead of in a registry of its own. This module keeps the shell
 * specific parts: spawning the process and streaming its output to a file.
 */
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { registry, TASK_TYPES, TASK_STATUS, isTerminal } from "../tasks/registry.js";

/** @type {Map<string, import("node:child_process").ChildProcess>} */
const procs = new Map();
/** @type {Set<import("node:fs").WriteStream>} */
const streams = new Set();

let outputDir = null;

async function getOutputDir() {
  if (outputDir) return outputDir;
  outputDir = join(tmpdir(), "myclaude-tasks");
  await mkdir(outputDir, { recursive: true });
  return outputDir;
}

export function listTasks() {
  const list = registry.list({ type: TASK_TYPES.LOCAL_BASH });
  if (!list.length) return "(no tasks)";
  return list.map((t) => `${t.id}\t${t.status}\t${t.meta.command || ""}`).join("\n");
}

export function getTask(id) {
  const t = registry.get(id);
  return t && t.type === TASK_TYPES.LOCAL_BASH ? t : null;
}

export function taskSummaries() {
  return registry.list({ type: TASK_TYPES.LOCAL_BASH }).map((t) => ({
    id: t.id,
    command: t.meta.command || "",
    cwd: t.meta.cwd || "",
    status: t.status,
    exitCode: t.meta.exitCode ?? null,
    pid: t.meta.pid ?? null,
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

  const out = createWriteStream(outputPath, { flags: "w" });
  streams.add(out);

  // Same reasoning as the foreground Bash tool: cmd.exe starts in ~80ms while
  // powershell.exe takes seconds, and windowsVerbatimArguments keeps quotes and
  // "&" intact instead of letting the shell parse the string twice.
  const isWin = process.platform === "win32";
  const shell = isWin ? "cmd.exe" : "/bin/sh";
  const args = isWin ? ["/d", "/s", "/c", command] : ["-c", command];

  const task = registry.create({
    type: TASK_TYPES.LOCAL_BASH,
    id,
    label: command,
    meta: { command, cwd, shell, outputPath, exitCode: null, signal: null, pid: null, notifyOnExit: notify },
  });

  return new Promise((resolve) => {
    const child = spawn(shell, args, { cwd, windowsHide: true, detached: false, windowsVerbatimArguments: isWin });
    task.meta.pid = child.pid ?? null;
    procs.set(id, child);
    registry.start(task);

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

    task.cancel = () => {
      try {
        if (process.platform === "win32") {
          spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
        } else {
          child.kill("SIGTERM");
        }
      } catch {
        // The process may already be gone; the close handler settles it.
      }
    };

    child.on("error", (e) => {
      task.meta.exitCode = -1;
      out.write(`[spawn error] ${e.message}\n`);
      registry.fail(task, e.message);
      cleanup();
    });

    child.on("close", (code, signal) => {
      task.meta.exitCode = code;
      task.meta.signal = signal;
      out.write(`\n[task ${id} finished with exit code ${code ?? "?"}${signal ? ` (signal ${signal})` : ""}]\n`);
      if (signal) {
        registry.cancel(task);
      } else if (code === 0) {
        registry.complete(task, { exitCode: code });
      } else {
        registry.fail(task, `exit code ${code}`);
      }
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
        ok: task.status === TASK_STATUS.RUNNING,
        id,
        pid: task.meta.pid,
        outputPath,
        status: task.status,
      })
    );
  });
}
export function killTask(id) {
  const task = registry.get(id);
  if (!task || task.type !== TASK_TYPES.LOCAL_BASH) {
    return { ok: false, id, error: `unknown task: ${id}` };
  }
  if (isTerminal(task.status)) {
    return { ok: true, id, note: "already finished" };
  }
  // The cancel hook is what actually stops the process; the registry records
  // the outcome so a poll right afterwards already sees the final state.
  const res = registry.cancel(task);
  return { ok: res.ok, id, pid: task.meta.pid };
}

/**
 * Read a task's output. Supports tail-style offsets so the agent can poll for
 * new bytes without re-reading the whole log.
 */
export async function readTaskOutput(id, { offset = 0, limit = 60000 } = {}) {
  const task = registry.get(id);
  if (!task || task.type !== TASK_TYPES.LOCAL_BASH) {
    return { ok: false, error: `unknown task: ${id}` };
  }
  try {
    const raw = await readFile(task.meta.outputPath, "utf8");
    const slice = raw.slice(offset, offset + limit);
    const hasMore = raw.length > offset + limit;
    return {
      ok: true,
      id,
      status: task.status,
      exitCode: task.meta.exitCode,
      pid: task.meta.pid,
      command: task.meta.command,
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
  const task = registry.get(id);
  if (!task || task.type !== TASK_TYPES.LOCAL_BASH) {
    return { ok: false, error: `unknown task: ${id}` };
  }
  if (isTerminal(task.status)) {
    return { ok: true, status: task.status, exitCode: task.meta.exitCode };
  }
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
    if (isTerminal(task.status)) break;
  }
  return {
    ok: isTerminal(task.status),
    status: task.status,
    exitCode: task.meta.exitCode,
    timedOut: !isTerminal(task.status),
  };
}

export function clearFinishedTasks() {
  registry.clearFinished();
}

/** Best-effort cleanup for process exit. */
export function killAllTasks() {
  registry.cancelAll();
}

for (const sig of ["exit", "SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    killAllTasks();
    if (sig === "exit") return;
  });
}
