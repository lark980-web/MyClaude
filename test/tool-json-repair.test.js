/**
 * Model-emitted tool arguments that are "almost JSON" must not kill a turn.
 *
 * spark-x2.6 streams real newlines inside string values; JSON.parse throws,
 * the tool ran with no arguments, and Write crashed with
 * ERR_INVALID_ARG_TYPE on an undefined path — the whole task died.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.MYCLAUDE_HOME = mkdtempSync(join(tmpdir(), "myclaude-json-"));
const { findTool } = await import("../src/tools/index.js");

/** 与 provider 内的 repairToolJson 同算法：验证行为而非实现。 */
function repair(text) {
  let out = "", inString = false, escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) { out += ch; escaped = false; continue; }
      if (ch === "\\") { out += ch; escaped = true; continue; }
      if (ch === '"') { out += ch; inString = false; continue; }
      const code = ch.charCodeAt(0);
      if (code === 10) { out += "\\n"; continue; }
      if (code === 13) { out += "\\r"; continue; }
      if (code === 9) { out += "\\t"; continue; }
      out += ch; continue;
    }
    if (ch === '"') inString = true;
    out += ch;
  }
  return JSON.parse(out);
}

test("raw newlines inside a JSON string are repaired", () => {
  const bad = '{"file_path":"a.js","content":"line1' + String.fromCharCode(10) + 'line2"}';
  assert.throws(() => JSON.parse(bad));
  const fixed = repair(bad);
  assert.equal(fixed.file_path, "a.js");
  assert.equal(fixed.content, "line1\nline2");
});

test("Write without file_path returns a clear error instead of crashing", async () => {
  const w = findTool("Write");
  const res = await w.run({ __raw: "{bad", __parseError: true });
  assert.equal(res.ok, false);
  assert.match(String(res.content), /file_path/);
  assert.match(String(res.content), /重新调用|不是合法 JSON/);
});

test("Write still works when file_path is present", async () => {
  const w = findTool("Write");
  const dir2 = mkdtempSync(join(tmpdir(), "myclaude-w-"));
  const f = join(dir2, "x.txt");
  const res = await w.run({ file_path: f, content: "ok" });
  assert.equal(res.ok, true);
  assert.equal(readFileSync(f, "utf8"), "ok");
});

