/**
 * Tool-layer hardening: argument guards and command-output decoding.
 *
 * Two defects from docs/session-audit-2026-11-09.md are covered here.
 *
 * N3 — a call whose JSON never parsed reached the tool as {}. Read then ran
 * stat(undefined) and answered with "ERR_INVALID_ARG_TYPE: The "path"
 * argument must be of type string ... Received undefined", which the model
 * could not act on. Every tool that resolves through findTool() must answer
 * with a message that names the field instead.
 *
 * N2 — cmd.exe on a Chinese Windows writes GBK (cp936). Decoding those bytes
 * as UTF-8 put 485 U+FFFD into a session's history. The tests below build real
 * GBK bytes on disk and assert the decoded text instead.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { findTool, allRegisteredTools, README_TOOLS } from "../src/tools/index.js";
import { parseToolArguments, repairToolJson, repairToolJsonDetailed } from "../src/providers/openai.js";

/** The tool as the agent resolves it: guard attached. */
function tool(name) {
  const t = findTool(name);
  assert.ok(t, "tool " + name + " must be registered");
  return t;
}

async function runTool(name, args) {
  return tool(name).run(args);
}

function tmp() {
  return mkdtempSync(join(tmpdir(), "myclaude-guard-"));
}

/* ------------------------------------------------------- N3 参数守卫 */

test("Read without file_path answers with a readable error, not a TypeError", async () => {
  const res = await runTool("Read", {});
  assert.equal(res.ok, false);
  assert.match(res.content, /file_path/);
  assert.match(res.content, /缺少必填参数/);
  // The old failure text named a Node internal instead of the missing field.
  assert.doesNotMatch(res.content, /ERR_INVALID_ARG_TYPE/);
});

test("Read with a non-string file_path names the field and the type", async () => {
  const res = await runTool("Read", { file_path: 42 });
  assert.equal(res.ok, false);
  assert.match(res.content, /file_path/);
  assert.match(res.content, /string/);
  assert.match(res.content, /number/);
});

test("Read with a non-numeric limit names the field", async () => {
  const res = await runTool("Read", { file_path: "x.js", limit: "many" });
  assert.equal(res.ok, false);
  assert.match(res.content, /limit/);
  assert.match(res.content, /integer|string/);
});

test("Edit without arguments names every missing field", async () => {
  const res = await runTool("Edit", {});
  assert.equal(res.ok, false);
  assert.match(res.content, /file_path/);
  assert.match(res.content, /old_string/);
  assert.match(res.content, /new_string/);
  assert.doesNotMatch(res.content, /ERR_INVALID_ARG_TYPE/);
});

test("Edit with a numeric old_string is refused before touching the file", async () => {
  const res = await runTool("Edit", { file_path: "x.js", old_string: 5, new_string: "y" });
  assert.equal(res.ok, false);
  assert.match(res.content, /old_string/);
});

test("Grep and Glob refuse an empty call rather than scanning the cwd", async () => {
  for (const name of ["Grep", "Glob"]) {
    const res = await runTool(name, {});
    assert.equal(res.ok, false, name + " must not run without a pattern");
    assert.match(res.content, /pattern/);
    assert.match(res.content, /缺少必填参数/);
  }
});

test("Bash refuses a missing or non-string command", async () => {
  const missing = await runTool("Bash", {});
  assert.equal(missing.ok, false);
  assert.match(missing.content, /command/);
  const wrongType = await runTool("Bash", { command: ["echo", "hi"] });
  assert.equal(wrongType.ok, false);
  assert.match(wrongType.content, /command/);
  assert.match(wrongType.content, /array/);
});

test("BashOutput and KillShell name task_id instead of saying unknown task: undefined", async () => {
  for (const name of ["BashOutput", "KillShell"]) {
    const res = await runTool(name, {});
    assert.equal(res.ok, false, name);
    assert.match(res.content, /task_id/);
    assert.doesNotMatch(res.content, /undefined/);
  }
});

test("MultiEdit names the missing fields with no edits array", async () => {
  const res = await runTool("MultiEdit", {});
  assert.equal(res.ok, false);
  assert.match(res.content, /file_path/);
  assert.match(res.content, /edits/);
});

test("LS and WebFetch name their failing field", async () => {
  const ls = await runTool("LS", { path: 5 });
  assert.equal(ls.ok, false);
  assert.match(ls.content, /path/);
  const wf = await runTool("WebFetch", {});
  assert.equal(wf.ok, false);
  assert.match(wf.content, /url/);
});

test("Write keeps its pre-existing readable error for unparsable arguments", async () => {
  const res = await runTool("Write", { __raw: "{bad", __parseError: true });
  assert.equal(res.ok, false);
  assert.match(res.content, /file_path|不是合法 JSON/);
});

test("arguments that fail to parse are reported with the original text", async () => {
  const truncated = '{"file_path": "E:\\WorkSpaces\\a.js", "limit": 35';
  const res = await runTool("Read", { raw: truncated });
  assert.equal(res.ok, false);
  assert.match(res.content, /不是合法 JSON/);
  assert.match(res.content, /received|收到的参数/i);
  // The model has to be able to see what it actually sent.
  assert.ok(res.content.includes("limit"), "the raw snippet must appear in the error");
});

test("array arguments are refused as a non-object argument list", async () => {
  const res = await runTool("Read", [1, 2]);
  assert.equal(res.ok, false);
  assert.match(res.content, /array|对象/);
});

test("a guarded tool never throws, whatever the arguments look like", async () => {
  const shapes = [undefined, null, {}, [], "text", 7, true, { raw: "{oops" }, { file_path: 1 }];
  for (const t of allRegisteredTools()) {
    for (const shape of shapes) {
      let res;
      try {
        res = await t.run(shape);
      } catch (e) {
        assert.fail(t.name + " threw for " + JSON.stringify(shape) + ": " + e.message);
      }
      assert.equal(typeof res, "object", t.name);
      assert.equal(typeof res.content, "string", t.name);
    }
  }
});

test("the same tool object and the registry share the guard", async () => {
  // README_TOOLS re-exports the raw objects; findTool() must return a guarded
  // view of the same tool rather than a second implementation.
  const raw = README_TOOLS.find((t) => t.name === "Read");
  assert.ok(raw);
  assert.equal(tool("Read").name, raw.name);
  const direct = await raw.run({}).catch((e) => ({ ok: false, content: "threw: " + e.message }));
  const guarded = await runTool("Read", {});
  assert.equal(guarded.ok, false);
  assert.equal(typeof guarded.content, "string");
  assert.ok(direct.content.length > 0);
});

/* ------------------------------------------------------- JSON 修复 */

test("a truncated tool-call argument string is completed and parsed", async () => {
  // A Windows path inside JSON is escaped; building it from char codes keeps
  // this test independent of any escaping in its own source.
  const esc = String.fromCharCode(92);
  const dq = String.fromCharCode(34);
  const path = "E:" + esc + esc + "WorkSpaces" + esc + esc + "app.js";
  const truncated = "{" + dq + "file_path" + dq + ": " + dq + path + dq + ", " + dq + "limit" + dq + ": 35";
  assert.throws(() => JSON.parse(truncated));
  const repaired = repairToolJson(truncated);
  assert.ok(repaired, "truncated JSON must be repairable");
  assert.equal(repaired.limit, 35);
  assert.equal(repaired.file_path, "E:" + esc + "WorkSpaces" + esc + "app.js");
  // A single unescaped backslash is not valid JSON, so nothing can be recovered;
  // the point is that this failure is reported rather than guessed at.
  const invalidEscape = "{" + dq + "file_path" + dq + ": " + dq + "E:" + esc + "WorkSpaces" + dq + "}";
  assert.equal(repairToolJsonDetailed(invalidEscape).value, null);
});

test("parseToolArguments reports failure instead of an empty object", () => {
  const bad = parseToolArguments("definitely not json");
  assert.equal(bad.ok, false);
  assert.equal(bad.value, null);
  assert.match(bad.reason, /JSON/);

  const array = parseToolArguments("[1,2,3]");
  assert.equal(array.ok, false);

  const empty = parseToolArguments("");
  assert.equal(empty.ok, true);
  assert.deepEqual(empty.value, {});

  const good = parseToolArguments('{"file_path":"a.js"}');
  assert.equal(good.ok, true);
  assert.equal(good.value.file_path, "a.js");
});

test("the repair keeps its reason when the text cannot be salvaged", () => {
  const detail = repairToolJsonDetailed("{not json");
  assert.equal(detail.value, null);
  assert.match(detail.reason, /JSON/);
});

/* ------------------------------------------------------- N2 中文输出解码 */

/** The cp936 bytes of "'x' 不是内部或外部命令" (built by hand, no encoder). */
const GBK_COMMAND_NOT_FOUND = Buffer.from([
  0xb2, 0xbb, 0xca, 0xc7, 0xc4, 0xda, 0xb2, 0xbf, 0xbb, 0xf2, 0xcd, 0xe2, 0xb2, 0xbf, 0xc3, 0xfc, 0xc1, 0xee,
]);
const GBK_TEXT = "不是内部或外部命令";
const REPLACEMENT = "\uFFFD";

function countReplacement(text) {
  return (String(text).match(/\uFFFD/g) || []).length;
}

test("GBK bytes printed by cmd.exe come back as Chinese, not U+FFFD", async () => {
  // a) cmd.exe's own message for an unknown command is cp936 on a Chinese Windows.
  const res = await runTool("Bash", { command: "nosuchcommand-task9-xyz" });
  assert.equal(res.ok, false);
  assert.equal(countReplacement(res.content), 0, "no replacement characters allowed: " + res.content);
  if (process.platform === "win32") {
    assert.match(res.content, /不是内部或外部命令/);
  }

  // b) the same bytes from a file, which no console code page can explain away.
  const dir = tmp();
  const file = join(dir, "gbk.txt");
  try {
    writeFileSync(file, GBK_COMMAND_NOT_FOUND);
    const typed = await runTool("Bash", { command: `type "${file}"` });
    assert.equal(countReplacement(typed.content), 0, "no replacement characters: " + typed.content);
    if (process.platform === "win32") {
      assert.match(typed.content, new RegExp(GBK_TEXT));
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("UTF-8 output from a program is not mangled into GBK", async () => {
  const res = await runTool("Bash", { command: 'node -e "process.stdout.write(\'中文OK\')"' });
  assert.equal(res.ok, true);
  assert.equal(countReplacement(res.content), 0);
  assert.match(res.content, /中文OK/);
});

test("multi-byte output larger than one read has no broken characters", async () => {
  // 4 CJK characters repeated 12000 times is 144000 bytes, far more than one
  // read, so characters do land on a chunk boundary.
  const command = 'node -e "process.stdout.write(String.fromCharCode(0x4E2D,0x6587,0x6D4B,0x8BD5).repeat(12000))"';
  const res = await runTool("Bash", { command });
  assert.equal(res.ok, true);
  assert.equal(countReplacement(res.content), 0, "a character split across chunks must not corrupt");
  assert.ok(res.content.length > 30000, "the persisted-output marker must be present");
  assert.match(res.content, /中文测试/);
});

test("decoding does not change plain ASCII output", async () => {
  const res = await runTool("Bash", { command: "echo task9-ascii-ok" });
  assert.equal(res.ok, true);
  assert.match(res.content, /task9-ascii-ok/);
  assert.equal(countReplacement(res.content), 0);
});

test("a command that prints UTF-8 and then a GBK error decodes both", async () => {
  const res = await runTool("Bash", { command: 'node -e "process.stdout.write(\'中文\')" && nosuchcmd-task9-abc' });
  assert.equal(res.ok, false);
  assert.equal(countReplacement(res.content), 0, "content was: " + res.content);
  assert.match(res.content, /中文/);
  if (process.platform === "win32") {
    assert.match(res.content, /不是内部或外部命令/);
  }
});

/* ------------------------------------------------------- 回归 */

test("a normal call still runs end to end", async () => {
  const dir = tmp();
  const file = join(dir, "plain.txt");
  try {
    writeFileSync(file, "one\ntwo\nthree\n");
    const read = await runTool("Read", { file_path: file, limit: 2 });
    assert.equal(read.ok, true);
    assert.match(read.content, /1\tone/);
    assert.doesNotMatch(read.content, /3\tthree/);
    const write = await runTool("Write", { file_path: join(dir, "out.txt"), content: "written" });
    assert.equal(write.ok, true);
    assert.equal(readFileSync(join(dir, "out.txt"), "utf8"), "written");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});