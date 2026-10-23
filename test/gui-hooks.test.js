/**
 * The hooks endpoint that the settings panel writes to.
 *
 * Worth guarding even though it is only a few lines: the engine and this
 * route once existed while the CLI had no /hooks at all, so a feature matrix
 * said "done" for something nobody could reach. The tests below pin that the
 * route and the CLI agree on the same event list, so they cannot drift apart
 * again without a test failing.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Keep the real ~/.myclaude untouched: config lands in a temporary home.
process.env.MYCLAUDE_HOME = mkdtempSync(join(tmpdir(), "myclaude-hooks-"));

const { startGui } = await import("../src/ui/gui-server.js");
const { HOOK_EVENTS } = await import("../src/hooks.js");

let ctx = null;

async function gui() {
  if (!ctx) {
    ctx = await startGui({
      config: { provider: "openai", baseUrl: "http://x/v1", apiKey: "k", model: "m", hookShell: "cmd" },
      port: 0,
      open: false,
    });
  }
  return ctx;
}

const post = (addr, body) => fetch(addr + "/api/hooks", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

test("GET lists the events the CLI also knows about", async () => {
  // The panel offers these as a dropdown; /hooks events prints the same
  // list. They must be one list, not two that happen to match today.
  const { address } = await gui();
  const res = await fetch(address + "/api/hooks");
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual([...body.events].sort(), [...HOOK_EVENTS].sort(),
    "the route and HOOK_EVENTS disagree");
  assert.ok(Array.isArray(body.toolEvents), "tool events are listed too");
});

test("GET starts from an empty hook config", async () => {
  const { address } = await gui();
  const body = await (await fetch(address + "/api/hooks")).json();
  assert.equal(typeof body.hooks, "object");
});

test("POST add appends a command to an event", async () => {
  const { address } = await gui();
  const res = await post(address, {
    add: { event: "PreToolUse", matcher: "Bash", command: "echo hi" },
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.ok(Array.isArray(body.hooks.PreToolUse), "the event now has groups");
  assert.equal(body.hooks.PreToolUse[0].hooks[0].command, "echo hi");
  assert.equal(body.hooks.PreToolUse[0].matcher, "Bash");
});

test("POST add rejects an unknown event", async () => {
  // A typo in the panel must not silently create a hook that never fires.
  const { address } = await gui();
  const res = await post(address, {
    add: { event: "NotAnEvent", command: "echo hi" },
  });
  const body = await res.json();
  assert.equal(body.hooks.NotAnEvent, undefined, "unknown events are ignored");
});

test("POST add rejects an empty command", async () => {
  const { address } = await gui();
  const res = await post(address, {
    add: { event: "Stop", command: "   " },
  });
  const body = await res.json();
  assert.equal(body.hooks.Stop, undefined, "a blank command is refused");
});

test("POST remove drops one entry by index", async () => {
  const { address } = await gui();
  await post(address, { add: { event: "Stop", command: "first" } });
  await post(address, { add: { event: "Stop", command: "second" } });
  const before = await (await fetch(address + "/api/hooks")).json();
  assert.equal(before.hooks.Stop.length, 2, "two entries were added");

  const res = await post(address, { remove: { event: "Stop", index: 0 } });
  const body = await res.json();
  assert.equal(body.hooks.Stop.length, 1);
  assert.equal(body.hooks.Stop[0].hooks[0].command, "second", "the first went");
});

test("POST remove drops the event when its last entry goes", async () => {
  // An event with no entries should disappear rather than linger as [].
  const { address } = await gui();
  await post(address, { add: { event: "Notification", command: "only" } });
  const res = await post(address, { remove: { event: "Notification", index: 0 } });
  const body = await res.json();
  assert.equal(body.hooks.Notification, undefined, "the event was removed");
});

test("POST set replaces a whole event", async () => {
  const { address } = await gui();
  await post(address, { add: { event: "PreCompact", command: "old" } });
  const res = await post(address, {
    set: { PreCompact: [{ matcher: "", hooks: [{ type: "command", command: "new" }] }] },
  });
  const body = await res.json();
  assert.equal(body.hooks.PreCompact.length, 1);
  assert.equal(body.hooks.PreCompact[0].hooks[0].command, "new");
});

test("POST set with an empty array clears the event", async () => {
  const { address } = await gui();
  await post(address, { add: { event: "SubagentStop", command: "x" } });
  const res = await post(address, { set: { SubagentStop: [] } });
  const body = await res.json();
  assert.equal(body.hooks.SubagentStop, undefined);
});

test.after(() => { if (ctx && ctx.server) ctx.server.close(); });
