/**
 * The composer row must not drift apart.
 *
 * Controls sharing a row sit on one line, so a different height reads as
 * misalignment. The CSS stays valid either way, which is exactly why nothing
 * else in the suite caught the 28px pill beside two 32px squares.
 *
 * The auditor is checked alongside the page: a guard that cannot fail is
 * worse than no guard, because it reports success forever.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const {
  audit,
  selfTest,
  topLevelRules,
  bundledCss,
} = await import("../scripts/audit-ui-consistency.mjs");

const html = readFileSync(join(ROOT, "src", "ui", "web", "page.html"), "utf8");
const css = readFileSync(join(ROOT, "src", "ui", "web", "css", "styles.css"), "utf8");

test("the auditor can still see a planted height drift", () => {
  const problems = selfTest();
  assert.deepEqual(problems, [], "the guard is not working: " + problems.join("; "));
});

test("the audit actually covers rows, rather than passing on nothing", () => {
  // A guard that silently finds zero rows is a guard that checks nothing.
  const res = audit(css, html);
  assert.ok(res.rows >= 10, "only " + res.rows + " horizontal rows discovered");
  assert.ok(topLevelRules(css).length > 100, "the stylesheet does not parse");
  assert.deepEqual(res.notes, [], "controls without a rule: " + res.notes.join("; "));
});

test("controls sharing a row agree on height", () => {
  const lines = audit(css, html).findings.map((f) =>
    "." + f.row + " " + f.token + ": " + f.sels.join(", ") + " = " + f.value
    + " (the rest use " + f.major + ")");
  assert.deepEqual(lines, [], "controls in one row disagree:\n" + lines.join("\n"));
});

test("the served bundle agrees with the stylesheet", () => {
  // The browser only ever loads the bundle, so a fixed stylesheet beside a
  // stale bundle still looks wrong on screen. This caught a real miss.
  const bundle = bundledCss();
  assert.ok(bundle, "the bundle carries no stylesheet");
  assert.equal(audit(bundle, html).findings.length, audit(css, html).findings.length,
    "styles.css and the bundle disagree: rebuild it (npm run build:embed)");
});
