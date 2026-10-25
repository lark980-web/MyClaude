/**
 * Bridge MCP resources into model-callable tools.
 *
 * The manager could always list and read resources; Claude exposes that as
 * the ListMcpResources and ReadMcpResource tools and MyClaude did not, so a
 * model had no way to discover what documents a server offers on its own.
 *
 * Resource identity is the qualified form the manager already understands
 * ("<server>__<name>" or a bare uri), so the tools never have to guess which
 * server owns what.
 */

/**
 * @param {object} mcp the McpManager instance
 * @returns {Array} two tool definitions
 */
export function createResourceTools(mcp) {
  const listTool = {
    name: "ListMcpResources",
    description: "List resources exposed by connected MCP servers, optionally filtered by server name.",
    input_schema: {
      type: "object",
      properties: {
        server: { type: "string", description: "Only list resources of this server" },
      },
    },
    async run({ server }) {
      let out = [];
      try { out = mcp.allResources() || []; } catch { out = []; }
      if (server) { out = out.filter((r) => r.server === server); }
      if (!out.length) { return { ok: true, content: "(no resources)" }; }
      const lines = out.map((r) =>
        `${r.uri}  [${r.server}]  ${r.name || "(unnamed)"}${r.description ? " - " + r.description : ""}`);
      return { ok: true, content: lines.join("\n") };
    },
  };

  const readTool = {
    name: "ReadMcpResource",
    description: "Read one MCP resource by its uri (or qualified name). Use ListMcpResources to discover them.",
    input_schema: {
      type: "object",
      properties: {
        uri: { type: "string", description: "The resource uri, as listed by ListMcpResources" },
      },
      required: ["uri"],
    },
    async run({ uri }) {
      if (!uri) { return { ok: false, content: "uri is required" }; }
      const res = await mcp.readResourceBy(String(uri));
      return res && res.ok ? { ok: true, content: String(res.content ?? "") } : { ok: false, content: String((res && res.content) || "read failed") };
    },
  };

  return [listTool, readTool];
}
