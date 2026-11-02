/**
 * The /auto command and the hint that advertises it.
 *
 * The max-turns card tells the user to type "/auto on". That promise is only
 * honest if the GUI dispatch really has the command and the config endpoint
 * really persists autoRun — both were broken at once on 2026-11-02, which is
 * what this file exists to prevent.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

const here = dirname(fileURLToPath(import.meta.url));
const appSource = readFileSync(join(here, "..", "src", "ui", "web", "js", "app.js"), "utf8");

test("the max-turns hint advertises /auto", () => {
  assert.match(appSource, /或 \/auto on 开启自主续跑/);
});

test("/auto is dispatched by the GUI command handler", () => {
  assert.match(appSource, /case "auto":/);
});

test("/auto appears in the slash-command menu", () => {
  assert.match(appSource, /k: "\/auto"/);
});

test("every command named by a user-facing hint is dispatchable", () => {
  // A command mention is a "/word" that starts after whitespace, CJK text or
  // CJK punctuation (so API paths like /api/chat, HTML like </label> and model
  // names like /gpt-oss-20b are not commands), and is not itself followed by a
  // path segment.
  const re = /"[^"\n]*?(?<=[\s\u4e00-\u9fff（(：:])\/(\w[\w-]{1,18})(?![\w/])[^"]*"/g;
  const hinted = new Set();
  let m;
  while ((m = re.exec(appSource))) {
    const whole = m[0];
    if (!/或|用法|试试|输入|开启|切换/.test(whole)) continue;
    if (/\d/.test(m[1])) continue;
    hinted.add(m[1]);
  }
  assert.ok(hinted.size >= 1, "expected at least one hinted command");
  for (const cmd of hinted) {
    const dispatched = new RegExp('case "' + cmd + '":').test(appSource);
    const inMenu = new RegExp('k: "/' + cmd + '"').test(appSource);
    assert.ok(dispatched || inMenu, "/" + cmd + " is advertised in a hint but not dispatchable");
  }
});

// ---- live: the config endpoint persists autoRun ----
const HOME = mkdtempSync(join(tmpdir(), "myclaude-home-"));
process.env.MYCLAUDE_HOME = HOME;
const { startGui } = await import("../src/ui/gui-server.js");

test("POST /api/config persists autoRun both ways", async () => {
  const config = { provider: "openai", baseUrl: "http://127.0.0.1:1/v1", apiKey: "t", model: "t",
    permissionMode: "fullAccess", vision: true, maxTurns: 1000, contextWindow: 100000, compactThreshold: 0.8 };
  const { server, address } = await startGui({ config, port: 0, open: false, cwd: process.cwd() });
  try {
    await fetch(address + "/api/config", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ autoRun: true }),
    });
    let got = await (await fetch(address + "/api/config")).json();
    assert.equal(got.autoRun, true, "autoRun should read back as true");

    await fetch(address + "/api/config", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ autoRun: false }),
    });
    got = await (await fetch(address + "/api/config")).json();
    assert.equal(got.autoRun, false, "autoRun should read back as false");
  } finally {
    await new Promise((r) => server.close(r));
  }
});
