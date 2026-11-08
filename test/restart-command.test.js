import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { restartArgs, performRestart } from "../src/restart.js";

// /restart parity (R4 recovered): upstream chunk-e0x0xb6d @2195979
// {type:"local",name:"restart",aliases:["update"],description:"Restart ... keep this session"}.
test("restartArgs keeps flags and replaces prior --resume with the session", () => {
  assert.deepEqual(restartArgs(["--gui", "--port", "7788"], "s1"), ["--gui", "--port", "7788", "--resume", "s1"]);
  assert.deepEqual(restartArgs(["--resume", "old", "--gui"], "new"), ["--gui", "--resume", "new"]);
  assert.deepEqual(restartArgs(["-r", "old"], "new"), ["--resume", "new"]);
  assert.deepEqual(restartArgs([], null), []);
});

test("performRestart spawns detached with resume and exits 0 (injected spawner)", () => {
  let spawned = null, exitCode = null;
  const fakeChild = { unref() {} };
  const pid = performRestart({
    sessionId: "s9", argv: ["--gui"], execPath: "/node",
    exit: (c) => { exitCode = c; },
    spawner: (exe, args, opts) => { spawned = { exe, args, opts }; return fakeChild; },
  });
  assert.equal(exitCode, 0);
  assert.ok(spawningHasResume(spawned.args, "s9"));
  assert.equal(spawned.opts.detached, true);
});
function spawningHasResume(args, sid) { const i = args.indexOf("--resume"); return i >= 0 && args[i + 1] === sid; }

test("TUI dispatches /restart and /update alias", () => {
  const src = readFileSync(new URL("../src/main.js", import.meta.url), "utf8");
  assert.ok(/case "restart":/.test(src) && /case "update":/.test(src), "both cases");
  assert.ok(/performRestart\(\{ sessionId: sid \}\)/.test(src), "restart invoked with session");
});

test("GUI exposes /restart via command bridge", () => {
  const app = readFileSync(new URL("../src/ui/web/js/app.js", import.meta.url), "utf8");
  const srv = readFileSync(new URL("../src/ui/gui-server.js", import.meta.url), "utf8");
  assert.ok(/restart: function \(\) \{ runServerCommand\("restart"\); \}/.test(app), "GUI command");
  assert.ok(/name === "restart"/.test(srv), "server handler");
});
