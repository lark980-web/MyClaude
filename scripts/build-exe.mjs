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
import { readFileSync, existsSync, copyFileSync, statSync } from "node:fs";
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

// Ship ripgrep beside the binary: the compiled exe has no node_modules, so
// the npm package cannot be resolved at runtime. Grep looks for rg.exe first
// in the directory holding the executable.
try {
  const platformPkg = `@vscode/ripgrep-${process.platform}-${process.arch}`;
  const binName = process.platform === "win32" ? "rg.exe" : "rg";
  const [scope, name] = platformPkg.split("/");
  const src = join(root, "node_modules", scope, name, "bin", binName);
  const dest = join(root, "dist", binName);
  if (existsSync(src)) {
    copyFileSync(src, dest);
    process.stdout.write("bundled " + binName + " (" + Math.round(statSync(dest).size / 1048576) + " MB)\n");
  } else {
    process.stdout.write("note: " + platformPkg + " not installed; Grep falls back to its JS scan\n");
  }
} catch (e) {
  process.stdout.write("note: could not bundle ripgrep: " + e.message + "\n");
}
process.stdout.write("built dist/myclaude.exe (v" + pkg.version + ")\n");
