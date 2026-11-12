/**
 * 命令面固化校验：97 个 /命令 对**真实 Agent**（stub provider）逐个执行，
 * 无一挂死、无一抛错 —— 上次审计发现的 7 个 throw 全是手写桩缺方法，
 * 换真 Agent 后应当全绿。任何新增命令都会自动被扫进来。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.MYCLAUDE_HOME = mkdtempSync(join(tmpdir(), "myclaude-cmd-surface-"));
process.env.MYCLAUDE_SKIP_MAIN = "1";
const { handleCommand } = await import("../src/main.js");
const { Agent } = await import("../src/agent/agent.js");

const src = readFileSync(new URL("../src/main.js", import.meta.url), "utf8");
const cmds = [...new Set([...src.matchAll(/case "([a-z-]+)"/g)].map((m) => m[1]))].sort();
// performRestart 会 spawn 自身并 process.exit —— 单独由 restart.js 测试覆盖
const SKIP = new Set(["restart", "update"]);

function makeCtx() {
  const provider = {
    async streamChat() { return { text: "ok", toolCalls: [] }; },
    async complete() { return { text: "摘要足够长的占位文本，用于让摘要函数接受这次调用结果，长度超过四十个字符。" }; },
  };
  const config = { provider: "openai", baseUrl: "http://127.0.0.1:9/v1", apiKey: "k", model: "m",
    maxTurns: 2, contextWindow: 100000, permissionMode: "ask", autoRun: false, computerUse: false, vision: true };
  const ui = { info(){}, warn(){}, error(){}, success(){}, streamText(){}, endStream(){}, toolStart(){}, toolEnd(){}, confirmTool: async () => true };
  const agent = new Agent({ provider, config, ui, sessionKey: "cmd-surface" });
  return { agent, config, provider, ui, pendingAttachments: [], autoSaver: null };
}

test("每个内建命令对真实 Agent 执行：不挂死（3s）、不抛错", async () => {
  const ctx = makeCtx();
  const failures = [];
  for (const cmd of cmds) {
    if (SKIP.has(cmd)) { continue; }
    try {
      await Promise.race([
        handleCommand("/" + cmd, ctx),
        new Promise((_, rej) => setTimeout(() => rej(new Error("HANG>3s")), 3000)),
      ]);
    } catch (e) {
      failures.push(`/${cmd}: ${String(e.message || e).slice(0, 120)}`);
    }
  }
  assert.deepEqual(failures, [], `命令面有缺陷:\n${failures.join("\n")}`);
});

test("命令面覆盖 Computer Use 开关", async () => {
  const ctx = makeCtx();
  const r = await handleCommand("/computer-use on", ctx);
  assert.ok(!r.exit);
  assert.equal(ctx.config.computerUse, true, "开关写入 config");
  const off = await handleCommand("/computer-use off", ctx);
  assert.equal(ctx.config.computerUse, false, "关闭写回 false");
  assert.ok(off);
});
