/**
 * Realtime task readout: elapsed time + cumulative tokens on the loading bar.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const app = readFileSync(join(ROOT, "src", "ui", "web", "js", "app.js"), "utf8");
const css = readFileSync(join(ROOT, "src", "ui", "web", "css", "styles.css"), "utf8");
const server = readFileSync(join(ROOT, "src", "ui", "gui-server.js"), "utf8");

test("server pushes a progress SSE event every second while a task runs", () => {
  assert.match(server, /type: "progress"/, "progress event type exists");
  assert.match(server, /elapsedMs: Date\.now\(\) - runStartedAt/, "elapsed is measured server-side");
  assert.match(server, /inputTokens: agent \?/, "cumulative input tokens included");
  assert.match(server, /\}, 1000\);/, "1s interval");
  assert.match(server, /clearInterval\(progressTimer\)/, "interval is cleared at turn end");
  assert.match(server, /clearInterval\(flushTimer\)/, "the leaked flushTimer is now cleared too");
  assert.match(server, /let flushTimer = null;/, "timers declared before the try block");
});

test("frontend consumes progress and writes a live badge on the loading bar", () => {
  assert.match(app, /if \(ev\.type === "progress"\)/, "progress handler exists");
  assert.match(app, /setLiveStat\(ev\.elapsedMs, ev\.inputTokens, ev\.outputTokens, true\)/, "live values used");
  assert.match(app, /head\.appendChild\(el\("span", "tool-group-live", ""\)\)/, "badge is in the tool-group head");
  assert.match(app, /function setLiveStat\(/, "shared formatter");
  assert.match(app, /function fmtClockMs\(/, "mm:ss clock");
  assert.match(app, /function fmtTok\(/, "k-abbreviated token count");
  assert.match(app, /setLiveStat\(Date\.now\(\) - \(S\.busyStartedAt \|\| Date\.now\(\)\),\s*[\s\S]{0,180}false\)/, "done freezes the readout as a record");
});

test("the live badge sits on the right and has a running state", () => {
  const rule = css.slice(css.indexOf(".tool-group-live {"), css.indexOf(".tool-group-live:empty"));
  assert.match(rule, /margin-left:\s*auto/, "pushed to the right edge");
  assert.match(rule, /font-variant-numeric:\s*tabular-nums/, "stable digits while ticking");
  assert.match(css, /\.tool-group-live\.is-running \{[^}]*var\(--accent\)/, "running state is highlighted");
  assert.match(css, /\.tool-group-head:has\(\.tool-group-live\)::after \{ display: none; \}/,
    "decorative flex:1 hairline is suppressed so the badge reaches the right edge");
  assert.match(css, /@keyframes blink/, "reuses an existing keyframe");
  assert.match(css, /animation: blink 1\.2s/, "no undefined pulse keyframe");
});
