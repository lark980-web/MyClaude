/**
 * Turn-scope changes must show files the agent wrote this turn — including
 * brand-new (untracked) files, which git diff HEAD skips by design.
 * Reproduces the live "no-turn-files" the nightly loop hit.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, writeFileSync, existsSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("a Write tool call this turn shows in turn scope (new file)", async () => {
  const home = mkdtempSync(join(tmpdir(), "myclaude-turn-"));
  process.env.MYCLAUDE_HOME = home;
  // 模型第一轮：调用 Write 创建新文件；第二轮：文本收尾。
  const script = [
    { toolCalls: [{ id: "w1", name: "Write", arguments: { file_path: "turn-e2e-probe.txt", content: "line1\nline2\nline3\n" } }] },
    { text: "written" },
  ];
  const backend = createServer((req, res) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      const next = script.shift() || { text: "done" };
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      if (next.toolCalls) {
        next.toolCalls.forEach((tc, i) => res.write("data: " + JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: i, id: tc.id, function: { name: tc.name, arguments: JSON.stringify(tc.arguments) } }] } }] }) + "\n\n"));
        res.write("data: " + JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }) + "\n\n");
      } else {
        res.write("data: " + JSON.stringify({ choices: [{ delta: { content: next.text } }] }) + "\n\n");
        res.write("data: " + JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] }) + "\n\n");
      }
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  await new Promise((r) => backend.listen(0, "127.0.0.1", r));
  const config = { provider: "openai", baseUrl: `http://127.0.0.1:${backend.address().port}/v1`,
    apiKey: "k", model: "m", permissionMode: "auto", maxTurns: 4,
    contextWindow: 100000, compactThreshold: 0.8, vision: true };
  const { startGui } = await import("../src/ui/gui-server.js");
  const { server, address } = await startGui({ config, port: 0, open: false, cwd: process.cwd() });
  try {
    const res = await fetch(address + "/api/chat", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "写文件", sessionKey: "turn-e2e" }),
    });
    const events = (await res.text()).split("\n").filter((l) => l.startsWith("data:")).map((l) => { try { return JSON.parse(l.slice(5).trim()); } catch { return null; } }).filter(Boolean);
    const newId = events.find((e) => e.type === "session")?.id;
    assert.ok(newId, "session event fired"); console.log("SESSION_ID=" + newId);
    assert.ok(existsSync(join(process.cwd(), "turn-e2e-probe.txt")), "model actually wrote the file");
    const chg = await (await fetch(address + "/api/changes?scope=turn&sessionKey=" + encodeURIComponent(newId))).json();
    const probe = (chg.files || []).find((f) => (f.path || "").includes("turn-e2e-probe"));
    console.log("CHG=" + JSON.stringify(chg)); console.log("NEWID=" + newId); assert.ok(probe, "turn scope lists the new file");
    assert.equal(probe.status, "A");
    assert.ok(probe.added >= 3, "line count for the new file");
  } finally {
    try { rmSync(join(process.cwd(), "turn-e2e-probe.txt"), { force: true }); } catch {}
    await new Promise((r) => server.close(r));
    await new Promise((r) => backend.close(r));
  }
});

