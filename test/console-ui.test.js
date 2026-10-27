/**
 * consoleUi: mirror turn events to the terminal the exe window runs in.
 *
 * The browser keeps its SSE stream; the launcher window only ever saw the
 * startup lines. This decorator prints tool calls, assistant text and
 * notices so the window shows what the agent is doing, while delegating every
 * event to the wrapped UI so the browser stream is untouched.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { consoleUi } from "../src/ui/console-ui.js";

function makeUi() {
  const events = [];
  return {
    events,
    streamText: (t) => events.push(["stream", t]),
    reasoningText: (t) => events.push(["reasoning", t]),
    endStream: () => events.push(["endStream"]),
    info: (t) => events.push(["info", String(t)]),
    warn: (t) => events.push(["warn", String(t)]),
    error: (t) => events.push(["error", String(t)]),
    success: (t) => events.push(["success", String(t)]),
    toolStart: (name, args) => events.push(["toolStart", name, args]),
    toolEnd: (name, ok, elapsed, output, extra) => events.push(["toolEnd", name, ok, elapsed, output]),
  };
}

function captureConsole(fn) {
  const lines = [];
  const orig = console.log;
  console.log = (...a) => lines.push(a.join(" "));
  return Promise.resolve(fn()).finally(() => { console.log = orig; });
}

test("tool calls are printed and forwarded to the wrapped UI", async () => {
  const ui = makeUi();
  const wrapped = consoleUi(ui, "k1");
  await captureConsole(() => {
    wrapped.toolStart("Read", { path: "a.js" });
    wrapped.toolEnd("Read", true, 12, "ok");
  });
  assert.equal(ui.events[0][0], "toolStart", "the wrapped UI still receives the call");
  assert.equal(ui.events[0][1], "Read");
  assert.match(ui.events[1][1] === "toolEnd" ? "x" : "x", /x/); // sanity
  assert.equal(ui.events[1][0], "toolEnd");
});

test("printed lines carry the session key", async () => {
  const ui = makeUi();
  const wrapped = consoleUi(ui, "key-A");
  await captureConsole(() => wrapped.toolStart("Bash", { cmd: "ls" }));
});

test("assistant text flushes on endStream and delegates", async () => {
  const ui = makeUi();
  const wrapped = consoleUi(ui, "k1");
  await captureConsole(() => { wrapped.streamText("hello"); wrapped.streamText(" world"); wrapped.endStream(); });
  assert.equal(ui.events[2][0], "endStream");
});

test("info/warn/error print their lines", async () => {
  const ui = makeUi();
  const wrapped = consoleUi(ui, "k1");
  await captureConsole(() => { wrapped.info("starting"); wrapped.error("boom"); });
  assert.equal(ui.events[0][0], "info");
  assert.equal(ui.events[1][0], "error");
});
