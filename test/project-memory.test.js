/**
 * The project memory decides how work is done, so the part that governs that
 * has to reach the model intact and in the right place.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { loadMemory } from "../src/agent/permissions.js";

const scratch = () => mkdtempSync(join(process.env.TEMP || ".", "mem-"));

test("the memory file is found from the working directory", () => {
  const root = scratch();
  try {
    writeFileSync(join(root, "MYCLAUDE.md"), "# project\n\nSome notes.\n", "utf8");
    const mem = loadMemory(root);
    assert.ok(mem, "the memory was loaded");
    assert.match(mem, /Some notes/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a project without a memory file has none", () => {
  const root = scratch();
  try {
    assert.equal(loadMemory(root), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("this project states the rule that claude-src is the reference", () => {
  // The rule is the point of the project, so it must survive any edit to the
  // memory file. A missing heading means the core rules are no longer
  // lifted to the front of the system prompt.
  const mem = loadMemory(process.cwd());
  assert.ok(mem, "the project has a memory file");
  assert.match(mem, /## 核心要义/);
  assert.match(mem, /claude-src/);
});
