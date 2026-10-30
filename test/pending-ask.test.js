/**
 * A refresh must not destroy a task that is only waiting for the user.
 *
 * The question dialog lived in the page that owned one SSE stream: reload the
 * tab and the card vanished while the agent stayed blocked on it, so the task
 * was neither alive nor resumable. The pending prompt is now reported by the
 * resume response and the answer can arrive from the new page.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("pending question survives a refresh and can be answered from the new page", async () => {
  process.env.MYCLAUDE_HOME = mkdtempSync(join(tmpdir(), "myclaude-pask-"));
  const { startGui } = await import("../src/ui/gui-server.js");
  const QUESTIONS = [{ question: "选一个颜色", header: "颜色", options: [{ label: "红" }, { label: "蓝" }] }];
  let phase = 0;
  const backend = createServer((req, res) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      phase++;
      if (phase === 1) {
        const tc = { index: 0, id: "q1", function: { name: "AskUserQuestion", arguments: JSON.stringify({ questions: QUESTIONS }) } };
        res.write("data: " + JSON.stringify({ choices: [{ delta: { tool_calls: [tc] } }] }) + "\n\n");
        res.write("data: " + JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }) + "\n\n");
        // stay open: the tool result turn is a second request
      } else {
        res.write("data: " + JSON.stringify({ choices: [{ delta: { content: "选了红色" } }] }) + "\n\n");
        res.write("data: " + JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] }) + "\n\n");
      }
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  await new Promise((r) => backend.listen(0, "127.0.0.1", r));
  const config = { provider: "openai", baseUrl: `http://127.0.0.1:${backend.address().port}/v1`,
    apiKey: "k", model: "m", permissionMode: "auto", maxTurns: 5,
    contextWindow: 100000, compactThreshold: 0.8, vision: true };
  const { server, address } = await startGui({ config, port: 0, open: false });
  try {
    // 1) 发起任务；它卡在 AskUserQuestion 上
    const ctrl = new AbortController();
    const hanging = fetch(address + "/api/chat", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "挑个颜色", sessionKey: "asktest" }), signal: ctrl.signal,
    }).catch(() => null);
    await new Promise((r) => setTimeout(r, 800));
    // 2) 刷新 = 客户端消失
    ctrl.abort();
    await hanging;
    await new Promise((r) => setTimeout(r, 3200)); // 让运行中刷盘落盘
    // 3) 新页面按会话恢复：应带回待答问题
    const list = await (await fetch(address + "/api/sessions")).json();
    assert.ok(list.sessions.length, "the hung turn still persisted a session");
    const id = list.sessions[0].id;
    const resumed = await (await fetch(address + "/api/session", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "resume", id, sessionKey: "asktest" }),
    })).json();
    assert.ok(resumed.ok, "resume ok");
    assert.ok(resumed.pending && resumed.pending.question, "resume reports the pending question");
    assert.equal(resumed.pending.question.questions[0].question, "选一个颜色");
    // 4) 新页面回答 → 任务继续并结束
    const ans = await (await fetch(address + "/api/answer", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: resumed.pending.question.id, answers: ["红"] }),
    })).json();
    assert.ok(ans.ok);
    await new Promise((r) => setTimeout(r, 2500));
    const after = await (await fetch(address + "/api/session", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "resume", id, sessionKey: "asktest" }),
    })).json();
    assert.ok(!after.pending, "the prompt is cleared once answered");
    const text = JSON.stringify(after.transcript);
    assert.match(text, /选了红色|红/, "the run continued after the answer");
    const busy = await (await fetch(address + "/api/busy?sessionKey=" + encodeURIComponent(id))).json();
    assert.equal(busy.busy, false, "the session is free again");
  } finally {
    await new Promise((r) => server.close(r));
    await new Promise((r) => backend.close(r));
  }
});

