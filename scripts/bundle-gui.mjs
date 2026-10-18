#!/usr/bin/env node
/**
 * Inline the GUI sources into src/ui/assets.js so `bun build --compile` can
 * ship a single executable with the full interface inside.
 *
 * Run automatically by `npm run build`; safe to run any time (idempotent).
 * `node bin/myclaude.js --gui` keeps reading the files from disk, so this step
 * only matters for the standalone binary.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const root = fileURLToPath(new URL("..", import.meta.url));
const ASSETS = join(root, "src", "ui", "assets.js");

const FILES = {
  page: "src/ui/web/page.html",
  styles: "src/ui/web/css/styles.css",
  markdown: "src/ui/web/js/markdown.js",
  app: "src/ui/web/js/app.js",
};

const load = (rel) => readFileSync(join(root, rel), "utf8");

/** Serialize a source file as a JS string literal that survives any content. */
function literal(text) {
  return JSON.stringify(text);
}

const body = Object.entries(FILES)
  .map(([key, rel]) => {
    const text = load(rel);
    if (text.includes("\u2028") || text.includes("\u2029")) {
      throw new Error(rel + ": contains a line separator that JSON.stringify escapes safely, continuing");
    }
    return "  " + key + ": " + literal(text) + ",";
  })
  .join("\n");

const source = readFileSync(ASSETS, "utf8");

// Replace the whole `const EMBEDDED = {...};` declaration, whatever preceded it.
// Matching the declaration (not a comment) keeps this script idempotent.
const start = source.indexOf("const EMBEDDED = {");
if (start < 0) throw new Error("assets.js has no EMBEDDED declaration to fill");
const end = source.indexOf("\n};", start);
if (end < 0) throw new Error("assets.js EMBEDDED declaration is not terminated");

const block =
  "/**\n" +
  " * Embedded copies of src/ui/web/*, written by scripts/bundle-gui.mjs.\n" +
  " * Do not edit by hand: run \"npm run build:embed\" after changing the UI.\n" +
  " */\n" +
  "const EMBEDDED = {\n" +
  body +
  "\n};";

const next = source.slice(0, start) + block + source.slice(end + 3);
writeFileSync(ASSETS, next, "utf8");

const sizes = Object.entries(FILES).map(([k, rel]) => k + "=" + (load(rel).length / 1024).toFixed(1) + "KB");
console.log("embedded GUI assets ->", sizes.join(" "));
