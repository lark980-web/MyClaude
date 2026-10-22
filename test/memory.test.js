/**
 * Project memory: where it lives and how it is appended to.
 *
 * These all run in a temporary directory. The real MYCLAUDE.md must never be
 * touched by a test.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const home = mkdtempSync(join(process.env.TEMP || ".", "mem-"));
process.env.MYCLAUDE_HOME = home;
const { memoryFilePath, appendMemory, saveMemory, loadMemory } = await import("../src/agent/permissions.js");

test("a missing memory file resolves to the working directory", () => {
  const root = mkdtempSync(join(process.env.TEMP || ".", "m1-"));
  try {
    const file = memoryFilePath(root);
    assert.equal(file, join(root, "MYCLAUDE.md"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("an existing memory file is found even from a subdirectory", () => {
  // The agent often runs below the repo root; editing must land on the real file.
  const root = mkdtempSync(join(process.env.TEMP || ".", "m2-"));
  try {
    writeFileSync(join(root, "MYCLAUDE.md"), "# 记忆\n", "utf8");
    const sub = join(root, "src", "deep");
    mkdirSync(sub, { recursive: true });
    assert.equal(memoryFilePath(sub), join(root, "MYCLAUDE.md"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("appending to a missing file creates it", () => {
  const root = mkdtempSync(join(process.env.TEMP || ".", "m3-"));
  try {
    const file = appendMemory("第一条记忆", root);
    assert.equal(readFileSync(file, "utf8").trim(), "第一条记忆");
    assert.equal(file, join(root, "MYCLAUDE.md"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("appending keeps what was already there", () => {
  // Overwriting memory from one command would silently discard prior notes.
  const root = mkdtempSync(join(process.env.TEMP || ".", "m4-"));
  try {
    appendMemory("第一条", root);
    appendMemory("第二条", root);
    const text = readFileSync(join(root, "MYCLAUDE.md"), "utf8");
    assert.match(text, /第一条/);
    assert.match(text, /第二条/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("appended memory is readable by loadMemory", () => {
  const root = mkdtempSync(join(process.env.TEMP || ".", "m5-"));
  try {
    appendMemory("要记住的事", root);
    const mem = loadMemory(root);
    assert.ok(String(mem).includes("要记住的事"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("cleanup", () => { rmSync(home, { recursive: true, force: true }); });
