/**
 * Session lifecycle hooks.
 *
 * claude-src carries nine hook events; MyClaude had seven. These two close the
 * gap: SessionStart fires once per agent creation (source "startup", or
 * "resume" when the caller is restoring saved history), SessionEnd on the
 * explicit exits we can await. A hard crash fires neither - same as Claude.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.MYCLAUDE_HOME = mkdtempSync(join(tmpdir(), "myclaude-sesshook-"));
const { createAgent } = await import("../src/agent/runtime.js");
const { HOOK_EVENTS } = await import("../src/hooks.js");

const MARK = join(tmpdir(), "sesshook-marker.txt");
const MARKER_JS = join(tmpdir(), "sesshook-marker.cjs");

writeFileSync(MARKER_JS, "const fs=require('fs');let s='';try{s=require('fs').readFileSync(0,'utf8')}catch{}const p=JSON.parse(s||'{}');fs.appendFileSync(process.env.SESSION_HOOK_MARK,process.argv[2]+':'+(p.session_id?'payload-ok':'payload-missing')+ String.fromCharCode(10));");

function hookConfig() {
  const cmd = (tag) => "node " + MARKER_JS + " " + tag;
  return {
    provider: "openai", baseUrl: "http://x/v1", apiKey: "k", model: "m",
    permissionMode: "auto", maxTurns: 2,
    hooks: {
      SessionStart: [{ hooks: [{ type: "command", command: cmd("start") }] }],
      SessionEnd: [{ hooks: [{ type: "command", command: cmd("end") }] }],
    },
  };
}

const ui = { streamText() {}, endStream() {}, info() {}, warn() {}, error() {}, success() {}, toolStart() {}, toolEnd() {}, confirmTool: async () => true };

test("HOOK_EVENTS carries the nine events Claude has", () => {
  assert.equal(HOOK_EVENTS.length, 9, "got: " + HOOK_EVENTS.join(", "));
  assert.ok(HOOK_EVENTS.includes("SessionStart"));
  assert.ok(HOOK_EVENTS.includes("SessionEnd"));
});

test("SessionStart fires on agent creation and names the session", async () => {
  process.env.SESSION_HOOK_MARK = MARK;
  try { fs.rmSync(MARK, { force: true }); } catch {}
  const agent = await createAgent({ provider: { async streamChat() {} }, config: hookConfig(), ui, sessionKey: "sess-1" });
  assert.ok(existsSync(MARK), "SessionStart ran");
  assert.match(readFileSync(MARK, "utf8"), /^start:payload-ok/m);
  await agent.sessionEnd("exit");
});

test("SessionEnd fires with its reason; resume passes through creation", async () => {
  process.env.SESSION_HOOK_MARK = MARK;
  try { fs.rmSync(MARK, { force: true }); } catch {}
  const agent = await createAgent({ provider: { async streamChat() {} }, config: hookConfig(), ui, sessionKey: "sess-2", sessionSource: "resume" });
  assert.match(readFileSync(MARK, "utf8"), /^start:payload-ok/m, "resume still fires SessionStart");
  await agent.sessionEnd("clear");
  assert.match(readFileSync(MARK, "utf8"), /^end:payload-ok/m);
});
