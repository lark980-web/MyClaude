/**
 * Tests for the GUI features added in 0.3.0: per-tab sessions, abort, the file
 * browser, background-task listing and permission rules.
 *
 * MYCLAUDE_HOME points at a throw-away directory so these tests never touch the
 * user's real ~/.myclaude/config.json or session history.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOME = mkdtempSync(join(tmpdir(), "myclaude-home-"));
process.env.MYCLAUDE_HOME = HOME;
// ESM imports hoist, so the module is loaded dynamically *after* MYCLAUDE_HOME
// is in place; otherwise the config path would already be resolved.
const { startGui } = await import("../src/ui/gui-server.js");

async function mockBackend() {
  const state = { script: [], bodies: [], hang: false };
  const server = createServer((req, res) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      state.bodies.push(JSON.parse(data || "{}"));
      if (state.hang) {
        // Never answer: lets the client abort mid-flight.
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        return;
      }
      const next = state.script.shift() || { text: "done" };
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      if (next.toolCalls) {
        next.toolCalls.forEach((tc, i) => {
          res.write(
            "data: " +
              JSON.stringify({
                choices: [
                  {
                    delta: {
                      tool_calls: [
                        { index: i, id: tc.id, function: { name: tc.name, arguments: JSON.stringify(tc.arguments) } },
                      ],
                    },
                  },
                ],
              }) +
              "\n\n"
          );
        });
        res.write("data: " + JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }) + "\n\n");
      } else {
        res.write("data: " + JSON.stringify({ choices: [{ delta: { content: next.text } }] }) + "\n\n");
        res.write("data: " + JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] }) + "\n\n");
      }
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { server, state, url: "http://127.0.0.1:" + server.address().port + "/v1" };
}

async function start(configOverrides = {}, cwd) {
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
  const { server, address } = await startGui({ config, port: 0, open: false, cwd: cwd || process.cwd() });
  return { backend, gui: server, address, config };
}

async function stop(ctx) {
  await new Promise((r) => ctx.gui.close(r));
  await new Promise((r) => ctx.backend.server.close(r));
}

async function readSse(res) {
  const text = await res.text();
  return text
    .split("\n")
    .filter((l) => l.startsWith("data:"))
    .map((l) => JSON.parse(l.slice(5).trim()));
}

const chatBody = (message, extra = {}) =>
  JSON.stringify({ message, ...extra });

test("two session keys keep independent conversation histories", async () => {
  const ctx = await start();
  try {
    ctx.backend.state.script.push({ text: "reply to A" }, { text: "reply to B" });

    const a = await readSse(
      await fetch(ctx.address + "/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: chatBody("hello from A", { sessionKey: "tab-a" }),
      })
    );
    assert.ok(a.some((e) => e.type === "delta" && e.text === "reply to A"));

    const b = await readSse(
      await fetch(ctx.address + "/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: chatBody("hello from B", { sessionKey: "tab-b" }),
      })
    );
    assert.ok(b.some((e) => e.type === "delta" && e.text === "reply to B"));

    // The second request must not see the first tab's user message.
    const sentToB = ctx.backend.state.bodies.at(-1).messages.filter((m) => m.role === "user");
    assert.equal(sentToB.length, 1);
    assert.equal(sentToB[0].content, "hello from B");

    const cfgA = await (await fetch(ctx.address + "/api/config?sessionKey=tab-a")).json();
    const cfgB = await (await fetch(ctx.address + "/api/config?sessionKey=tab-b")).json();
    assert.equal(cfgA.messages, 2);
    assert.equal(cfgB.messages, 2);
  } finally {
    await stop(ctx);
  }
});

test("/api/chat reports stats, todos and the session id at the end", async () => {
  const ctx = await start();
  try {
    ctx.backend.state.script.push(
      { toolCalls: [{ id: "t1", name: "TodoWrite", arguments: { todos: [{ content: "ship it", status: "in_progress" }] } }] },
      { text: "all set" }
    );
    const events = await readSse(
      await fetch(ctx.address + "/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: chatBody("plan the work"),
      })
    );
    const todos = events.filter((e) => e.type === "todos").at(-1);
    assert.ok(todos, "todos event emitted");
    assert.equal(todos.todos[0].content, "ship it");

    const stats = events.find((e) => e.type === "stats");
    assert.ok(stats.messages >= 2);
    assert.ok(stats.turns >= 1);

    const session = events.find((e) => e.type === "session");
    assert.match(session.id, /\d{4}-\d{2}-\d{2}/);
  } finally {
    await stop(ctx);
  }
});

test("/api/abort cancels an in-flight turn and unblocks the stream", async () => {
  const ctx = await start();
  try {
    ctx.backend.state.hang = true;
    const pending = fetch(ctx.address + "/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: chatBody("this will be aborted", { sessionKey: "abort-me" }),
    });

    // Give the request time to reach the provider before aborting.
    await new Promise((r) => setTimeout(r, 120));
    const res = await fetch(ctx.address + "/api/abort", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionKey: "abort-me" }),
    });
    assert.deepEqual(await res.json(), { ok: true, aborted: true });

    const events = await readSse(await pending);
    assert.ok(events.some((e) => e.type === "info" && /interrupted/.test(e.text)));
    assert.equal(events.at(-1).type, "done");
  } finally {
    await stop(ctx);
  }
});

test("the file browser lists directories and refuses to escape the workspace", async () => {
  const root = mkdtempSync(join(tmpdir(), "gui-fs-"));
  mkdirSync(join(root, "sub"), { recursive: true });
  writeFileSync(join(root, "a.txt"), "hello");
  writeFileSync(join(root, "sub", "b.js"), "export const x = 1;\n");
  const ctx = await start({}, root);
  try {
    const listing = await (await fetch(ctx.address + "/api/fs")).json();
    assert.equal(listing.path, root);
    const names = listing.entries.map((e) => e.name);
    assert.deepEqual(names, ["sub", "a.txt"], "directories sort before files");

    const sub = await (await fetch(ctx.address + "/api/fs?path=" + encodeURIComponent(join(root, "sub")))).json();
    assert.equal(sub.entries[0].name, "b.js");
    assert.equal(sub.parent, root);

    const file = await (await fetch(ctx.address + "/api/fs/file?path=" + encodeURIComponent(join(root, "a.txt")))).json();
    assert.equal(file.content, "hello");
    assert.equal(file.binary, false);

    const outside = await fetch(ctx.address + "/api/fs?path=" + encodeURIComponent(join(root, "..")));
    assert.equal(outside.status, 403);

    const outsideFile = await fetch(ctx.address + "/api/fs/file?path=" + encodeURIComponent(join(root, "..", "x")));
    assert.equal(outsideFile.status, 403);
  } finally {
    rmSync(root, { recursive: true, force: true });
    await stop(ctx);
  }
});

test("the file browser flags binary files instead of dumping bytes", async () => {
  const root = mkdtempSync(join(tmpdir(), "gui-bin-"));
  writeFileSync(join(root, "img.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]));
  const ctx = await start({}, root);
  try {
    const file = await (await fetch(ctx.address + "/api/fs/file?path=" + encodeURIComponent(join(root, "img.png")))).json();
    assert.equal(file.binary, true);
    assert.equal(file.content, "");
    assert.ok(file.size > 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
    await stop(ctx);
  }
});

test("/api/tasks and /api/tools expose the runtime state", async () => {
  const ctx = await start();
  try {
    const tasks = await (await fetch(ctx.address + "/api/tasks")).json();
    assert.ok(Array.isArray(tasks.tasks));

    const tools = await (await fetch(ctx.address + "/api/tools")).json();
    const names = tools.tools.map((t) => t.name);
    assert.ok(names.includes("Read"));
    assert.ok(names.includes("TodoWrite"));
    assert.ok(names.includes("ExitPlanMode"));
  } finally {
    await stop(ctx);
  }
});

test("permission rules can be added and are honoured by later turns", async () => {
  const ctx = await start();
  try {
    const added = await (
      await fetch(ctx.address + "/api/permissions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ add: { allow: ["Write"] } }),
      })
    ).json();
    assert.deepEqual(added.permissions.allow, ["Write"]);

    const read = await (await fetch(ctx.address + "/api/permissions")).json();
    assert.deepEqual(read.permissions.allow, ["Write"]);

    // With Write allowed the turn must not ask for confirmation.
    ctx.backend.state.script.push(
      { toolCalls: [{ id: "w1", name: "Write", arguments: { file_path: join(tmpdir(), "gui-perm-test.txt"), content: "x" } }] },
      { text: "written" }
    );
    const events = await readSse(
      await fetch(ctx.address + "/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: chatBody("write the file"),
      })
    );
    assert.ok(!events.some((e) => e.type === "confirm"), "no confirmation was requested");
    assert.ok(events.some((e) => e.type === "tool_end" && e.ok));
  } finally {
    await stop(ctx);
  }
});

test("saved sessions can be listed, resumed and deleted", async () => {
  const ctx = await start();
  try {
    ctx.backend.state.script.push({ text: "first answer" });
    const events = await readSse(
      await fetch(ctx.address + "/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: chatBody("remember this"),
      })
    );
    const id = events.find((e) => e.type === "session").id;

    const list = await (await fetch(ctx.address + "/api/sessions")).json();
    const found = list.sessions.find((s) => s.id === id);
    assert.ok(found, "session appears in the list");
    assert.equal(found.title, "remember this");

    const resumed = await (
      await fetch(ctx.address + "/api/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "resume", id, sessionKey: "tab-resume" }),
      })
    ).json();
    assert.equal(resumed.id, id);
    assert.equal(resumed.messages, 2);

    const del = await (await fetch(ctx.address + "/api/sessions/" + encodeURIComponent(id), { method: "DELETE" })).json();
    assert.equal(del.ok, true);
    const after = await (await fetch(ctx.address + "/api/sessions")).json();
    assert.ok(!after.sessions.some((s) => s.id === id));
  } finally {
    await stop(ctx);
  }
});

test("/api/reset clears the conversation for one tab only", async () => {
  const ctx = await start();
  try {
    ctx.backend.state.script.push({ text: "one" }, { text: "two" });
    for (const key of ["keep", "drop"]) {
      await readSse(
        await fetch(ctx.address + "/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: chatBody("msg for " + key, { sessionKey: key }),
        })
      );
    }
    await fetch(ctx.address + "/api/reset", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionKey: "drop" }),
    });
    const keep = await (await fetch(ctx.address + "/api/config?sessionKey=keep")).json();
    const drop = await (await fetch(ctx.address + "/api/config?sessionKey=drop")).json();
    assert.equal(keep.messages, 2);
    assert.equal(drop.messages, 0);
  } finally {
    await stop(ctx);
  }
});

test("POST /api/config also stores baseUrl and model", async () => {
  const ctx = await start();
  try {
    const res = await (
      await fetch(ctx.address + "/api/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "another-model", baseUrl: "http://127.0.0.1:9/v1" }),
      })
    ).json();
    assert.equal(res.model, "another-model");
    const cfg = await (await fetch(ctx.address + "/api/config")).json();
    assert.equal(cfg.model, "another-model");
    assert.equal(cfg.baseUrl, "http://127.0.0.1:9/v1");
  } finally {
    await stop(ctx);
  }
});

test("sessions support rename, pin and rewind-based retry", async () => {
  const ctx = await start();
  try {
    ctx.backend.state.script.push({ text: "first answer" });
    const events = await readSse(
      await fetch(ctx.address + "/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: chatBody("original question"),
      })
    );
    const id = events.find((e) => e.type === "session").id;

    const renamed = await (
      await fetch(ctx.address + "/api/sessions/" + encodeURIComponent(id), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Renamed chat", pinned: true }),
      })
    ).json();
    assert.equal(renamed.ok, true);
    assert.equal(renamed.title, "Renamed chat");

    const list = await (await fetch(ctx.address + "/api/sessions")).json();
    const row = list.sessions.find((s) => s.id === id);
    assert.equal(row.title, "Renamed chat");
    assert.equal(row.pinned, true);
    assert.equal(list.sessions[0].id, id, "pinned chat sorts first");

    // Retry must not duplicate the previous exchange in the model context.
    ctx.backend.state.script.push({ text: "second answer" });
    await readSse(
      await fetch(ctx.address + "/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: chatBody("original question", { retry: true, sessionKey: "default" }),
      })
    );
    const sent = ctx.backend.state.bodies.at(-1).messages.filter((m) => m.role === "user");
    assert.equal(sent.length, 1, "history was rewound before retrying");
    assert.equal(sent[0].content, "original question");
  } finally {
    await stop(ctx);
  }
});

test("a session can be exported as Markdown", async () => {
  const ctx = await start();
  try {
    ctx.backend.state.script.push({ text: "Here is **the** answer." });
    const events = await readSse(
      await fetch(ctx.address + "/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: chatBody("export me"),
      })
    );
    const id = events.find((e) => e.type === "session").id;

    const out = await (await fetch(ctx.address + "/api/session/export?id=" + encodeURIComponent(id))).json();
    assert.equal(out.ok, true);
    assert.match(out.markdown, /## User/);
    assert.match(out.markdown, /export me/);
    assert.match(out.markdown, /## MyClaude/);
    assert.match(out.markdown, /Here is \*\*the\*\* answer/);

    const missing = await fetch(ctx.address + "/api/session/export?id=nope");
    assert.equal(missing.status, 404);
  } finally {
    await stop(ctx);
  }
});

test("stats report context usage so the UI can draw the ring", async () => {
  const ctx = await start();
  try {
    ctx.backend.state.script.push({ text: "ok" });
    const events = await readSse(
      await fetch(ctx.address + "/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: chatBody("hello"),
      })
    );
    const stats = events.find((e) => e.type === "stats");
    assert.ok(stats.tokens > 0, "token estimate is reported");
    assert.equal(stats.contextLimit, 80000);
    assert.ok(stats.contextUsed > 0 && stats.contextUsed < 1);
  } finally {
    await stop(ctx);
  }
});
