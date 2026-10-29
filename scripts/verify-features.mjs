#!/usr/bin/env node
/**
 * Feature-integrity guard.
 *
 * The working tree is shared with concurrent agent sessions that rewrite
 * whole files from stale snapshots, which has (repeatedly) silently dropped
 * committed features. Run this after any other session touches the repo:
 *
 *   node scripts/verify-features.mjs
 *
 * Exit 0 = every marker present. Exit 1 lists what vanished (recover from
 * git history: git show <commit>:<file>).
 */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const FILES = {
  "src/ui/web/js/app.js": [
    'case "review"',
    'case "output-style"',
    'output-style-set',
    'inbox-tabs',
    'ctx-field',
    'model-speedbar',
    'revertAutoEngineIfAuto',
    'at-menu',
  ],
  "src/main.js": [
    'case "review"',
    'case "output-style"',
    'case "bashes"',
    'onEditPrevious',
    'wasRewound',
    'reviewPrompt',
    "上下文分解",
    'listOutputStyles',
  ],
  "src/ui/terminal.js": ['isDoubleEscape', 'onEditPrevious'],
  "src/output-style.js": ['listOutputStyles', 'BUILTIN_STYLES'],
  "src/ui/gui-server.js": [
    '/api/busy',
    '/api/output-styles',
    '/api/tasks/output',
    '/api/tasks/kill',
    'flushInteractive',
    'gui.lock',
    'systemTokens',
    'flushTimer',
  ],
  "src/agent/agent.js": [
    'setOutputStyle',
    'this.stopRequested = false',
    'outputStyleFragment',
  ],
  "src/tools/tasks.js": ['adoptProcess'],
  "src/tools/index.js": ['do NOT re-run', 'promotedTask'],
  "src/ui/web/css/styles.css": ['.ctx-field', '.inbox-tabs', '.model-speedbar'],
};

let bad = 0;
for (const [file, marks] of Object.entries(FILES)) {
  let content;
  try { content = readFileSync(join(root, file), "utf8"); }
  catch { console.log("✗ " + file + " 不存在"); bad += marks.length; continue; }
  const missing = marks.filter((m) => !content.includes(m));
  if (missing.length) {
    bad += missing.length;
    console.log("✗ " + file + " 缺失: " + missing.join(", "));
  } else {
    console.log("✓ " + file + "（" + marks.length + " 标记）");
  }
}
console.log(bad === 0 ? "\n功能完整性 ✓" : "\n功能完整性 ✗ —— 从 git 历史恢复缺失块后再构建");
process.exit(bad === 0 ? 0 : 1);
