import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  grepTool,
  bashTool,
  bashOutputTool,
  killShellTool,
  readTool,
  findTool,
  allRegisteredTools,
} from "../src/tools/index.js";
import {
  startBackground,
  readTaskOutput,
  killTask,
  taskSummaries,
} from "../src/tools/tasks.js";
import { EXTENDED_TOOLS } from "../src/tools/extended.js";
import { PermissionEngine, loadMemory, globToRegExp } from "../src/agent/permissions.js";
import { registerTools } from "../src/tools/index.js";

function tmp() {
  return mkdtempSync(join(tmpdir(), "myclaude-ext-test-"));
}

test("tool registry contains the extended Claude-style surface", async () => {
  const { createTaskTool } = await import("../src/agent/task-tool.js");
  const { createProvider } = await import("../src/providers/openai.js");
  const { loadConfig } = await import("../src/config.js");
  registerTools([...EXTENDED_TOOLS, createTaskTool({ provider: createProvider(loadConfig()), config: loadConfig() })]);
  const names = allRegisteredTools().map((t) => t.name);
  for (const n of ["Read", "Write", "Edit", "MultiEdit", "Bash", "BashOutput", "KillShell",
                  "Grep", "Glob", "LS", "TodoWrite", "WebFetch", "WebSearch",
                  "NotebookRead", "NotebookEdit", "AskUserQuestion", "ExitPlanMode", "Task"]) {
    assert.ok(names.includes(n), `missing tool: ${n}`);
  }
});

test("findTool resolves BashOutput and KillShell", () => {
  assert.ok(findTool("BashOutput"));
  assert.ok(findTool("KillShell"));
  assert.ok(findTool("WebSearch"));
});

test("Grep files_with_matches mode returns paths only", async () => {
  const dir = tmp();
  writeFileSync(join(dir, "hit.js"), "const needle = 1;\n");
  writeFileSync(join(dir, "miss.js"), "const other = 2;\n");
  const r = await grepTool.run({ pattern: "needle", path: dir, output_mode: "files_with_matches" });
  assert.equal(r.ok, true);
  assert.match(r.content, /hit\.js/);
  assert.doesNotMatch(r.content, /miss\.js/);
  rmSync(dir, { recursive: true, force: true });
});

test("Grep count mode reports per-file counts", async () => {
  const dir = tmp();
  writeFileSync(join(dir, "c.js"), "dup\ndup\ndup\n");
  const r = await grepTool.run({ pattern: "dup", path: dir, output_mode: "count" });
  assert.equal(r.ok, true);
  assert.match(r.content, /c\.js:3/);
  rmSync(dir, { recursive: true, force: true });
});

test("Grep -C adds context lines around matches", async () => {
  const dir = tmp();
  writeFileSync(join(dir, "ctx.txt"), "alpha\nbeta\nTARGET\ndelta\nepsilon\n");
  const r = await grepTool.run({ pattern: "TARGET", path: dir, C: 1 });
  assert.equal(r.ok, true);
  assert.match(r.content, /beta/);
  assert.match(r.content, /TARGET/);
  assert.match(r.content, /delta/);
  assert.doesNotMatch(r.content, /alpha/);
  assert.doesNotMatch(r.content, /epsilon/);
  rmSync(dir, { recursive: true, force: true });
});

test("Grep type filter narrows to matching extensions", async () => {
  const dir = tmp();
  writeFileSync(join(dir, "a.py"), "target = 1\n");
  writeFileSync(join(dir, "a.js"), "target = 2\n");
  const r = await grepTool.run({ pattern: "target", path: dir, type: "py" });
  assert.equal(r.ok, true);
  assert.match(r.content, /a\.py/);
  assert.doesNotMatch(r.content, /a\.js/);
  rmSync(dir, { recursive: true, force: true });
});

test("Grep is case-sensitive unless i is set", async () => {
  const dir = tmp();
  writeFileSync(join(dir, "s.txt"), "Needle\n");
  const noI = await grepTool.run({ pattern: "needle", path: dir });
  assert.match(noI.content, /no matches/);
  const withI = await grepTool.run({ pattern: "needle", path: dir, i: true });
  assert.match(withI.content, /Needle/);
  rmSync(dir, { recursive: true, force: true });
});

test("background Bash task runs, streams output and can be killed", async () => {
  const started = await startBackground({
    // cmd.exe has no Start-Sleep; a self-ping is the portable way to pause.
    command:
      process.platform === "win32"
        ? "echo bg-hello & ping -n 6 127.0.0.1 > nul"
        : "echo bg-hello; sleep 5",
    cwd: process.cwd(),
    timeout_ms: 20000,
  });
  assert.equal(started.ok, true);
  assert.match(started.id, /^task_/);

  // Poll instead of a fixed sleep: shell stdout buffering makes timing unreliable.
  let output = "";
  for (let i = 0; i < 20 && !/bg-hello/.test(output); i++) {
    await new Promise((r) => setTimeout(r, 400));
    const cur = await readTaskOutput(started.id, {});
    assert.equal(cur.ok, true);
    output = cur.output;
  }
  const out = await readTaskOutput(started.id, {});
  assert.equal(out.ok, true);
  assert.equal(out.status, "running");
  assert.match(out.output, /bg-hello/);

  const killed = killTask(started.id);
  assert.equal(killed.ok, true);
  await new Promise((r) => setTimeout(r, 400));
  const final = taskSummaries().find((t) => t.id === started.id);
  assert.ok(final, "task still registered");
  assert.notEqual(final.status, "running");
});

test("BashOutput rejects unknown task ids", async () => {
  const r = await bashOutputTool.run({ task_id: "task_does_not_exist" });
  assert.equal(r.ok, false);
  assert.match(r.content, /unknown task/);
});

test("Bash run_in_background returns a task id", async () => {
  const r = await bashTool.run({
    command: process.platform === "win32" ? "Start-Sleep -Seconds 3" : "sleep 3",
    run_in_background: true,
  });
  assert.equal(r.ok, true);
  const m = /task_([a-f0-9]+)/.exec(r.content);
  assert.ok(m, "expected a task id in the result");
  killTask(`task_${m[1]}`);
});

test("Bash still runs in the foreground by default", async () => {
  // echo exists in cmd.exe and /bin/sh alike; the shell is an implementation
  // detail, so the assertion must not depend on PowerShell's Write-Output.
  const r = await bashTool.run({ command: "echo fg-ok" });
  assert.equal(r.ok, true);
  assert.match(r.content, /fg-ok/);
});

test("Read rejects binary files with a NUL byte", async () => {
  const dir = tmp();
  const f = join(dir, "bin.dat");
  writeFileSync(f, Buffer.from([0x00, 0x01, 0x02, 0xff]));
  const r = await readTool.run({ file_path: f });
  assert.equal(r.ok, false);
  assert.match(r.content, /binary file/);
  rmSync(dir, { recursive: true, force: true });
});

test("Read returns a base64 image attachment", async () => {
  const dir = tmp();
  const f = join(dir, "tiny.png");
  // 1x1 transparent PNG
  writeFileSync(
    f,
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
      "base64"
    )
  );
  const r = await readTool.run({ file_path: f });
  assert.equal(r.ok, true);
  assert.ok(r.attachments?.length);
  assert.equal(r.attachments[0].type, "image");
  assert.equal(r.attachments[0].source.media_type, "image/png");
  assert.ok(r.attachments[0].source.data.length > 0);
  rmSync(dir, { recursive: true, force: true });
});

test("PermissionEngine deny wins over allow", () => {
  const p = new PermissionEngine({
    allow: ["Bash(npm run test:*)"],
    deny: ["Bash(rm -rf:*)"],
  });
  assert.equal(p.evaluate("Bash", { command: "npm run test:unit" }), "allow");
  assert.equal(p.evaluate("Bash", { command: "rm -rf /" }), "deny");
  assert.equal(p.evaluate("Bash", { command: "ls" }), null);
});

test("PermissionEngine ask beats allow", () => {
  const p = new PermissionEngine({
    allow: ["Bash(git *)"],
    ask: ["Bash(git push:*)"],
  });
  assert.equal(p.evaluate("Bash", { command: "git push origin main" }), "ask");
  assert.equal(p.evaluate("Bash", { command: "git status" }), "allow");
});

test("PermissionEngine matches file paths for Edit rules", () => {
  const p = new PermissionEngine({ allow: ["Edit(src/**)"], deny: ["Edit(src/legacy/**)"] });
  assert.equal(p.evaluate("Edit", { file_path: "src/app/main.js" }), "allow");
  assert.equal(p.evaluate("Edit", { file_path: "src/legacy/old.js" }), "deny");
  assert.equal(p.evaluate("Edit", { file_path: "README.md" }), null);
});

test("PermissionEngine empty ruleset matches nothing", () => {
  const p = new PermissionEngine({});
  assert.equal(p.isEmpty, true);
  assert.equal(p.evaluate("Bash", { command: "anything" }), null);
});

test("globToRegExp handles ** and * correctly", () => {
  assert.ok(globToRegExp("src/**").test("src/a/b/c.js"));
  assert.ok(!globToRegExp("src/*").test("src/a/b.js"));
  assert.ok(globToRegExp("*.js").test("main.js"));
  assert.ok(!globToRegExp("*.js").test("main.ts"));
});

test("loadMemory returns null when no memory file exists", () => {
  const dir = tmp();
  const mem = loadMemory(dir);
  assert.equal(mem, null);
  rmSync(dir, { recursive: true, force: true });
});

test("loadMemory reads MYCLAUDE.md from cwd", () => {
  const dir = tmp();
  writeFileSync(join(dir, "MYCLAUDE.md"), "# Project rules\nRun tests with: npm test\n");
  const mem = loadMemory(dir);
  assert.ok(mem);
  assert.match(mem, /Project rules/);
  rmSync(dir, { recursive: true, force: true });
});

test("AskUserQuestion fails cleanly without a presenter", async () => {
  const tool = EXTENDED_TOOLS.find((t) => t.name === "AskUserQuestion");
  const r = await tool.run({
    questions: [{ question: "ok?", header: "Q", options: [{ label: "A", description: "a" }] }],
  });
  assert.equal(r.ok, false);
});

test("NotebookEdit replaces a cell in an .ipynb", async () => {
  const dir = tmp();
  const f = join(dir, "nb.ipynb");
  writeFileSync(
    f,
    JSON.stringify({
      cells: [
        { cell_type: "code", id: "c1", metadata: {}, source: ["print(1)"], outputs: [], execution_count: 1 },
        { cell_type: "markdown", id: "c2", metadata: {}, source: ["# Title"] },
      ],
      metadata: {},
      nbformat: 4,
      nbformat_minor: 5,
    })
  );
  const tool = EXTENDED_TOOLS.find((t) => t.name === "NotebookEdit");
  const r = await tool.run({ notebook_path: f, cell_id: "c1", new_source: "print(42)" });
  assert.equal(r.ok, true);
  const after = JSON.parse(readFileSync(f, "utf8"));
  assert.equal(after.cells[0].source.join(""), "print(42)");
  rmSync(dir, { recursive: true, force: true });
});

test("NotebookEdit inserts and deletes cells", async () => {
  const dir = tmp();
  const f = join(dir, "nb2.ipynb");
  writeFileSync(
    f,
    JSON.stringify({ cells: [{ cell_type: "code", id: "only", metadata: {}, source: ["x"], outputs: [], execution_count: null }], metadata: {}, nbformat: 4, nbformat_minor: 5 })
  );
  const tool = EXTENDED_TOOLS.find((t) => t.name === "NotebookEdit");
  await tool.run({ notebook_path: f, cell_index: 0, new_source: "inserted", cell_type: "markdown", edit_mode: "insert" });
  let nb = JSON.parse(readFileSync(f, "utf8"));
  assert.equal(nb.cells.length, 2);
  assert.equal(nb.cells[1].source.join(""), "inserted");
  await tool.run({ notebook_path: f, cell_index: 0, new_source: "", edit_mode: "delete" });
  nb = JSON.parse(readFileSync(f, "utf8"));
  assert.equal(nb.cells.length, 1);
  rmSync(dir, { recursive: true, force: true });
});

test("NotebookRead lists cells with outputs", async () => {
  const dir = tmp();
  const f = join(dir, "nb3.ipynb");
  writeFileSync(
    f,
    JSON.stringify({
      cells: [
        { cell_type: "code", id: "a", metadata: {}, source: ["print('hi')"], outputs: [{ text: ["hi\n"] }], execution_count: 1 },
      ],
      metadata: {},
      nbformat: 4,
      nbformat_minor: 5,
    })
  );
  const tool = EXTENDED_TOOLS.find((t) => t.name === "NotebookRead");
  const r = await tool.run({ notebook_path: f });
  assert.equal(r.ok, true);
  assert.match(r.content, /print/);
  assert.match(r.content, /hi/);
  rmSync(dir, { recursive: true, force: true });
});

test("WebSearch rejects an empty query", async () => {
  const tool = EXTENDED_TOOLS.find((t) => t.name === "WebSearch");
  const r = await tool.run({ query: "   " });
  assert.equal(r.ok, false);
});

test("ExitPlanMode requires an interactive session", async () => {
  const tool = EXTENDED_TOOLS.find((t) => t.name === "ExitPlanMode");
  const r = await tool.run({ plan: "1. do thing" });
  assert.equal(r.ok, false);
  assert.match(r.content, /interactive/);
});
