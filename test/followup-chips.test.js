/**
 * The follow-up suggestion chips.
 *
 * buildFollowupPrompts lives inside app.js`s IIFE, so it cannot be imported.
 * Exporting it just for a test would put a hook in production code for the
 * sake of the suite, which is the wrong trade for three fixed strings. What
 * actually matters about them is visible in the source: each group offers a
 * coherent set, and the entries within a group are close in length so the row
 * reads as three chips rather than one chip plus two afterthoughts.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const app = readFileSync(join(ROOT, "src", "ui", "web", "js", "app.js"), "utf8");

/** The three groups buildFollowupPrompts can return. */
function groups() {
  const out = [];
  const re = /return\s*\[([^\]]*)\]/g;
  let m;
  while ((m = re.exec(app)) !== null) {
    const body = m[1];
    // Only the suggestion groups: arrays of Chinese prompt strings.
    const items = [...body.matchAll(/"([^"]*[\u4e00-\u9fa5][^"]*)"/g)].map((x) => x[1]);
    if (items.length >= 3) { out.push(items); }
  }
  return out;
}

test("every suggestion group offers a full set", () => {
  const gs = groups();
  assert.ok(gs.length >= 3, "found " + gs.length + " groups");
  for (const g of gs) {
    assert.equal(g.length, 3, "each group offers three: " + g.join(" / "));
    for (const s of g) {
      assert.ok(s.trim().length > 0, "no empty suggestion");
    }
  }
});

test("suggestions within a group are close in length", () => {
  // The row is three chips side by side. One much longer entry would
  // dominate it, which is what the cap in .followup-chip is defending.
  for (const g of groups()) {
    const lens = g.map((s) => s.length);
    const shortest = Math.min(...lens);
    const longest = Math.max(...lens);
    assert.ok(longest - shortest <= 6,
      "uneven lengths " + lens.join("/") + " in: " + g.join(" / "));
  }
});

test("suggestions are short enough for a chip", () => {
  // A suggestion reads as one phrase; a sentence belongs in the input, not
  // in a chip that sits beside two others.
  for (const g of groups()) {
    for (const s of g) {
      assert.ok(s.length <= 20, "too long for a chip (" + s.length + "): " + s);
    }
  }
});

test("the chip is capped so one cannot swallow the row", () => {
  const css = readFileSync(join(ROOT, "src", "ui", "web", "css", "styles.css"), "utf8");
  const i = css.indexOf(".followup-chip {");
  assert.ok(i >= 0, "the chip has a rule");
  const rule = css.slice(i, css.indexOf("}", i));
  assert.match(rule, /max-width/, "a max-width keeps one chip from filling the row");
  assert.match(rule, /border-radius:\s*999px/, "a chip is a pill");
});
