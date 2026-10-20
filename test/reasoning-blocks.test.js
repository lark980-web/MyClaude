/**
 * Reasoning-block handling.
 *
 * Gateways that answer with a leading `implicit reasoning` block must not have
 * that text leak into the transcript: it is routed to the "thinking" panel, kept
 * out of `handle.raw`, and stripped before it is ever stored in history.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { splitReasoning, stripReasoning, hasOpenReasoning } from "../src/agent/think.js";

// Built from pieces so the markers stay literal in source control and in this
// file itself (they would otherwise be read as real tags).
const OPEN = "<" + "think>";
const CLOSE = "<" + "/think>";

const APP_SOURCE = readFileSync(
  fileURLToPath(new URL("../src/ui/web/js/app.js", import.meta.url)),
  "utf8"
);

/** Minimal browser stubs: enough for the IIFE to evaluate and expose helpers. */
function makeWindow() {
  const store = new Map();
  const noop = () => {};
  const el = () => ({
    style: {}, classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
    appendChild: noop, addEventListener: noop, setAttribute: noop,
    // Return an element rather than null: boot() reports a failed config fetch
    // through addNotice, which appends into logRoot(). Handing back null made
    // that surface as a late "appendChild of null" after the test ended.
    querySelector: () => el(),
    querySelectorAll: () => [], children: [], dataset: {}, textContent: "", innerHTML: ""
  });
  const win = {
    addEventListener: noop, removeEventListener: noop,
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k)
    },
    navigator: { userAgent: "node", clipboard: { writeText: () => Promise.resolve() } },
    location: { href: "http://localhost/", search: "", hash: "" },
    document: {
      addEventListener: noop, createElement: el, createTextNode: el,
      getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
      body: el(), documentElement: el()
    },
    // Never settles: boot()'s config fetch would otherwise run its .catch after
    // the test file finished, appending into a torn-down mock DOM.
    fetch: () => new Promise(() => {}),
    // Run frame callbacks synchronously: deferring them lets work outlive the
    // test that scheduled it, which surfaces as a late "appendChild of null".
    requestAnimationFrame: (fn) => { try { fn(0); } catch (e) {} return 0; },
    // Run timers synchronously and swallow late DOM errors: a deferred callback
    // that fires after its test ended is the "appendChild of null" noise the
    // runner reports as an unhandled rejection.
    setTimeout: (fn) => { try { if (typeof fn === "function") { fn(); } } catch (e) {} return 0; },
    clearTimeout: () => {},
    setInterval: () => 0,
    clearInterval: () => {},
    Math, Date, JSON, Object, Array, String, Number, Boolean, RegExp, Error, Promise,
    console, parseInt, parseFloat, isNaN, encodeURIComponent, decodeURIComponent
  };
  win.window = win;
  win.globalThis = win;
  return win;
}

/** Evaluate the browser script and reach into the IIFE for its helpers. */
function loadAppHelpers() {
  const hook =
    "globalThis.__probe = { extractThinkTagContent: extractThinkTagContent," +
    " renderAssistant: renderAssistant, flushAssistant: flushAssistant };";
  const src = APP_SOURCE.replace(/\}\)\(\);\s*$/, hook + "\n})();");
  const win = makeWindow();
  const fn = new Function(
    "window", "document", "localStorage", "navigator", "location",
    "URLSearchParams", "fetch", "requestAnimationFrame", "globalThis",
    src
  );
  fn(
    win, win.document, win.localStorage, win.navigator, win.location,
    URLSearchParams, win.fetch, win.requestAnimationFrame, win
  );
  return win.__probe;
}

const helpers = loadAppHelpers();
const split = helpers.extractThinkTagContent;

/* ------------------------------------------------------------- agent side --- */

test("splitReasoning separates reasoning from the answer", () => {
  const out = splitReasoning(OPEN + " steps\n\ncode here" + CLOSE + "final answer");
  assert.equal(out.reasoning, " steps\n\ncode here");
  assert.equal(out.visible, "final answer");
  assert.equal(out.open, false);
});

test("splitReasoning reports an unterminated block as open", () => {
  const out = splitReasoning(OPEN + " still thinking");
  assert.equal(out.reasoning, " still thinking");
  assert.equal(out.visible, "");
  assert.equal(out.open, true);
});

test("splitReasoning closes on the first closing tag only", () => {
  const raw = OPEN + " first" + CLOSE + "answer" + CLOSE + " tail";
  const out = splitReasoning(raw);
  assert.equal(out.visible, "answer" + CLOSE + " tail");
  assert.equal(out.open, false);
});

test("splitReasoning keeps a whitespace-only preamble ahead of the block", () => {
  const out = splitReasoning("\n\n" + OPEN + " reasoning" + CLOSE + "answer");
  assert.equal(out.visible, "\n\nanswer");
  assert.equal(out.reasoning, " reasoning");
});

test("splitReasoning ignores an opening tag buried mid-prose", () => {
  assert.equal(splitReasoning("answer with " + OPEN + " mentioned inline"), null);
});

test("stripReasoning leaves ordinary answers untouched", () => {
  const text = "Here is a fence:\n\n```js\nconst a = 1;\n```\n";
  assert.equal(stripReasoning(text), text);
});

test("stripReasoning drops the block but keeps the answer", () => {
  assert.equal(stripReasoning(OPEN + " reasoning\n\n" + CLOSE + "answer"), "answer");
});

test("stripReasoning is idempotent", () => {
  const once = stripReasoning(OPEN + " reasoning" + CLOSE + "answer");
  assert.equal(stripReasoning(once), once);
});

test("hasOpenReasoning tracks a truncated stream", () => {
  assert.equal(hasOpenReasoning(OPEN + " so far"), true);
  assert.equal(hasOpenReasoning(OPEN + " done" + CLOSE + "answer"), false);
  assert.equal(hasOpenReasoning("plain answer"), false);
});

test("empty and nullish input is handled", () => {
  assert.equal(stripReasoning(""), "");
  assert.equal(stripReasoning(null), "");
  assert.equal(stripReasoning(undefined), "");
  assert.equal(splitReasoning(""), null);
  assert.equal(splitReasoning(null), null);
});

/* ---------------------------------------------------------------- gui side --- */

test("gui split agrees with the agent module", () => {
  const raw = OPEN + " reasoning\n\n" + CLOSE + "answer";
  const gui = split(raw);
  const agent = splitReasoning(raw);
  assert.equal(gui.think, agent.reasoning.trim());
  assert.equal(gui.rest, agent.visible);
  assert.equal(gui.open, agent.open);
});

test("gui split moves inline reasoning before a lone closing tag into think", () => {
  // A gateway that drops the opener still leaves the reasoning inline. It is
  // reasoning, not prose, so it must not survive in the answer body.
  const gui = split("reasoning prose\n\n" + CLOSE + "answer");
  assert.equal(gui.rest, "answer");
  assert.equal(gui.think, "reasoning prose");
  assert.ok(!gui.rest.includes(CLOSE), "no stray close tag left behind");
});

test("gui split keeps a closing tag quoted inside prose", () => {
  // Only a tag that terminates a leading block is removed, so quoted content
  // survives intact.
  const gui = split("See " + CLOSE + " for details");
  assert.equal(gui.rest, "See " + CLOSE + " for details");
});

test("gui split is null when there is nothing to strip", () => {
  assert.equal(split("just an answer"), null);
  assert.equal(split(""), null);
  assert.equal(split(null), null);
});

test("gui split tolerates leading whitespace before the opening tag", () => {
  const gui = split("\n\n " + OPEN + " reasoning\n\n" + CLOSE + "answer");
  assert.equal(gui.rest.trim(), "answer");
  assert.equal(gui.open, false);
});

test("gui split ignores an opening tag buried mid-prose", () => {
  const gui = split("answer with " + OPEN + " mentioned inline");
  assert.equal(gui, null);
});

test("renderAssistant never paints the raw reasoning block", () => {
  const handle = { body: { innerHTML: "", className: "" }, raw: "" };
  helpers.renderAssistant(handle, OPEN + " reasoning\n\n" + CLOSE + "final answer", true);
  assert.equal(handle.raw, "final answer");
  assert.ok(!handle.body.innerHTML.includes("reasoning"), "reasoning text is not rendered");
  assert.ok(!handle.body.innerHTML.includes("&lt;"), "no escaped tags in the body");
});

test("renderAssistant during an open block renders nothing yet", () => {
  const handle = { body: { innerHTML: "", className: "" }, raw: "" };
  helpers.renderAssistant(handle, OPEN + " reasoning still going", true);
  assert.equal(handle.raw, "");
  assert.equal(handle.body.innerHTML, "");
});

test("renderAssistant strips a stray closing tag", () => {
  const handle = { body: { innerHTML: "", className: "" }, raw: "" };
  helpers.renderAssistant(handle, "reasoning prose\n\n" + CLOSE + "answer", true);
  // raw feeds copy / TTS / follow-ups, so it must hold the answer only.
  assert.equal(handle.raw, "answer");
  assert.ok(!handle.body.innerHTML.includes("&lt;"), "no escaped tags in the body");
});

test("flushAssistant keeps raw clean for copy, tts and follow-ups", () => {
  // flushAssistant runs code-block enhancement, which queries the DOM; the mock
  // body needs the same surface a real element has.
  const handle = {
    body: { innerHTML: "", className: "", querySelectorAll: () => [], appendChild() {} },
    raw: "",
  };
  helpers.flushAssistant(handle, OPEN + " reasoning\n\n" + CLOSE + "answer body", false);
  assert.equal(handle.raw.trim(), "answer body");
  assert.ok(!handle.body.innerHTML.includes("reasoning"));
});
