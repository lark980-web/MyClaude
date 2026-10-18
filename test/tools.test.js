import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readTool, writeTool, editTool, lsTool, globTool, grepTool, bashTool, findTool } from "../src/tools/index.js";

function tmp() {
  return mkdtempSync(join(tmpdir(), "myclaude-test-"));
}

test("Read returns numbered lines", async () => {
  const dir = tmp();
  const f = join(dir, "a.txt");
  writeFileSync(f, "one\ntwo\nthree\n");
  const r = await readTool.run({ file_path: f });
  assert.equal(r.ok, true);
  assert.match(r.content, /1\tone/);
  assert.match(r.content, /3\tthree/);
  rmSync(dir, { recursive: true, force: true });
});

test("Read honors offset and limit", async () => {
  const dir = tmp();
  const f = join(dir, "b.txt");
  writeFileSync(f, Array.from({ length: 10 }, (_, i) => `line${i + 1}`).join("\n"));
  const r = await readTool.run({ file_path: f, offset: 3, limit: 2 });
  assert.match(r.content, /3\tline3/);
  assert.match(r.content, /4\tline4/);
  assert.doesNotMatch(r.content, /5\tline5/);
  rmSync(dir, { recursive: true, force: true });
});

test("Write creates parent dirs", async () => {
  const dir = tmp();
  const f = join(dir, "nested", "deep", "c.txt");
  const r = await writeTool.run({ file_path: f, content: "hello" });
  assert.equal(r.ok, true);
  assert.equal(readFileSync(f, "utf8"), "hello");
  rmSync(dir, { recursive: true, force: true });
});

test("Edit replaces a unique string", async () => {
  const dir = tmp();
  const f = join(dir, "d.txt");
  writeFileSync(f, "alpha beta gamma");
  const r = await editTool.run({ file_path: f, old_string: "beta", new_string: "BETA" });
  assert.equal(r.ok, true);
  assert.equal(readFileSync(f, "utf8"), "alpha BETA gamma");
  rmSync(dir, { recursive: true, force: true });
});

test("Edit refuses ambiguous match", async () => {
  const dir = tmp();
  const f = join(dir, "e.txt");
  writeFileSync(f, "x x");
  const r = await editTool.run({ file_path: f, old_string: "x", new_string: "y" });
  assert.equal(r.ok, false);
  assert.match(r.content, /appears 2 times/);
  rmSync(dir, { recursive: true, force: true });
});

test("Edit replace_all replaces every occurrence", async () => {
  const dir = tmp();
  const f = join(dir, "f.txt");
  writeFileSync(f, "x x x");
  const r = await editTool.run({ file_path: f, old_string: "x", new_string: "y", replace_all: true });
  assert.equal(r.ok, true);
  assert.equal(readFileSync(f, "utf8"), "y y y");
  rmSync(dir, { recursive: true, force: true });
});

test("Edit reports missing string", async () => {
  const dir = tmp();
  const f = join(dir, "g.txt");
  writeFileSync(f, "abc");
  const r = await editTool.run({ file_path: f, old_string: "zzz", new_string: "y" });
  assert.equal(r.ok, false);
  rmSync(dir, { recursive: true, force: true });
});

test("LS lists directories with trailing slash", async () => {
  const dir = tmp();
  writeFileSync(join(dir, "file.txt"), "");
  const r = await lsTool.run({ path: dir });
  assert.equal(r.ok, true);
  assert.match(r.content, /file\.txt/);
  rmSync(dir, { recursive: true, force: true });
});

test("Glob finds nested files", async () => {
  const dir = tmp();
  writeFileSync(join(dir, "a.js"), "");
  const r = await globTool.run({ pattern: "*.js", path: dir });
  assert.equal(r.ok, true);
  assert.match(r.content, /a\.js/);
  rmSync(dir, { recursive: true, force: true });
});

test("Grep finds matching lines with line numbers", async () => {
  const dir = tmp();
  writeFileSync(join(dir, "h.js"), "const x = 1;\nconst needle = 2;\n");
  const r = await grepTool.run({ pattern: "needle", path: dir });
  assert.equal(r.ok, true);
  assert.match(r.content, /:2: const needle/);
  rmSync(dir, { recursive: true, force: true });
});

test("Grep returns empty marker when no match", async () => {
  const dir = tmp();
  writeFileSync(join(dir, "i.js"), "nothing here");
  const r = await grepTool.run({ pattern: "zzzz", path: dir });
  assert.equal(r.ok, true);
  assert.equal(r.content, "(no matches)");
  rmSync(dir, { recursive: true, force: true });
});

test("Bash captures stdout", async () => {
  const r = await bashTool.run({ command: "echo hello-from-bash" });
  assert.equal(r.ok, true);
  assert.match(r.content, /hello-from-bash/);
});

test("Bash reports non-zero exit", async () => {
  const r = await bashTool.run({ command: "exit 3" });
  assert.equal(r.ok, false);
  assert.match(r.content, /exit 3/);
});

test("findTool is case-insensitive", () => {
  assert.equal(findTool("read")?.name, "Read");
  assert.equal(findTool("BASH")?.name, "Bash");
  assert.equal(findTool("nope"), undefined);
});
