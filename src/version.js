/**
 * Single source of truth for the version string.
 *
 * The number used to be hard-coded in main.js (twice), terminal.js, ink-app.js
 * and gui-server.js, and they drifted: package.json said 0.18.0 while the CLI
 * banner still printed v0.2.0. Reading package.json once keeps them together.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const pkgUrl = new URL("../package.json", import.meta.url);

let cached = null;

/** Version declared in package.json, or "0.0.0" if it cannot be read. */
export function version() {
  if (cached !== null) { return cached; }
  try {
    cached = JSON.parse(readFileSync(fileURLToPath(pkgUrl), "utf8")).version || "0.0.0";
  } catch {
    cached = "0.0.0";
  }
  return cached;
}

export const VERSION = version();

