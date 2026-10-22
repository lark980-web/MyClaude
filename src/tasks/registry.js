/**
 * The task registry: one place that knows about every long-running job.
 *
 * MyClaude started with a single kind of background job, a detached shell
 * command. Claude Code models the same idea as a set of task types, and the
 * registry is what makes them interchangeable: the agent starts a task, gets
 * an id, and then polls or waits on that id regardless of what the task
 * actually is.
 *
 * The types MyClaude implements:
 *
 *   local_bash   a detached shell command
 *   local_agent  a sub-agent working in its own context
 *   mcp_task     a call into an MCP server
 *   monitor_mcp  a long-lived MCP connection watched for events
 *   monitor_ws   a WebSocket watched for events
 *   workflow     several steps run in order
 *
 * Every task shares the same lifecycle and the same output buffer, so the
 * tools that read results do not need to know the type.
 */

/** The buffer cap for one task, in characters. */
const MAX_TASK_OUTPUT = 200000;

/** The kinds of task the registry can hold. */
export const TASK_TYPES = Object.freeze({
  LOCAL_BASH: "local_bash",
  LOCAL_AGENT: "local_agent",
  MCP_TASK: "mcp_task",
  MONITOR_MCP: "monitor_mcp",
  MONITOR_WS: "monitor_ws",
  WORKFLOW: "workflow",
  DREAM: "dream",
});

/** Every type the registry understands, in the order they are reported. */
export const TASK_TYPE_LIST = Object.freeze(Object.values(TASK_TYPES));

/**
 * Task lifecycle.
 *
 * A task starts as pending, moves to running once it is really doing work,
 * and ends in one of the three terminal states. A cancelled task is not a
 * failed one: the user asked for it, so it is reported differently.
 */
export const TASK_STATUS = Object.freeze({
  PENDING: "pending",
  RUNNING: "running",
  COMPLETED: "completed",
  FAILED: "failed",
  CANCELLED: "cancelled",
});

/** True for a status that will never change again. */
export function isTerminal(status) {
  return status === TASK_STATUS.COMPLETED || status === TASK_STATUS.FAILED || status === TASK_STATUS.CANCELLED;
}

/** True when a status means the task is still doing something. */
export function isActive(status) {
  return status === TASK_STATUS.PENDING || status === TASK_STATUS.RUNNING;
}

/**
 * One registered task.
 *
 * @typedef {{
 *   id: string,
 *   type: string,
 *   status: string,
 *   label: string,
 *   createdAt: number,
 *   startedAt: number|null,
 *   finishedAt: number|null,
 *   output: string,
 *   error: string|null,
 *   result: any,
 *   meta: Record<string, any>,
 *   cancel: Function|null,
 * }} Task
 */

export class TaskRegistry {
  constructor() {
    /** @type {Map<string, Task>} */
    this.tasks = new Map();
    /** @type {Set<Function>} */
    this.listeners = new Set();
    /** @type {Map<string, number>} */
    this._seq = new Map();
  }

  /**
   * Subscribe to task events.
   *
   * @param {(event: {type: string, task: Task}) => void} fn
   * @returns {() => void} an unsubscribe function
   */
  on(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  #emit(type, task) {
    for (const fn of [...this.listeners]) {
      try {
        fn({ type, task });
      } catch {
        // A broken listener must not stop the others from being told.
      }
    }
  }

  /**
   * Register a new task.
   *
   * @param {{type: string, label?: string, meta?: object, id?: string}} spec
   * @returns {Task}
   */
  create(spec) {
    const type = spec.type;
    if (!TASK_TYPE_LIST.includes(type)) {
      throw new Error(`unknown task type: ${type}`);
    }
    // Ids are per type so the agent can tell them apart at a glance, and
    // a counter keeps them unique within a type.
    const n = (this._seq.get(type) || 0) + 1;
    this._seq.set(type, n);
    const id = spec.id || `${type}_${n}`;
    /** @type {Task} */
    const task = {
      id,
      type,
      status: TASK_STATUS.PENDING,
      label: spec.label || "",
      createdAt: Date.now(),
      startedAt: null,
      finishedAt: null,
      output: "",
      error: null,
      result: null,
      meta: spec.meta || {},
      cancel: null,
    };
    this.tasks.set(id, task);
    this.#emit("created", task);
    return task;
  }
  /** Move a task into the running state. */
  start(task) {
    if (task.status !== TASK_STATUS.PENDING) { return task; }
    task.status = TASK_STATUS.RUNNING;
    task.startedAt = Date.now();
    this.#emit("started", task);
    return task;
  }

  /**
   * Append output to a task.
   *
   * The buffer is capped: a task that logs in a loop would otherwise grow
   * without bound and take the session down with it. The oldest text goes
   * first, because the end of a log is what matters.
   */
  appendOutput(task, text) {
    if (!text) { return task; }
    task.output += String(text);
    if (task.output.length > MAX_TASK_OUTPUT) {
      task.output = task.output.slice(task.output.length - MAX_TASK_OUTPUT);
    }
    this.#emit("output", task);
    return task;
  }

  /** Finish a task successfully. */
  complete(task, result = null) {
    if (isTerminal(task.status)) { return task; }
    task.status = TASK_STATUS.COMPLETED;
    task.finishedAt = Date.now();
    task.result = result;
    this.#emit("completed", task);
    return task;
  }

  /** Finish a task with an error. */
  fail(task, error) {
    if (isTerminal(task.status)) { return task; }
    task.status = TASK_STATUS.FAILED;
    task.finishedAt = Date.now();
    task.error = error instanceof Error ? error.message : String(error ?? "unknown error");
    this.#emit("failed", task);
    return task;
  }

  /**
   * Cancel a task.
   *
   * The task's own cancel hook does the real work; this only records that
   * the cancellation was requested and happened.
   */
  cancel(task) {
    if (isTerminal(task.status)) { return { ok: true, id: task.id, note: "already finished" }; }
    try {
      if (typeof task.cancel === "function") { task.cancel(); }
    } catch (e) {
      this.fail(task, e);
      return { ok: false, id: task.id, error: e.message };
    }
    task.status = TASK_STATUS.CANCELLED;
    task.finishedAt = Date.now();
    this.#emit("cancelled", task);
    return { ok: true, id: task.id };
  }

  /** @returns {Task|null} */
  get(id) {
    return this.tasks.get(id) || null;
  }

  /**
   * Every task, newest first.
   *
   * @param {{type?: string, status?: string}} [filter]
   * @returns {Task[]}
   */
  list(filter = {}) {
    let out = [...this.tasks.values()];
    if (filter.type) { out = out.filter((t) => t.type === filter.type); }
    if (filter.status) { out = out.filter((t) => t.status === filter.status); }
    return out.sort((a, b) => b.createdAt - a.createdAt);
  }

  /**
   * Wait for a task to reach a terminal state.
   *
   * @param {string} id
   * @param {{timeout?: number, pollMs?: number}} [opts]
   * @returns {Promise<Task|null>}
   */
  async wait(id, opts = {}) {
    const timeout = opts.timeout ?? 120000;
    const pollMs = opts.pollMs ?? 100;
    const deadline = Date.now() + timeout;
    for (;;) {
      const task = this.get(id);
      if (!task) { return null; }
      if (isTerminal(task.status)) { return task; }
      if (Date.now() > deadline) { return task; }
      await new Promise((r) => setTimeout(r, pollMs));
    }
  }

  /** Forget every finished task. */
  clearFinished() {
    for (const [id, t] of this.tasks) {
      if (isTerminal(t.status)) { this.tasks.delete(id); }
    }
  }

  /** Cancel everything that is still running. */
  cancelAll() {
    for (const t of this.tasks.values()) {
      if (isActive(t.status)) { this.cancel(t); }
    }
  }
}

/** The registry the tools share. */
export const registry = new TaskRegistry();
