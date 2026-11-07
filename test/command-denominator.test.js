import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";

test("R4 denominator doc covers all six suspects with verdicts", () => {
  const p = new URL("../docs/command-denominator.md", import.meta.url);
  if (!existsSync(p)) return;
  const md = readFileSync(p, "utf8");
  for (const cmd of ["restart", "theme", "brief", "feedback", "bug", "stickers"]) {
    assert.ok(md.includes("| " + cmd + " |"), "suspect row present: " + cmd);
  }
  assert.ok(md.includes("回收"), "recovery verdict present");
});

test("recovered commands stay out of the exclusion set (regression guard)", () => {
  const src = readFileSync(new URL("../scripts/parity-metrics.mjs", import.meta.url), "utf8");
  const m = src.match(/const CLOUD = new Set\(\[([^\]]*)\]\)/);
  assert.ok(m, "CLOUD set found");
  const items = new Set(m[1].split(",").map((x) => x.trim().replace(/^"|"$/g, "")).filter(Boolean));
  assert.ok(!items.has("restart"), "restart must stay recovered (local-implementable, R4)");
  assert.ok(!items.has("theme"), "theme must stay recovered (local-implementable, R4)");
});
