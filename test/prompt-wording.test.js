/**
 * Prompts and empty states must speak one language.
 *
 * The CLI once answered the same situation three different ways:
 *   "usage: /resume <id>"   and   "用法：/hooks remove <事件>"
 *   "session not found: X"  and   "not found: X"  and  "没有名为 X"
 *
 * Nothing broke; the code was valid. It just read as three different tools.
 * These tests pin the wording so it cannot drift back.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const main = readFileSync(join(ROOT, "src", "main.js"), "utf8");

test("usage prompts are written one way", () => {
  // One language and one shape, so a user learns the pattern once.
  const bad = /["'`]\s*usage\s*:/i.test(main);
  assert.equal(bad, false, "use 用法： instead of usage:");
  assert.ok(main.includes("用法："), "the Chinese form is in use");
});

test("not-found prompts are written one way", () => {
  const bad = /["'`]\s*(session\s+)?not\s+found/i.test(main);
  assert.equal(bad, false, "use 未找到会话 instead of session not found");
  assert.ok(main.includes("未找到会话："), "the Chinese form is in use");
});

test("unknown-command and unknown-mode prompts are Chinese", () => {
  assert.ok(main.includes("未知命令："), "unknown command is translated");
  assert.ok(main.includes("无效模式："), "unknown mode is translated");
  assert.equal(/unknown command/i.test(main), false, "no leftover English");
  assert.equal(/unknown mode/i.test(main), false, "no leftover English");
});

test("empty states are spelled the same way everywhere", () => {
  // "(no tasks)", "(no skills)", "(no hooks)" - the parenthesised form is the
  // convention, so a new empty state should not invent another.
  const empties = [...main.matchAll(/\((no [^)]*)\)/g)].map((m) => m[1]);
  assert.ok(empties.length >= 10, "found " + empties.length + " empty states");
  for (const e of empties) {
    // Upper case is allowed: "(no MCP servers connected)" names a protocol.
    assert.match(e, /^no [a-zA-Z][a-zA-Z. ]*$/, e + " should read (no x)");
  }
});
