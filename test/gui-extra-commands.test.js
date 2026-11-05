/**
 * GUI built-in command coverage (iteration round 2).
 * TUI main.js has ~60 commands; the GUI used to answer 未知命令 for most.
 * EXTRA_COMMANDS is inside the app.js IIFE, so assert against source text.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const app = readFileSync(join(ROOT, "src", "ui", "web", "js", "app.js"), "utf8");
const main = readFileSync(join(ROOT, "src", "main.js"), "utf8");

const EXTRA = ["status", "stats", "context", "cost", "doctor", "title",
  "todos", "permissions", "hooks", "mcp", "effort", "models", "export"];

test("an extensible extra-command registry exists and is consulted", () => {
  assert.match(app, /var EXTRA_COMMANDS = \{/, "registry declared");
  assert.match(app, /var extra = EXTRA_COMMANDS\[cmd\]/, "default case looks it up");
  assert.match(app, /if \(extra\) \{ extra\(arg\); break; \}/, "and dispatches");
});

test("every batch-1 command is implemented and discoverable", () => {
  for (const c of EXTRA) {
    assert.ok(new RegExp("\\b" + c + ": function \\(").test(app), c + " handler missing");
    assert.ok(app.includes("{ k: \"/" + c + "\""), c + " missing from slash menu");
  }
  assert.match(app, /信息：\/status \/stats \/context \/cost \/doctor/, "advertised in /help");
});

test("batch-1 commands genuinely exist in the TUI (no invented commands)", () => {
  for (const c of EXTRA) {
    assert.ok(main.includes("case \"" + c + "\""), c + " is not a real TUI command");
  }
});
