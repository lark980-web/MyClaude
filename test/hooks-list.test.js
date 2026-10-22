/**
 * The hook list the /hooks command reads.
 *
 * The engine and the GUI CRUD were already here; these pin the shape the
 * command depends on so a config change cannot silently break the listing.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { HOOK_EVENTS, HookRunner } from "../src/hooks.js";

test("every event Claude hooks into is listed", () => {
  // These are the events the engine dispatches; /hooks events prints this.
  assert.deepEqual([...HOOK_EVENTS].sort(), [
    "Notification", "PostToolUse", "PreCompact", "PreToolUse",
    "Stop", "SubagentStop", "UserPromptSubmit",
  ]);
});

test("an empty config reports no definitions", () => {
  const runner = new HookRunner({ config: {} });
  assert.deepEqual(runner.definitions, {});
  assert.equal(runner.has("PreToolUse"), false);
});

test("configured hooks are visible and counted", () => {
  const config = {
    hooks: {
      PreToolUse: [{ hooks: [{ command: "node check.js" }] }],
      Stop: [{ hooks: [{ command: "echo done" }] }],
    },
  };
  const runner = new HookRunner({ config });
  assert.equal(runner.has("PreToolUse"), true);
  assert.equal(runner.has("Stop"), true);
  assert.equal(runner.has("Notification"), false, "an unconfigured event has none");
  // The listing reads commands out of the group shape.
  assert.equal(runner.definitions.PreToolUse[0].hooks[0].command, "node check.js");
});

test("a malformed hooks block is treated as empty, not fatal", () => {
  const runner = new HookRunner({ config: { hooks: "not-an-object" } });
  assert.deepEqual(runner.definitions, {});
});
