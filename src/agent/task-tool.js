import { Agent } from "./agent.js";
import { toolSchemas } from "../tools/index.js";
import { registry, TASK_TYPES } from "../tasks/registry.js";

/** Sub-agents may not delegate recursively past this depth. */
const MAX_TASK_DEPTH = 2;

const SUBAGENT_PROMPT_SUFFIX = `

# Sub-agent mode

You are a focused sub-agent invoked by a parent agent to complete one task.
- Work only on the assigned task.
- Do not ask the user questions; you cannot receive replies.
- Use tools to investigate and act.
- Finish with a concise report of what you found or changed.

${"{TASK_PROMPT}"}`;

/**
 * Run one sub-agent to completion and return its report.
 *
 * Both the foreground and the background path go through here, so the two
 * differ only in whether the caller waits.
 *
 * @returns {Promise<{ok: boolean, content: string}>}
 */
async function runSubAgent({ description, prompt, readOnly, provider, config, ui, maxTurns }) {
  const subConfig = {
    ...config,
    maxTurns,
    // A sub-agent must never block on interactive prompts. Read-only scope is
    // enforced by the tool allowlist below, not by permissionMode: "plan"
    // would reject every call before it reaches the tool.
    permissionMode: "auto",
  };

  const allowed = readOnly ? ["Read", "LS", "Glob", "Grep"] : null;

  // A sub-agent never gets the Task tool back: delegation must not recurse.
  // It still receives every other tool, or the read-only subset.
  const tools = toolSchemas().filter((t) => {
    if (t.function.name === "Task") return false;
    if (allowed && !allowed.includes(t.function.name)) return false;
    return true;
  });

  const subUi = {
    streamText: () => {},
    endStream: () => {},
    info: () => {},
    warn: () => {},
    error: (m) => ui.warn(`[sub-agent] ${m}`),
    success: () => {},
    toolStart: (n) => ui.info(`  ↳ ${description}: ${n}`),
    toolEnd: () => {},
    confirmTool: async () => !readOnly,
  };

  const agent = new Agent({ provider, config: subConfig, ui: subUi, tools });

  const systemBase = agent.systemPrompt;
  agent.systemPrompt = systemBase + SUBAGENT_PROMPT_SUFFIX.replace("{TASK_PROMPT}", prompt);

  const result = await agent.run(prompt);

  return {
    ok: !result.error,
    content: result.error
      ? `sub-agent failed: ${result.error.message}`
      : `${result.text || "(no report)"}\n\n[sub-agent turns: ${result.turns ?? "?"}]`,
  };
}

export function createTaskTool({ provider, config, ui, maxTurns = 40, depth = 0 }) {
  return {
    name: "Task",
    description:
      "Delegate a self-contained task to a sub-agent with its own context. Returns the sub-agent's final report. Use for broad searches or multi-step work that would otherwise flood the main context.",
    input_schema: {
      type: "object",
      properties: {
        description: {
          type: "string",
          description: "Short (3-5 words) label for the task",
        },
        prompt: {
          type: "string",
          description:
            "Complete, self-contained instructions. The sub-agent cannot see this conversation, so include all needed context, file paths, and what to return.",
        },
        subagent_type: {
          type: "string",
          enum: ["general", "explore"],
          description:
            "general: full tool access. explore: read-only investigation (no Write/Edit).",
        },
        run_in_background: {
          type: "boolean",
          description:
            "Start the sub-agent and return a task id right away instead of waiting. " +
            "Use it for work this turn does not need; read the result later with " +
            "TaskOutput.",
        },
      },
      required: ["description", "prompt"],
    },
    async run({ description, prompt, subagent_type = "general", run_in_background = false }) {
      // Without a cap a sub-agent can delegate to another sub-agent
      // indefinitely, each burning tokens and holding a provider slot.
      if (depth >= MAX_TASK_DEPTH) {
        return {
          ok: false,
          content: "task depth limit reached (" + MAX_TASK_DEPTH + "): do the work directly instead of delegating",
        };
      }
      const readOnly = subagent_type === "explore";

      // In the background the sub-agent keeps working while the main agent
      // moves on. The agent gets a task id and can read the result later,
      // which is what makes a long investigation affordable.
      if (run_in_background) {
        const task = registry.create({
          type: TASK_TYPES.LOCAL_AGENT,
          label: description,
          meta: { description, prompt, subagent_type, readOnly },
        });
        task.cancel = () => { task.cancelled = true; };
        // The work runs detached: an unhandled rejection here would take the
        // whole process down, so the outcome is recorded on the task.
        (async () => {
          try {
            const res = await runSubAgent({ description, prompt, readOnly, provider, config, ui, maxTurns });
            registry.appendOutput(task, res.content || "");
            if (res.ok) { registry.complete(task, res.content); }
            else { registry.fail(task, res.content); }
          } catch (e) {
            registry.fail(task, e && e.message ? e.message : String(e));
          }
        })();
        return {
          ok: true,
          content:
            `sub-agent started in the background as task ${task.id}. ` +
            `Read the result with TaskOutput(task_id: "${task.id}").`,
        };
      }

      return await runSubAgent({ description, prompt, readOnly, provider, config, ui, maxTurns });
    },
  };
}
