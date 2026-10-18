/**
 * Custom slash-command tests: file discovery, front-matter, argument
 * expansion, and the GUI endpoints that expose them.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadCommands, findCommand, expandCommand, commandDirs } from "../src/commands.js";
import { startGui } from "../src/ui/gui-server.js";

function projectWithCommands(files) {
  const root = mkdtempSync(join(tmpdir(), "mc-cmd-"));
  const dir = join(root, ".myclaude", "commands");
  mkdirSync(dir, { recursive: true });
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  return root;
}

test("command files become slash commands with descriptions", () => {
  const root = projectWithCommands({
    "review.md": "---\ndescription: 审查改动\nargument-hint: [路径]\n---\n请审查 $ARGUMENTS。",
    "tidy.md": "整理格式。"
  });
  try {
    const cmds = loadCommands(root);
    assert.deepEqual(cmds.map((c) => c.name), ["review", "tidy"]);
    assert.equal(cmds[0].description, "审查改动");
    assert.equal(cmds[0].argumentHint, "[路径]");
    // No front matter: the first prose line becomes the description.
    assert.equal(cmds[1].description, "整理格式。");
    assert.equal(cmds[1].scope, "project");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("$ARGUMENTS, positional args and the append fallback all expand", () => {
  const root = projectWithCommands({
    "a.md": "x $ARGUMENTS y",
    "b.md": "first $1 second $2",
    "c.md": "plain body"
  });
  try {
    assert.equal(expandCommand(findCommand("a", root), "hello world"), "x hello world y");
    assert.equal(expandCommand(findCommand("b", root), "one two"), "first one second two");
    // A template without placeholders still receives what the user typed.
    assert.equal(expandCommand(findCommand("c", root), "extra"), "plain body\n\nextra");
    assert.equal(expandCommand(findCommand("c", root), ""), "plain body");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("lookup is case-insensitive and unknown names return null", () => {
  const root = projectWithCommands({ "deploy.md": "go" });
  try {
    assert.ok(findCommand("DEPLOY", root));
    assert.equal(findCommand("nope", root), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("non-markdown files are ignored", () => {
  const root = projectWithCommands({ "notes.txt": "not a command" });
  try {
    assert.equal(loadCommands(root).length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("commandDirs stops climbing at the repository root", () => {
  const root = projectWithCommands({ "x.md": "y" });
  mkdirSync(join(root, ".git"), { recursive: true });
  try {
    const nested = join(root, "src", "deep");
    mkdirSync(nested, { recursive: true });
    const dirs = commandDirs(nested);
    assert.equal(dirs.length >= 1, true);
    assert.ok(dirs.some((d) => d.dir === join(root, ".myclaude", "commands")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ GUI API */

async function mockBackend() {
  const server = createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write("data: " + JSON.stringify({ choices: [{ delta: { content: "ok" } }] }) + "\n\n");
    res.write("data: " + JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] }) + "\n\n");
    res.write("data: [DONE]\n\n");
    res.end();
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { server, url: "http://127.0.0.1:" + server.address().port + "/v1" };
}

test("GET /api/commands lists project commands", async () => {
  const root = projectWithCommands({ "review.md": "---\ndescription: 审查\n---\n看 $ARGUMENTS" });
  const backend = await mockBackend();
  const { server, address } = await startGui({
    config: { provider: "openai", baseUrl: backend.url, apiKey: "k", model: "m", permissionMode: "ask", vision: true, maxTurns: 4, contextWindow: 100000, compactThreshold: 0.8 },
    port: 0, open: false, cwd: root
  });
  try {
    const j = await (await fetch(address + "/api/commands")).json();
    assert.equal(j.commands.length, 1);
    assert.equal(j.commands[0].name, "review");
    assert.equal(j.commands[0].description, "审查");
    assert.equal(j.commands[0].scope, "project");
  } finally {
    await new Promise((r) => server.close(r));
    await new Promise((r) => backend.server.close(r));
    rmSync(root, { recursive: true, force: true });
  }
});

test("POST /api/commands/run expands arguments server-side", async () => {
  const root = projectWithCommands({ "review.md": "检查 $ARGUMENTS 的错误" });
  const backend = await mockBackend();
  const { server, address } = await startGui({
    config: { provider: "openai", baseUrl: backend.url, apiKey: "k", model: "m", permissionMode: "ask", vision: true, maxTurns: 4, contextWindow: 100000, compactThreshold: 0.8 },
    port: 0, open: false, cwd: root
  });
  try {
    const j = await (await fetch(address + "/api/commands/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "review", args: "src/ui" })
    })).json();
    assert.equal(j.ok, true);
    assert.equal(j.prompt, "检查 src/ui 的错误");

    const missing = await fetch(address + "/api/commands/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "ghost" })
    });
    assert.equal(missing.status, 404);
  } finally {
    await new Promise((r) => server.close(r));
    await new Promise((r) => backend.server.close(r));
    rmSync(root, { recursive: true, force: true });
  }
});
