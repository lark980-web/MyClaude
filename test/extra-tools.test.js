import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { multiEditTool, todoWriteTool, webFetchTool, getTodos, clearTodos } from "../src/tools/index.js";
import { allRegisteredTools, registerTools, findTool } from "../src/tools/index.js";

function tmp() {
  return mkdtempSync(join(tmpdir(), "myclaude-extra-"));
}

test("MultiEdit applies several edits atomically", async () => {
  const dir = tmp();
  const f = join(dir, "a.js");
  writeFileSync(f, "const a = 1;\nconst b = 2;\nconst c = 3;\n");
  const r = await multiEditTool.run({
    file_path: f,
    edits: [
      { old_string: "const a = 1;", new_string: "const a = 10;" },
      { old_string: "const c = 3;", new_string: "const c = 30;" },
    ],
  });
  assert.equal(r.ok, true);
  const out = readFileSync(f, "utf8");
  assert.match(out, /a = 10/);
  assert.match(out, /c = 30/);
  assert.match(out, /b = 2/);
  rmSync(dir, { recursive: true, force: true });
});

test("MultiEdit writes nothing if any edit fails", async () => {
  const dir = tmp();
  const f = join(dir, "b.js");
  const original = "alpha\n";
  writeFileSync(f, original);
  const r = await multiEditTool.run({
    file_path: f,
    edits: [
      { old_string: "alpha", new_string: "ALPHA" },
      { old_string: "missing", new_string: "x" },
    ],
  });
  assert.equal(r.ok, false);
  assert.equal(readFileSync(f, "utf8"), original, "file must be unchanged");
  rmSync(dir, { recursive: true, force: true });
});

test("MultiEdit refuses ambiguous edit without replace_all", async () => {
  const dir = tmp();
  const f = join(dir, "c.js");
  writeFileSync(f, "x x\n");
  const r = await multiEditTool.run({
    file_path: f,
    edits: [{ old_string: "x", new_string: "y" }],
  });
  assert.equal(r.ok, false);
  assert.match(r.content, /appears 2 times/);
  rmSync(dir, { recursive: true, force: true });
});

test("TodoWrite replaces the whole list and reports counts", async () => {
  clearTodos("t1");
  const r1 = await todoWriteTool.run(
    {
      todos: [
        { content: "first", status: "in_progress", priority: "high" },
        { content: "second", status: "pending" },
      ],
    },
    { sessionKey: "t1" }
  );
  assert.equal(r1.ok, true);
  assert.match(r1.content, /1 in_progress/);
  assert.match(r1.content, /1 pending/);
  assert.equal(getTodos("t1").length, 2);

  const r2 = await todoWriteTool.run(
    { todos: [{ content: "only", status: "completed" }] },
    { sessionKey: "t1" }
  );
  assert.equal(r2.ok, true);
  assert.equal(getTodos("t1").length, 1, "list is replaced, not appended");
  clearTodos("t1");
});

test("TodoWrite rejects non-array input", async () => {
  const r = await todoWriteTool.run({ todos: "nope" }, {});
  assert.equal(r.ok, false);
});

test("WebFetch rejects non-http protocols", async () => {
  const r = await webFetchTool.run({ url: "file:///etc/passwd" });
  assert.equal(r.ok, false);
  assert.match(r.content, /unsupported protocol/);
});

test("WebFetch rejects malformed URLs", async () => {
  const r = await webFetchTool.run({ url: "not a url" });
  assert.equal(r.ok, false);
  assert.match(r.content, /invalid URL/);
});

test("registerTools makes tools discoverable by findTool", () => {
  registerTools([multiEditTool, todoWriteTool, webFetchTool]);
  assert.equal(findTool("multiedit")?.name, "MultiEdit");
  assert.equal(findTool("todowrite")?.name, "TodoWrite");
  assert.equal(findTool("webfetch")?.name, "WebFetch");
  const names = allRegisteredTools().map((t) => t.name);
  for (const n of ["Read", "Write", "Edit", "LS", "Glob", "Grep", "Bash", "MultiEdit", "TodoWrite", "WebFetch"]) {
    assert.ok(names.includes(n), `missing ${n}`);
  }
});
