/**
 * A refresh must not lose the turn that is in flight.
 *
 * The browser resumes by session id on boot. The resume used to overwrite the
 * live agent with the disk copy, and auto-save is throttled - so during a run
 * the file is behind by the whole turn. On top of that the resume deleted the
 * old agent and saver, which pulled the rug out from under the running loop.
 * From the user side the task "mysteriously disappeared".
 *
 * Rules pinned here:
 *  - a live agent that is ahead of the file wins
 *  - resuming never deletes an agent that is currently running
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "myclaude-live-resume-"));
process.env.MYCLAUDE_HOME = home;
const { startGui } = await import("../src/ui/gui-server.js");
const { saveSession } = await import("../src/session.js");

async function mockBackend() {
  const state = { script: [], bodies: [], hang: false };
  const server = createServer((req, res) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      state.bodies.push(JSON.parse(data || "{}"));
      if (state.hang) {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        return;
      }
      const next = state.script.shift() || { text: "done" };
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write("data: " + JSON.stringify({ choices: [{ delta: { content: next.text } }] }) + "\n\n");
      res.write("data: " + JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] }) + "\n\n");
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { server, state, url: `http://127.0.0.1:${server.address().port}/v1` };
}

async function start() {
  const backend = await mockBackend();
  const config = {
    provider: "openai", baseUrl: backend.url, apiKey: "test",
    model: "test-model", permissionMode: "auto", maxTurns: 4,
    contextWindow: 100000, compactThreshold: 0.8, vision: true,
  };
  const { server, address } = await startGui({ config, port: 0, open: false });
  return { backend, gui: server, address, config };
}

async function stop(ctx) {
  await new Promise((r) => ctx.gui.close(r));
  await new Promise((r) => ctx.backend.server.close(r));
}

async function readSse(res) {
  const text = await res.text();
  return text.split("\n").filter((l) => l.startsWith("data:"))
    .map((l) => JSON.parse(l.slice(5).trim()));
}

test("resuming during an in-flight run keeps the live agent alive", async () => {
  const ctx = await start();
  try {
    const key = "tab-live";
    // A session file that is BEHIND: only the first exchange is on disk.
    const id = "2026-10-27T10-38-03_live01";
    saveSession(id, [
      { role: "user", content: "旧问题" },
      { role: "assistant", content: "旧回答" },
    ], { cwd: process.cwd(), model: "test-model", turnCount: 1 });

    // First turn completes normally, so the agent now holds this exchange.
    ctx.backend.state.script.push({ text: "第一个回答" });
    await readSse(await fetch(ctx.address + "/api/chat", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "第一个问题", sessionKey: key }),
    }));
    const events1 = await (await fetch(ctx.address + "/api/sessions")).json();
    const liveId = events1.sessions[0].id;

    // A second turn hangs: this is the "task is running" state.
    ctx.backend.state.hang = true;
    const pending = fetch(ctx.address + "/api/chat", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "第二个问题", sessionKey: key }),
    }).catch(() => null);
    await new Promise((r) => setTimeout(r, 300));

    // The browser refreshes and resumes the same session id.
    const resumed = await (await fetch(ctx.address + "/api/session", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "resume", id: liveId }),
    })).json();
    assert.equal(resumed.ok, true, "resume still succeeds");
    assert.ok(resumed.messages >= 2, "the live conversation is not wiped");

    // The running turn must still be abortable: the agent was not deleted.
    const abort = await (await fetch(ctx.address + "/api/abort", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionKey: key }),
    })).json();
    assert.equal(abort.aborted, true, "the in-flight agent survived the resume");
    await pending;
  } finally {
    ctx.backend.state.hang = false;
    await stop(ctx);
  }
});

test("the live agent wins when the file is behind (the refresh case)", async () => {
  const ctx = await start();
  try {
    const key = "tab-ahead";
    ctx.backend.state.script.push({ text: "答案一" }, { text: "答案二" });
    for (const q of ["问题一", "问题二"]) {
      await readSse(await fetch(ctx.address + "/api/chat", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: q, sessionKey: key }),
      }));
    }
    const list = await (await fetch(ctx.address + "/api/sessions")).json();
    // The two turns must share one session id: a new id per turn is what forked
    // the conversation and made the earlier history look lost.
    const mine = list.sessions.filter((s) => s.title === "问题一");
    assert.equal(mine.length, 1, "one conversation, not one per turn");
    const id = mine[0].id;

    // Rewind the FILE to the first exchange only: this is what a throttled
    // auto-save leaves on disk while a run is in flight.
    saveSession(id, [
      { role: "user", content: "问题一" },
      { role: "assistant", content: "答案一" },
    ], { cwd: process.cwd(), model: "test-model", turnCount: 1 });

    const resumed = await (await fetch(ctx.address + "/api/session", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "resume", id }),
    })).json();
    assert.equal(resumed.ok, true);
    assert.equal(resumed.messages, 4, "the live transcript survives, not the stale file");
    assert.equal(resumed.source, "memory", "memory was chosen over the older file");
  } finally {
    await stop(ctx);
  }
});
