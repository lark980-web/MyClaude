/**
 * Single source of truth for the version string.
 *
 * The number used to be hard-coded in main.js (twice), terminal.js, ink-app.js
 * and gui-server.js, and they drifted: package.json said 0.18.0 while the CLI
 * banner still printed v0.2.0.
 *
 * Two sources are consulted in order:
 *   1. MYCLAUDE_VERSION, which scripts/bundle-gui.mjs embeds at build time.
 *      A `bun build --compile` binary has no package.json next to it, so
 *      reading the file alone made the shipped exe report 0.0.0.
 *   2. package.json, for running from source.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

let cached = null;

/** Version from the build-time constant, else package.json, else "0.0.0". */
export function version() {
  if (cached !== null) { return cached; }
  // __MYCLAUDE_VERSION__ is replaced at build time with a literal (bun --define).
  // A standalone binary has no package.json beside it, so without this the
  // shipped exe reported 0.0.0.
  if (typeof __MYCLAUDE_VERSION__ !== "undefined" && __MYCLAUDE_VERSION__) {
    cached = __MYCLAUDE_VERSION__;
    return cached;
  }
  try {
    const pkgUrl = new URL("../package.json", import.meta.url);
    cached = JSON.parse(readFileSync(fileURLToPath(pkgUrl), "utf8")).version || "0.0.0";
  } catch {
    cached = "0.0.0";
  }
  return cached;
}

export const VERSION = version();
