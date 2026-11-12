/**
 * GUI 全端点冒烟：真实 startGui + mock 后端，逐个打 GET 端点 + 无副作用 POST。
 * 结果写 _audit-gui.txt（终端输出会被钩子清屏吃掉）。
 */
process.env.MYCLAUDE_HOME = (await import("node:fs")).mkdtempSync((await import("node:os")).tmpdir() + "/audit-gui-");
process.chdir("E:/WorkSpaces/Test09/MyClaude");
const { startGui } = await import("../src/ui/gui-server.js");

// mock 上游后端（/v1/chat/completions 可答）
const http = await import("node:http");
const backend = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => { body += c; });
  req.on("end", () => {
    if (String(req.url).includes("/models")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "test-model" }] }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }] }));
  });
});
await new Promise((r) => backend.listen(0, "127.0.0.1", r));
const backendUrl = `http://127.0.0.1:${backend.address().port}/v1`;

const config = {
  provider: "openai", baseUrl: backendUrl, apiKey: "test", model: "test-model",
  permissionMode: "ask", vision: true, autoTitle: false, maxTurns: 4,
  contextWindow: 100000, compactThreshold: 0.8, computerUse: false,
};
const { server, address } = await startGui({ config, port: 0, open: false, cwd: process.cwd() });
const base = address;

const GETS = [
  "/", "/api/config", "/api/permissions", "/api/sessions", "/api/todos", "/api/tasks",
  "/api/tools", "/api/commands", "/api/prompts", "/api/output-styles", "/api/statusline",
  "/api/usage-stats", "/api/shares", "/api/changes", "/api/busy", "/api/hooks", "/api/mcp",
  "/api/project", "/api/fs?path=.", "/api/search?q=config",
];
const POSTS = [
  ["/api/command", { command: "/help" }],
  ["/api/abort", {}],
  ["/api/reset", { sessionKey: "smoke-a" }],
];

const lines = [];
const hit = async (path, method = "GET", body = null) => {
  try {
    const res = await fetch(base + path, {
      method,
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    return `${res.status} ${String(text).slice(0, 60).replace(/\s+/g, " ")}`;
  } catch (e) {
    return `ERR ${String(e.message || e).slice(0, 80)}`;
  }
};

for (const p of GETS) { lines.push(`GET ${p} → ${await hit(p)}`); }
for (const [p, b] of POSTS) { lines.push(`POST ${p} → ${await hit(p, "POST", b)}`); }

await new Promise((r) => server.close(r));
await new Promise((r) => backend.close(r));

const bad = lines.filter((l) => !/^GET|^POST/.test(l) || /→ (5\d\d|ERR)/.test(l));
await (await import("node:fs/promises")).writeFile(
  "E:/WorkSpaces/Test09/MyClaude/_audit-gui.txt",
  lines.join("\n") + "\n\nBAD: " + (bad.length ? "\n" + bad.join("\n") : "(none)"),
  "utf8"
);
