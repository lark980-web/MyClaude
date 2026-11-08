/**
 * GUI command parity + inspector information architecture.
 * These live inside app.js's IIFE, so assert against the source text —
 * (buildFollowupPrompts was removed; see followup-removed.test.js.)
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const app = readFileSync(join(ROOT, "src", "ui", "web", "js", "app.js"), "utf8");
const css = readFileSync(join(ROOT, "src", "ui", "web", "css", "styles.css"), "utf8");
const html = readFileSync(join(ROOT, "src", "ui", "web", "page.html"), "utf8");

test("/bashes is a real GUI command, not an unknown-command dead end", () => {
  assert.match(app, /\{ k: "\/bashes"/, "listed in COMMANDS");
  assert.match(app, /case "bashes":\s*\n\s*case "tasks":/, "falls through to /tasks");
  assert.match(app, /\/tasks \/bashes/, "advertised in /help");
  // openTasks() 只渲染，不切页签；命令入口必须走 showTasks()，否则点了没反应
  assert.match(app, /function showTasks\(\)/, "a tab-activating wrapper exists");
  assert.match(app, /case "tasks":\s*\n\s*showTasks\(\);/, "command activates the tab");
});

test("the two different task UIs no longer share one label", () => {
  assert.match(app, /section\("待办清单"\)/, "TodoWrite section renamed");
  assert.ok(!/section\("任务"\)/.test(app), "no bare 任务 section left");
  assert.match(html, /id="tab-insp-tasks"[^>]*title="[^"]*后台任务/, "tab explains it is background tasks");
});

test("inspector tabs never wrap and sections use the editorial rule", () => {
  const tab = css.slice(css.indexOf(".insp-tab {"), css.indexOf(".insp-tab:hover"));
  assert.match(tab, /white-space:\s*nowrap/, "labels stay on one line");
  assert.match(tab, /flex:\s*none/, "tabs do not shrink into vertical text");
  assert.match(css, /\.insp-tabs\s*\{[^}]*overflow-x:\s*auto/, "overflow scrolls instead");
  assert.match(css, /\.insp-sec-head::after/, "section heads carry a hairline rule");
  assert.match(css, /\.kv-row\s*\{[^}]*grid-template-columns/, "KV rows align in two columns");
});
