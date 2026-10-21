/**
 * Read the result of a background task.
 *
 * BashOutput covers shell commands; this one covers every kind of task the
 * registry holds, so a background sub-agent can be collected the same way.
 */
import { registry, isTerminal } from "../tasks/registry.js";

export const taskOutputTool = {
  name: "TaskOutput",
  description:
    "Read the output of a background task started earlier (a sub-agent, a shell " +
    "command, or any other registered task). Returns the task status and its " +
    "output so far. Use it after a background task was started with a task id.",
  input_schema: {
    type: "object",
    properties: {
      task_id: {
        type: "string",
        description: "The id returned when the background task was started.",
      },
      wait: {
        type: "boolean",
        description:
          "Wait for the task to finish before answering. Use it when the result " +
          "is needed in this turn.",
      },
      timeout_ms: {
        type: "number",
        description: "How long to wait when wait is true. Defaults to 120000.",
      },
    },
    required: ["task_id"],
  },
  async run({ task_id, wait = false, timeout_ms = 120000 }) {
    const task = registry.get(task_id);
    if (!task) {
      return { ok: false, content: "unknown task: " + task_id };
    }
    if (wait && !isTerminal(task.status)) {
      await registry.wait(task_id, { timeout: timeout_ms });
    }
    const current = registry.get(task_id);
    const parts = [];
    parts.push("status: " + current.status);
    if (current.label) { parts.push("task: " + current.label); }
    if (current.error) { parts.push("error: " + current.error); }
    if (current.output) { parts.push(current.output); }
    else if (isTerminal(current.status) && current.status !== "failed") {
      parts.push("(no output)");
    }
    if (!isTerminal(current.status)) {
      parts.push("(still running - call again later)");
    }
    return { ok: current.status !== "failed", content: parts.join("\n") };
  },
};
