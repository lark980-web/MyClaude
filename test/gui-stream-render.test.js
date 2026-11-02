/**
 * Tests for the streaming render path.
 *
 * A long reply used to re-parse the whole accumulated markdown on every
 * delta, which is quadratic. The renderer now batches the work into one
 * animation frame. These tests use a tiny DOM stub — the renderer only
 * touches innerHTML/className on the body element and requestAnimationFrame,
 * so a stub is enough and keeps the suite dependency-free.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const appSource = readFileSync(join(here, "..", "src", "ui", "web", "js", "app.js"), "utf8");

/** Pull one function out of the bundle and make it callable. */
function extractFunction(name, extraDeps = {}) {
  const start = appSource.indexOf("function " + name + "(");
  assert.ok(start > 0, name + " should exist in app.js");
  let depth = 0;
  let i = appSource.indexOf("{", start);
  for (; i < appSource.length; i++) {
    const ch = appSource[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) break;
    }
  }
  const src = appSource.slice(start, i + 1);
  // eslint-disable-next-line no-new-func
  return new Function(
    "deps",
    "with (deps) { " + src + "; return " + name + "; }"
  )(extraDeps);
}

/** A requestAnimationFrame stub that queues callbacks until flushed. */
function makeRafStub() {
  const queue = [];
  return {
    raf: (cb) => {
      queue.push(cb);
      return queue.length;
    },
    flush() {
      while (queue.length) {
        const cb = queue.shift();
        cb();
      }
    },
    pending: () => queue.length,
  };
}

test("streaming deltas are batched into a single render per frame", () => {
  const raf = makeRafStub();
  let renders = 0;
  const MD = {
    render(text) {
      renders++;
      return "<p>" + text + "</p>";
    },
  };
  const renderAssistant = extractFunction("renderAssistant", {
    MD: MD,
    extractThinkTagContent: (s) => ({ rest: s, think: "" }),
    scrollStream: () => {},
    requestAnimationFrame: raf.raf,
  });

  const handle = { body: { innerHTML: "", className: "" } };
  // Ten deltas arrive before the frame is painted.
  for (let i = 1; i <= 10; i++) {
    renderAssistant(handle, "chunk" + i, true);
  }
  assert.equal(renders, 0, "nothing is rendered before the frame paints");
  assert.equal(raf.pending(), 1, "only one frame is scheduled");

  raf.flush();
  assert.equal(renders, 1, "the whole batch renders once");
  assert.ok(handle.body.innerHTML.includes("chunk10"), "the latest text is shown");
});

test("a non-streaming render is immediate and complete", () => {
  const raf = makeRafStub();
  let renders = 0;
  const MD = {
    render(text) {
      renders++;
      return "<p>" + text + "</p>";
    },
  };
  const renderAssistant = extractFunction("renderAssistant", {
    MD: MD,
    extractThinkTagContent: (s) => ({ rest: s, think: "" }),
    scrollStream: () => {},
    requestAnimationFrame: raf.raf,
  });

  const handle = { body: { innerHTML: "", className: "" } };
  renderAssistant(handle, "final text", false);
  assert.equal(renders, 1, "the final render is not deferred");
  assert.equal(raf.pending(), 0, "no frame is scheduled for a finished answer");
  assert.ok(handle.body.innerHTML.includes("final text"));
  assert.equal(handle.body.className, "md ");
});

test("the streaming path keeps the cursor class while it runs", () => {
  const raf = makeRafStub();
  const MD = { render: (t) => t };
  const renderAssistant = extractFunction("renderAssistant", {
    MD: { render: (s) => s },
    extractThinkTagContent: (s) => ({ rest: s, think: "" }),
    scrollStream: () => {},
    requestAnimationFrame: raf.raf,
  });
  const handle = { body: { innerHTML: "", className: "" } };
  renderAssistant(handle, "typing", true);
  assert.equal(handle.body.className, "md cursor");
});

test("think tags are stripped from what gets painted", () => {
  const raf = makeRafStub();
  const painted = [];
  const MD = {
    render(text) {
      painted.push(text);
      return text;
    },
  };
  const renderAssistant = extractFunction("renderAssistant", {
    MD: MD,
    extractThinkTagContent: (s) => ({
      rest: s.replace(/<think>[\s\S]*?<\/think>/g, ""),
      think: "hidden",
    }),
    scrollStream: () => {},
    requestAnimationFrame: raf.raf,
  });
  const handle = { body: { innerHTML: "", className: "" } };
  renderAssistant(handle, "<think>private</think>visible", false);
  assert.ok(!painted[0].includes("private"), "the think block is not painted");
  assert.ok(painted[0].includes("visible"));
});
