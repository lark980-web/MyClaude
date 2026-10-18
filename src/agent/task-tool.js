import { Agent } from "./agent.js";
import { toolSchemas } from "../tools/index.js";

const SUBAGENT_PROMPT_SUFFIX = `

# Sub-agent mode

You are a focused sub-agent invoked by a parent agent to complete one task.
- Work only on the assigned task.
- Do not ask the user questions; you cannot receive replies.
- Use tools to investigate and act.
- Finish with a concise report of what you found or changed.

${"{TASK_PROMPT}"}`;

export function createTaskTool({ provider, config, ui, maxTurns = 40 }) {
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
      },
      required: ["description", "prompt"],
    },
    async run({ description, prompt, subagent_type = "general" }) {
      const readOnly = subagent_type === "explore";

      const subConfig = {
        ...config,
        maxTurns,
        // A sub-agent must never block on interactive prompts. Read-only scope is
        // enforced by the tool allowlist below, not by permissionMode: "plan"
        // would reject every call before it reaches the tool.
        permissionMode: "auto",
      };

      const allowed = readOnly
        ? ["Read", "LS", "Glob", "Grep"]
        : null;

      const tools = toolSchemas().filter((t) => {
        if (readOnly && t.function.name === "Task") return false;
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
        toolStart: (n, a) => ui.info(`  ↳ ${description}: ${n}`),
        toolEnd: () => {},
        confirmTool: async () => !readOnly,
      };

      const agent = new Agent({
        provider,
        config: subConfig,
        ui: subUi,
        tools,
      });

      const systemBase = agent.systemPrompt;
      agent.systemPrompt = systemBase + SUBAGENT_PROMPT_SUFFIX.replace("{TASK_PROMPT}", prompt);

      const result = await agent.run(prompt);

      return {
        ok: !result.error,
        content: result.error
          ? `sub-agent failed: ${result.error.message}`
          : `${result.text || "(no report)"}\n\n[sub-agent turns: ${result.turns ?? "?"}]`,
      };
    },
  };
}
