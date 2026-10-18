import { Agent } from "./agent.js";
import { McpManager } from "../mcp/client.js";
import { createTaskTool } from "./task-tool.js";
import {
  registerTools,
  multiEditTool,
  todoWriteTool,
  webFetchTool,
  toolSchemas,
  findTool,
} from "../tools/index.js";
import { EXTENDED_TOOLS, setQuestionPresenter, answerQuestion } from "../tools/extended.js";

/**
 * Build an Agent wired with the extended tool set and any configured MCP servers.
 */
export async function createAgent({ provider, config, ui, providerFactory }) {
  // Register the built-in extended tools once per process.
  registerTools([multiEditTool, todoWriteTool, webFetchTool, ...EXTENDED_TOOLS]);

  const agent = new Agent({
    provider,
    config,
    ui,
    tools: toolSchemas(),
    permissions: config.permissions,
  });

  // Present AskUserQuestion through the active UI when it supports it.
  if (typeof ui?.askQuestions === "function") {
    setQuestionPresenter(ui.askQuestions);
  }

  // Sub-agent delegation needs a provider for its own Agent instance.
  if (providerFactory) {
    registerTools([
      createTaskTool({
        provider: providerFactory(),
        config,
        ui,
        // Top-level agents sit at depth 0; sub-agents are constructed without
        // Task entirely, so this value only guards direct misuse.
        depth: config.taskDepth ?? 0,
      }),
    ]);
  }

  // Connect MCP servers and expose their tools under "<server>__<tool>".
  const mcpConfig = config.mcpServers || {};
  if (Object.keys(mcpConfig).length) {
    const mcp = new McpManager();
    const results = await mcp.loadFromConfig(mcpConfig);
    for (const r of results) {
      if (r.error) ui.warn(`MCP ${r.name}: ${r.error}`);
      else ui.info(`MCP ${r.name}: ${r.tools} tool(s)${r.info?.name ? ` (${r.info.name})` : ""}`);
    }

    const bridged = mcp.allTools().map((t) => ({
      name: t.qualifiedName,
      description: `[MCP ${t.server}] ${t.description || ""}`.trim(),
      input_schema: t.input_schema,
      mcp: true,
      mcpToolName: t.qualifiedName,
    }));
    registerTools(bridged);

    agent.mcp = mcp;
    agent.mcpManager = mcp;
  }

  // Rebuild the schema list now that every tool is registered.
  agent.tools = toolSchemas();

  return agent;
}

export function closeAgent(agent) {
  try {
    agent?.mcpManager?.closeAll();
  } catch {}
}

export { findTool, answerQuestion };
