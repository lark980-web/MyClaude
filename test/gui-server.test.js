/**
 * End-to-end tests for the web GUI server: config (mode/vision), attachment
 * upload, multi-part user messages, and the plan-approval round trip.
 * A tiny OpenAI-compatible SSE backend stands in for the real provider.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// Keep the user's real ~/.myclaude untouched; sessions and config land in a
// temporary home that the test process owns.
process.env.MYCLAUDE_HOME = mkdtempSync(join(tmpdir(), "myclaude-home-"));
const { startGui } = await import("../src/ui/gui-server.js");

const PNG_1PX = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
);

/** Mock backend: each request pops the next scripted response. */
async function mockBackend() {
  const state = { script: [], bodies: [] };
  const server = createServer((req, res) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      state.bodies.push(JSON.parse(data || "{}"));
      const next = state.script.shift() || { text: "done" };
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      if (next.toolCalls) {
        next.toolCalls.forEach((tc, i) => {
          res.write(
            `data: ${JSON.stringify({
              choices: [
                {
                  delta: {
                    tool_calls: [
                      { index: i, id: tc.id, function: { name: tc.name, arguments: JSON.stringify(tc.arguments) } },
                    ],
                  },
                },
              ],
            })}\n\n`
          );
        });
        res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }] })}\n\n`);
      } else {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: next.text } }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`);
      }
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { server, state, url: `http://127.0.0.1:${server.address().port}/v1` };
}

async function start(configOverrides = {}) {
  const backend = await mockBackend();
  const config = {
    provider: "openai",
    baseUrl: backend.url,
    apiKey: "test",
    model: "test-model",
    permissionMode: "ask",
    vision: true,
    maxTurns: 6,
    contextWindow: 100000,
    compactThreshold: 0.8,
    ...configOverrides,
  };
  const { server, address } = await startGui({ config, port: 0, open: false });
  return { backend, gui: server, address, config };
}

async function stop(ctx) {
  await new Promise((r) => ctx.gui.close(r));
  await new Promise((r) => ctx.backend.server.close(r));
}

const json = (r) => r.json();

async function readSse(res) {
  const text = await res.text();
  return text
    .split("\n")
    .filter((l) => l.startsWith("data:"))
    .map((l) => JSON.parse(l.slice(5).trim()));
}

test("GUI serves the page with attachment and vision controls", async () => {
  const ctx = await start();
  try {
    const html = await (await fetch(ctx.address + "/")).text();
    assert.match(html, /id="attach-list"/);
    assert.match(html, /id="btn-vision"/);
    assert.match(html, /id="file-input"/);
    assert.match(html, /dropzone/);
    // New three-pane shell: rail (chats), stream (messages), inspector (details).
    assert.match(html, /id="chat-list"/);
    assert.match(html, /id="insp-body"/);
    assert.match(html, /id="log"/);
    assert.match(html, /id="cmd"/);
    assert.match(html, /<script src="\/markdown.js"/);
    assert.match(html, /<script src="\/app.js"/);
  } finally {
    await stop(ctx);
  }
});

test("GUI serves the stylesheet, client script and markdown renderer", async () => {
  const ctx = await start();
  try {
    const css = await fetch(ctx.address + "/app.css");
    assert.equal(css.status, 200);
    assert.match(css.headers.get("content-type") || "", /text\/css/);
    const sheet = await css.text();
    // Design tokens: layered neutral surfaces and ink scale. Light is the
    // default (:root) theme, dark overrides via [data-theme="dark"].
    assert.match(sheet, /--bg:/);
    assert.match(sheet, /--panel:/);
    assert.match(sheet, /--line:/);
    assert.match(sheet, /--fg:/);
    assert.match(sheet, /data-theme="dark"/);
    assert.match(sheet, /:root/);

    const app = await fetch(ctx.address + "/app.js");
    assert.equal(app.status, 200);
    assert.match(app.headers.get("content-type") || "", /javascript/);
    assert.match(await app.text(), /streamChat/);

    const md = await fetch(ctx.address + "/markdown.js");
    assert.equal(md.status, 200);
    assert.match(await md.text(), /MyClaudeMarkdown/);
  } finally {
    await stop(ctx);
  }
});

test("the server rejects foreign Host headers", async () => {
  const ctx = await start();
  try {
    const http = await import("node:http");
    const status = await new Promise((resolve, reject) => {
      const req = http.request(
        { host: "127.0.0.1", port: new URL(ctx.address).port, path: "/api/config", headers: { Host: "evil.example" } },
        (res) => {
          res.resume();
          resolve(res.statusCode);
        }
      );
      req.on("error", reject);
      req.end();
    });
    assert.equal(status, 403);
  } finally {
    await stop(ctx);
  }
});

test("POST /api/config switches mode and vision", async () => {
  const ctx = await start();
  try {
    const res = await fetch(ctx.address + "/api/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ permissionMode: "plan", vision: false }),
    });
    const body = await json(res);
    assert.equal(body.permissionMode, "plan");
    assert.equal(body.vision, false);

    const cfg = await json(await fetch(ctx.address + "/api/config"));
    assert.equal(cfg.permissionMode, "plan");
    assert.equal(cfg.vision, false);
    assert.ok(cfg.tools.length > 10);
  } finally {
    await stop(ctx);
  }
});

test("POST /api/attach loads images and text and reports failures", async () => {
  const ctx = await start();
  const dir = mkdtempSync(join(tmpdir(), "gui-attach-"));
  try {
    const txt = join(dir, "note.md");
    writeFileSync(txt, "# hi");
    const png = join(dir, "pixel.png");
    writeFileSync(png, PNG_1PX);

    const res = await fetch(ctx.address + "/api/attach", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paths: [txt, png, join(dir, "missing.png")] }),
    });
    const body = await json(res);
    assert.equal(body.attachments.length, 2);
    assert.equal(body.attachments[0].kind, "text");
    assert.equal(body.attachments[1].kind, "image");
    assert.equal(Buffer.from(body.attachments[1].data, "base64").equals(PNG_1PX), true);
    assert.equal(body.errors.length, 1);
    assert.match(body.errors[0].name, /missing\.png/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await stop(ctx);
  }
});

test("/api/chat forwards attachments as multi-part content", async () => {
  const ctx = await start();
  try {
    ctx.backend.state.script.push({ text: "I see it" });
    const res = await fetch(ctx.address + "/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "what is this?",
        attachments: [{ kind: "image", name: "p.png", mime: "image/png", data: "AAA", size: 3 }],
      }),
    });
    const events = await readSse(res);
    assert.ok(events.some((e) => e.type === "delta" && e.text === "I see it"));
    assert.equal(events.at(-1).type, "done");

    const userMsg = ctx.backend.state.bodies.at(-1).messages.filter((m) => m.role === "user").at(-1);
    assert.ok(Array.isArray(userMsg.content));
    assert.equal(userMsg.content[0].text, "what is this?");
    assert.equal(userMsg.content[1].type, "image_url");
    assert.match(userMsg.content[1].image_url.url, /^data:image\/png;base64,AAA$/);
  } finally {
    await stop(ctx);
  }
});

test("plan mode blocks Write and reports the mode", async () => {
  const ctx = await start({ permissionMode: "plan" });
  try {
    ctx.backend.state.script.push(
      { toolCalls: [{ id: "c1", name: "Write", arguments: { file_path: "x.txt", content: "no" } }] },
      { text: "here is the plan" }
    );
    const events = await readSse(
      await fetch(ctx.address + "/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "write a file" }),
      })
    );
    assert.ok(events.some((e) => e.type === "warn" && /plan mode/.test(e.text)));
    assert.equal(events.find((e) => e.type === "mode").permissionMode, "plan");
  } finally {
    await stop(ctx);
  }
});

test("ExitPlanMode asks the browser and flips the session to ask mode", async () => {
  const ctx = await start({ permissionMode: "plan" });
  try {
    ctx.backend.state.script.push(
      { toolCalls: [{ id: "p1", name: "ExitPlanMode", arguments: { plan: "1. do the thing" } }] },
      { text: "executing now" }
    );

    const res = await fetch(ctx.address + "/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "plan it" }),
    });
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    const events = [];
    let buf = "";
    let answered = false;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line.startsWith("data:")) continue;
        const ev = JSON.parse(line.slice(5).trim());
        events.push(ev);
        if (ev.type === "question" && !answered) {
          answered = true;
          assert.match(ev.questions[0].header, /Plan approval/);
          await fetch(ctx.address + "/api/answer", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ id: ev.id, answers: ["Approve"] }),
          });
        }
      }
    }

    assert.ok(answered, "question event was emitted");
    assert.ok(events.some((e) => e.type === "success" && /已切回询问模式/.test(e.text)));
    assert.equal(events.find((e) => e.type === "mode").permissionMode, "ask");
    const cfg = await json(await fetch(ctx.address + "/api/config"));
    assert.equal(cfg.permissionMode, "ask");
  } finally {
    await stop(ctx);
  }
});

test("/api/answer with an unknown id is a no-op", async () => {
  const ctx = await start();
  try {
    const res = await fetch(ctx.address + "/api/answer", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "nope", answers: ["x"] }),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await json(res), { ok: true });
  } finally {
    await stop(ctx);
  }
});
