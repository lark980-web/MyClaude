import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { MODE_CYCLE, nextMode, PERMISSION_MODES } from "../src/agent/modes.js";

test("mode cycle matches the upstream Shift+Tab order", () => {
  assert.deepEqual(MODE_CYCLE, ["ask", "acceptEdits", "plan", "bypassPermissions", "auto"]);
  let cur = "ask";
  const seen = [];
  for (let i = 0; i < 5; i++) { seen.push(cur); cur = nextMode(cur); }
  assert.equal(cur, "ask", "wraps back to the start after five steps");
  assert.deepEqual(seen, MODE_CYCLE);
});

test("dontAsk and the local-only escape hatch stay off the ring", () => {
  assert.ok(!MODE_CYCLE.includes("dontAsk"), "upstream: dontAsk is never in the cycle");
  assert.ok(!MODE_CYCLE.includes("fullAccess"), "fullAccess must require a deliberate act");
  // 但两者仍是合法模式
  for (const id of ["dontAsk", "fullAccess"]) {
    assert.ok(PERMISSION_MODES.some((m) => m.id === id), id + " still a real mode");
    assert.equal(nextMode(id), "ask", id + " leaves the ring at its head");
  }
});

test("an unknown value entering the cycle starts at the head", () => {
  assert.equal(nextMode("nonsense"), "ask");
  assert.equal(nextMode(""), "ask");
  assert.equal(nextMode(null), "ask");
  assert.equal(nextMode("default"), "acceptEdits", "upstream 'default' aliases to ask");
});

test("the GUI ring is identical to the shared MODE_CYCLE", () => {
  const app = readFileSync(new URL("../src/ui/web/js/app.js", import.meta.url), "utf8");
  const m = /var MODE_RING = \[([^\]]+)\]/.exec(app);
  assert.ok(m, "MODE_RING present in the GUI");
  const ring = m[1].split(",").map((x) => x.trim().replace(/^"|"$/g, ""));
  assert.deepEqual(ring, MODE_CYCLE, "GUI ring must not drift from modes.js");
  assert.ok(app.includes("e.shiftKey && e.key === \"Tab\""), "Shift+Tab is bound");
  assert.ok(app.includes("permissionMode: next"), "cycle persists through /api/config");
});

test("/api/config accepts permissionMode", () => {
  const srv = readFileSync(new URL("../src/ui/gui-server.js", import.meta.url), "utf8");
  assert.ok(srv.includes("if (body.permissionMode)"), "config POST handles permissionMode");
  assert.ok(/normalizeMode\(body\.permissionMode\)/.test(srv), "mode is normalized before saving");
  assert.ok(/agent\.setMode\?\.\(wanted\)/.test(srv), "live agents are switched too");
});
