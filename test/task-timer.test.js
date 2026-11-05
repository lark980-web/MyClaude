/**
 * The task elapsed timer belongs on the thinking bar, not in the composer.
 * It used to sit beside the model picker, duplicating the row the user
 * actually watches while a task runs.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const app = readFileSync(join(ROOT, "src", "ui", "web", "js", "app.js"), "utf8");
const css = readFileSync(join(ROOT, "src", "ui", "web", "css", "styles.css"), "utf8");
const html = readFileSync(join(ROOT, "src", "ui", "web", "page.html"), "utf8");

test("the elapsed timer renders on the current turn's thinking bar", () => {
  assert.match(app, /thought-timer/, "a dedicated timer span exists on the thought head");
  assert.match(app, /querySelectorAll\("\.thought-timer"\)/, "the tick updates the live thinking bar");
  assert.match(css, /\.thought-timer\s*\{/, "the timer has its own style");
});

test("the composer no longer carries the timer", () => {
  assert.ok(!html.includes('id="stat"'), "no #stat slot in the composer");
  assert.ok(!/\$\("stat"\)/.test(app), "no writes to #stat remain");
  assert.ok(!/\.prompt-stat\s*\{/.test(css), "the old composer stat rule is gone");
});
