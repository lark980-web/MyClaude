/**
 * Iteration round 3: second GUI command batch + code-quality fixes.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const app = readFileSync(join(ROOT, "src", "ui", "web", "js", "app.js"), "utf8");
const server = readFileSync(join(ROOT, "src", "ui", "gui-server.js"), "utf8");
const main = readFileSync(join(ROOT, "src", "main.js"), "utf8");

const BATCH2 = ["memory", "skills", "plugin", "agents", "release-notes",
  "add-dir", "compact", "rewind", "fast"];

test("batch-2 commands are real TUI commands, not invented", () => {
  for (const c of BATCH2) {
    assert.ok(main.includes("case \"" + c + "\""), c + " missing from TUI");
  }
});

test("a whitelisted /api/command endpoint backs the server-side commands", () => {
  assert.match(server, /path === "\/api\/command"/, "endpoint exists");
  for (const n of ["memory", "skills", "plugin", "agents", "release-notes", "add-dir", "compact", "rewind"]) {
    assert.ok(server.includes("name === \"" + n + "\""), "missing server branch: " + n);
  }
  assert.match(server, /\.compact\(\)|maybeCompact\(\)/, "compact calls the agent");
  assert.match(server, /agent\.rewind\(/, "rewind calls the agent");
});

test("GUI wires batch-2 commands through the generic bridge", () => {
  assert.match(app, /function runServerCommand\(/, "bridge exists");
  assert.match(app, /fetch\("\/api\/command"/, "bridge posts to the endpoint");
  assert.match(app, /j\.error \|\| \("HTTP " \+ out\.status\)/, "surfaces the server error body");
  assert.match(app, /if \(j\.refresh/, "refresh re-renders after compact/rewind");
  for (const c of BATCH2) {
    const handler = (c.includes("-") ? "\"" + c + "\"" : c) + ": function (";
    assert.ok(app.includes(handler), c + " handler missing");
    assert.ok(app.includes("{ k: \"/" + c + "\""), c + " missing from slash menu");
  }
});

test("/fast is persisted through /api/config, not just local state", () => {
  assert.match(server, /body\.fastMode !== undefined/, "POST whitelist accepts fastMode");
  assert.match(server, /fastMode: !!config\.fastMode/, "GET reports fastMode");
  assert.match(app, /postJSON\("\/api\/config", \{ fastMode: on \}\)/, "GUI posts it");
});

test("code-quality fixes: no bare CR, actionable single-instance error", () => {
  assert.equal((app.match(/\r(?!\n)/g) || []).length, 0, "app.js has no bare CR line endings");
  assert.match(server, /MYCLAUDE_HOME 指向一个空目录/, "guard explains data-dir isolation");
  assert.match(server, /taskkill \/F \/IM myclaude\.exe/, "guard explains how to stop the old instance");
});
