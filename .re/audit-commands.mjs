/**
 * 全命令面审计：每个 /命令 用 stub ctx 真实执行一遍（隔离 HOME + SKIP_MAIN）。
 * 结果写入 _audit-result.txt（终端输出会被通知钩子清屏吃掉）。
 */
process.env.MYCLAUDE_HOME = (await import("node:fs")).mkdtempSync((await import("node:os")).tmpdir() + "/audit-cmd-");
process.env.MYCLAUDE_SKIP_MAIN = "1";
process.chdir("E:/WorkSpaces/Test09/MyClaude");

const { handleCommand } = await import("../src/main.js");
const { readFileSync } = await import("node:fs");

const src = readFileSync("./src/main.js", "utf8");
const cmds = [...src.matchAll(/case "([a-z-]+)"/g)].map((m) => m[1]);
const uniq = [...new Set(cmds)].sort();

const stubAgent = {
  messages: [], turnCount: 0, totalInputTokens: 0, totalOutputTokens: 0,
  mode: "ask", sessionKey: "audit", turnFiles: new Set(),
  setMode() {}, abort() {}, stopRequested: false,
  maybeCompact: async () => null, forgetEngineSession() {},
  checkpoints: { list: () => [] }, router: { status: () => ({}) },
  run: async () => ({ done: true, text: "stub" }),
  stats: () => ({ messages: 0, turns: 0 }),
};
const ui = { info(){}, warn(){}, error(){}, success(){}, streamText(){}, endStream(){}, toolStart(){}, toolEnd(){}, confirmTool: async () => true };
const ctx = { agent: stubAgent, config: { provider: "openai", baseUrl: "http://127.0.0.1:9/v1", apiKey: "k", model: "m", maxTurns: 2, contextWindow: 100000, permissionMode: "ask", autoRun: false, computerUse: false }, provider: {}, ui, pendingAttachments: [], autoSaver: null };

const results = { ok: [], throw: [], hang: [], exit: [] };
const trace = [];
const SKIP = new Set(["restart", "update"]); // performRestart 会 process.exit —— 单独验证
for (const cmd of uniq) {
  if (SKIP.has(cmd)) { results.ok.push(cmd + " (skipped: spawns process)"); continue; }
  const raw = "/" + cmd;
  trace.push("start " + cmd);
  try {
    const r = await Promise.race([
      handleCommand(raw, ctx),
      new Promise((_, rej) => setTimeout(() => rej(new Error("HANG>3s")), 3000)),
    ]);
    trace.push("done " + cmd);
    if (r && r.exit) { results.exit.push(cmd); } else { results.ok.push(cmd); }
  } catch (e) {
    if (String(e.message).startsWith("HANG")) { results.hang.push(cmd); }
    else { results.throw.push({ cmd, msg: String(e.message || e).slice(0, 140) }); }
  }
}

const report = [
  "total commands: " + uniq.length,
  "ok: " + results.ok.length + " -> " + results.ok.join(" "),
  "exit: " + (results.exit.join(" ") || "(none)"),
  "HANG: " + (results.hang.join(" ") || "(none)"),
  "THROW: " + results.throw.length,
  ...results.throw.map((t) => "  /" + t.cmd + ": " + t.msg),
].join("\n");
await (await import("node:fs/promises")).writeFile("E:/WorkSpaces/Test09/MyClaude/_audit-result.txt", report, "utf8");
