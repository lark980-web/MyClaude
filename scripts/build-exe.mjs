#!/usr/bin/env node
/**
 * Build the standalone executable.
 *
 * Two things this wrapper does that a bare `bun build --compile` does not:
 *   1. Bakes the version in via --define. A compiled binary carries no
 *      package.json, so reading the file at runtime reported 0.0.0.
 *   2. Regenerates the inlined GUI assets first, so the binary cannot ship
 *      a stale interface.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const root = fileURLToPath(new URL("..", import.meta.url));
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

function run(cmd, args) {
  process.stdout.write("> " + cmd + " " + args.join(" ") + "\n");
  execFileSync(cmd, args, { cwd: root, stdio: "inherit" });
}

run(process.execPath, ["scripts/bundle-gui.mjs"]);
run("bun", [
  "build",
  "--compile",
  "--minify",
  "--define", "__MYCLAUDE_VERSION__=" + JSON.stringify(pkg.version),
  "--outfile", "dist/myclaude.exe",
  "src/main.js",
]);

process.stdout.write("built dist/myclaude.exe (v" + pkg.version + ")\n");
