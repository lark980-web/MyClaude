/**
 * The /mcp command has three branches. A block that gets cut in half by a
 * later edit still parses, so the guard is on the shape of the source, not
 * on a runtime error.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../src/main.js", import.meta.url), "utf8");

/** The text of the case "mcp" block, up to the next case. */
function mcpBlock() {
  const start = source.indexOf('case "mcp": {');
  assert.ok(start > 0, "the /mcp case exists");
  const rest = source.slice(start);
  const next = rest.search(/^ {4}case "/m);
  return next > 0 ? rest.slice(0, next) : rest;
}

test("the /mcp block keeps all three branches", () => {
  const block = mcpBlock();
  assert.match(block, /rest\[0\] === "login"/, "the login branch exists");
  assert.match(block, /rest\[0\] === "logout"/, "the logout branch exists");
  assert.match(block, /mcpManager\?\.status\?\.\(\)/, "the status listing exists");
});

test("the login branch closes before the logout branch starts", () => {
  const block = mcpBlock();
  const login = block.indexOf('rest[0] === "login"');
  const logout = block.indexOf('rest[0] === "logout"');
  const status = block.indexOf("mcpManager?.status?.()");
  assert.ok(login >= 0 && logout > login, "login comes first");
  assert.ok(status > logout, "the status listing comes after both branches");
});

test("every branch returns instead of falling through", () => {
  const block = mcpBlock();
  // Three explicit exits: after login, after logout, and at the end.
  const returns = (block.match(/return \{\};/g) || []).length;
  assert.ok(returns >= 3, `expected at least three returns, found ${returns}`);
});

test("braces in the /mcp block are balanced", () => {
  const block = mcpBlock();
  // Braces inside strings would confuse a naive count, so the strings that
  // carry braces are checked for first.
  const stripped = block.replace(/"[^"\n]*"/g, '""').replace(/`[^`]*`/g, "``");
  const open = (stripped.match(/\{/g) || []).length;
  const close = (stripped.match(/\}/g) || []).length;
  assert.equal(open, close, "the block opens and closes the same number of braces");
});
