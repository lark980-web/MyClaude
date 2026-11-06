import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOME = mkdtempSync(join(tmpdir(), "myclaude-engine-home-"));
process.env.MYCLAUDE_HOME = HOME;

const {
  buildEngineArgs, engineEnv, engineSessionFor, rememberEngineSession, forgetEngineSession,
  runEngineTurn, summarizeEngineEvents,
} = await import("../src/engines/claude-code.js");

after(() => { try { forgetEngineSession("t1"); } catch {} });

test("the resume flag reaches the upstream CLI", () => {
  const a = buildEngineArgs({ model: "m/x", resumeSessionId: "sess-42" });
  assert.ok(a.includes("--resume"), "--resume must be present");
  assert.equal(a[a.indexOf("--resume") + 1], "sess-42");
  assert.ok(a.includes("--print") && a.includes("stream-json"));
  const b = buildEngineArgs({ model: "m/x" });
  assert.ok(!b.includes("--resume"), "no resume flag without a bound session");
});

test("engine sessions persist per MyClaude session key", () => {
  rememberEngineSession("t1", "upstream-abc");
  assert.equal(engineSessionFor("t1"), "upstream-abc");
  assert.equal(engineSessionFor("t2"), null, "another key must not see it");
  forgetEngineSession("t1");
  assert.equal(engineSessionFor("t1"), null);
});

test("the session table lives under MYCLAUDE_HOME", () => {
  rememberEngineSession("t3", "upstream-xyz");
  const p = join(HOME, "engine-sessions.json");
  assert.ok(existsSync(p), "session table must be under MYCLAUDE_HOME: " + p);
  const j = JSON.parse(readFileSync(p, "utf8"));
  assert.equal(j.t3, "upstream-xyz");
  forgetEngineSession("t3");
});

// ---- 假引擎：验证 --resume 真的进了子进程 argv，并覆盖失效降级 ----
const ORIG = { bun: process.env.MYCLAUDE_ENGINE_BUN, cli: process.env.MYCLAUDE_ENGINE_CLI };
const restore = () => {
  if (ORIG.bun === undefined) delete process.env.MYCLAUDE_ENGINE_BUN; else process.env.MYCLAUDE_ENGINE_BUN = ORIG.bun;
  if (ORIG.cli === undefined) delete process.env.MYCLAUDE_ENGINE_CLI; else process.env.MYCLAUDE_ENGINE_CLI = ORIG.cli;
};

function fakeCli(body) {
  const p = join(tmpdir(), "mc-fake-engine-" + Math.random().toString(36).slice(2) + ".mjs");
  writeFileSync(p, body, "utf8");
  return p;
}

test("the child process really receives --resume", async (t) => {
  t.after(restore);
  const cli = fakeCli([
    "const args = process.argv.slice(2);",
    "const idx = args.indexOf(\"--resume\");",
    "const out = { type: \"result\", subtype: \"success\", is_error: false, num_turns: 1, duration_ms: 10, session_id: \"fake-sess\", result: \"resumed=\" + (idx >= 0 ? args[idx + 1] : \"none\") };",
    "process.stdout.write(JSON.stringify(out) + \"\\n\");",
    "let buf = \"\"; process.stdin.on(\"data\", (c) => { buf += c; });",
    "process.stdin.on(\"end\", () => process.exit(0));",
  ].join("\n"));
  process.env.MYCLAUDE_ENGINE_BUN = process.execPath;
  process.env.MYCLAUDE_ENGINE_CLI = cli;
  const r = await runEngineTurn({ prompt: "hi", model: "m", timeoutMs: 20_000, resumeSessionId: "sess-99" });
  assert.equal(r.ok, true, JSON.stringify({ error: r.error, tail: r.stderrTail }));
  assert.equal(r.result, "resumed=sess-99", "the child must see --resume sess-99");
  assert.equal(r.resumedFrom, "sess-99");
});

test("a vanished upstream session degrades to a fresh turn", async (t) => {
  t.after(restore);
  const cli = fakeCli([
    "const args = process.argv.slice(2);",
    "if (args.includes(\"--resume\")) {",
    "  process.stderr.write(\"No conversation found with session ID: sess-gone\\n\");",
    "  process.exit(1);",
    "}",
    "const out = { type: \"result\", subtype: \"success\", is_error: false, num_turns: 1, duration_ms: 10, session_id: \"fresh-sess\", result: \"fresh\" };",
    "process.stdout.write(JSON.stringify(out) + \"\\n\");",
    "let buf = \"\"; process.stdin.on(\"data\", (c) => { buf += c; });",
    "process.stdin.on(\"end\", () => process.exit(0));",
  ].join("\n"));
  process.env.MYCLAUDE_ENGINE_BUN = process.execPath;
  process.env.MYCLAUDE_ENGINE_CLI = cli;
  const r = await runEngineTurn({ prompt: "hi", model: "m", timeoutMs: 20_000, resumeSessionId: "sess-gone" });
  assert.equal(r.ok, true, "the fallback turn must succeed");
  assert.equal(r.recoveredFromMissingResume, true, "must report the recovery");
  assert.equal(r.result, "fresh", "must fall back to a fresh turn");
});

test("an ordinary engine failure is not mistaken for a missing session", async (t) => {
  t.after(restore);
  const cli = fakeCli([
    "process.stderr.write(\"something else went wrong\\n\");",
    "process.exit(1);",
  ].join("\n"));
  process.env.MYCLAUDE_ENGINE_BUN = process.execPath;
  process.env.MYCLAUDE_ENGINE_CLI = cli;
  const r = await runEngineTurn({ prompt: "hi", model: "m", timeoutMs: 20_000, resumeSessionId: "sess-x" });
  assert.equal(r.recoveredFromMissingResume, undefined, "must not claim recovery");
  assert.equal(r.ok, false);
});

test("the summary parser still reads the real captured stream", () => {
  const lines = readFileSync(new URL("./fixtures/engine-stream.jsonl", import.meta.url), "utf8")
    .split(/\r?\n/).filter((l) => l.trim().startsWith("{"));
  const s = summarizeEngineEvents(lines);
  assert.match(String(s.sessionId), /^[0-9a-f]{8}-/);
  assert.equal(s.isError, false);
});
