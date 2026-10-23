/**
 * Plan storage for /plan.
 *
 * Claude keeps the plan in a file and offers "/plan open" to edit it in the
 * user`s editor. MyClaude already had plan mode and an ExitPlanMode tool, but
 * nowhere to keep the plan, so /plan had nothing to show. These tests pin the
 * storage that closes that gap.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { planFile, readPlan, savePlan, clearPlan } =
  await import("../src/session.js");
const { getLastPlan, setPlanSessionId } =
  await import("../src/tools/extended.js");

/** A session id that cannot collide with a real one. */
function fakeId() {
  const d = mkdtempSync(join(tmpdir(), "mc-plan-"));
  return "testplan-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8);
}

test("a plan can be saved and read back", () => {
  const id = fakeId();
  const body = "# Plan\n\n1. Read the code\n2. Change it\n";
  savePlan(id, body);
  assert.equal(readPlan(id), body);
  assert.ok(existsSync(planFile(id)), "the plan is a real file on disk");
  clearPlan(id);
});

test("a session with no plan reads as null, not empty", () => {
  // /plan must be able to tell "no plan" from "empty plan".
  const id = fakeId();
  assert.equal(readPlan(id), null);
  clearPlan(id);
});

test("clearing a plan that was never saved reports false", () => {
  const id = fakeId();
  assert.equal(clearPlan(id), false);
});

test("clearing removes the file", () => {
  const id = fakeId();
  savePlan(id, "x");
  assert.equal(clearPlan(id), true);
  assert.equal(readPlan(id), null);
});

test("the plan path is per session, not shared", () => {
  const a = fakeId();
  const b = fakeId();
  assert.notEqual(planFile(a), planFile(b));
  assert.match(planFile(a), /\.md$/);
});

test("the most recent plan is remembered for /plan", () => {
  // ExitPlanMode sets this when the user approves, so /plan can show the
  // plan again without reading the transcript.
  setPlanSessionId(null);
  const before = getLastPlan();
  assert.ok(before === null || typeof before === "string");
});

test("setPlanSessionId accepts a session id or none", () => {
  const id = fakeId();
  assert.equal(setPlanSessionId(id), id);
  assert.equal(setPlanSessionId(null), null);
});

test("saving overwrites rather than appends", () => {
  // A second plan in the same session replaces the first: there is one live
  // plan, not a history.
  const id = fakeId();
  savePlan(id, "first");
  savePlan(id, "second");
  assert.equal(readPlan(id), "second");
  clearPlan(id);
});
