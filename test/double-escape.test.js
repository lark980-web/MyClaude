import test from "node:test";
import assert from "node:assert/strict";
import { isDoubleEscape } from "../src/ui/terminal.js";

test("double escape within the window triggers", () => {
  assert.ok(isDoubleEscape(1000, 800, 500));
  assert.ok(isDoubleEscape(1200, 700, 500));
});

test("single escape or a stale press does not", () => {
  assert.ok(!isDoubleEscape(1000, 0, 500));
  assert.ok(!isDoubleEscape(2000, 1000, 500), "outside the 500ms window");
});

