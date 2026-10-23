/**
 * Smoke-check every slash command against the built exe.
 *
 * Why this exists:
 *   - /hooks was marked done in the feature matrix while the CLI had no such
 *     command, because the engine and the GUI route existed. Reading the code
 *     was not enough to notice.
 *   - /plan and /memory both shipped a ReferenceError that node --check cannot
 *     see: the identifier was simply never imported. Static checks pass, the
 *     command dies on the first keystroke.
 *
 * So the check runs the real binary. A command counts as broken when the exe
 * crashes, and as unverified when it prints nothing at all - both are reported,
 * because "no output" is how a command quietly fails to do its job.
 *
 * Usage: node scripts/smoke-commands.mjs [--json]
 * Exit 1 when any command crashes.
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync, statSync } from "node:fs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const EXE = join(ROOT, "dist", "myclaude.exe");

/**
 * Commands to probe, each with an argument that keeps it read-only: a bare
 * invocation must not delete a session or rewrite a file.
 */
const PROBES = [
  "/rewind", "/sessions", "/resume", "/fork", "/branch", "/title", "/rm",
  "/tasks", "/skills", "/plugin", "/hooks", "/hooks events", "/compact",
  "/cost", "/doctor", "/init", "/export", "/effort", "/fast", "/status",
  "/memory", "/loop", "/plan", "/help", "/model", "/provider", "/mode",
  "/mcp", "/tools", "/permissions", "/stats", "/config", "/models",
  "/save", "/session", "/commands", "/clear", "/exit",
];

/** Patterns that mean the command died, not merely complained. */
const CRASH = /fatal:|ReferenceError|TypeError:|SyntaxError:|is not a function|Cannot read/;

function strip(s) {
  return String(s || "").replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
}

function run(cmd) {
  const r = spawnSync(EXE, ["--plain"], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 40000,
    windowsHide: true,
    input: cmd + "\n/exit\n",
  });
  return strip((r.stdout || "") + (r.stderr || ""));
}

/** The first line the command printed after its own prompt. */
function firstOutput(out, cmd) {
  const tail = out.split("> " + cmd)[1] || out;
  const line = tail
    .split("\n")
    .map((x) => x.trim())
    .filter((x) => x && x !== "/exit" && !x.startsWith(">"))
    .find(Boolean);
  return line || "";
}

export function smoke() {
  if (!existsSync(EXE)) {
    return { error: "no exe at " + EXE + " - build it first (npm run build:exe)", results: [] };
  }
  const results = [];
  for (const cmd of PROBES) {
    const out = run(cmd);
    const crashed = CRASH.test(out);
    const printed = firstOutput(out, cmd);
    results.push({
      cmd,
      ok: !crashed,
      crashed,
      silent: !crashed && !printed,
      output: printed.slice(0, 80),
    });
  }
  return {
    exe: EXE,
    builtAt: statSync(EXE).mtime.toISOString(),
    results,
    crashes: results.filter((r) => r.crashed).map((r) => r.cmd),
    silent: results.filter((r) => r.silent).map((r) => r.cmd),
  };
}

const isMain = process.argv[1]
  && process.argv[1].replace(/\\/g, "/").endsWith("smoke-commands.mjs");
if (isMain) {
  const res = smoke();
  if (res.error) {
    console.log(res.error);
    process.exit(1);
  }
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(res, null, 2));
  } else {
    for (const r of res.results) {
      const mark = r.crashed ? "CRASH " : (r.silent ? "silent" : "ok    ");
      console.log(mark + "  " + r.cmd.padEnd(16) + r.output);
    }
    console.log("\ncommands: " + res.results.length
      + "  crashing: " + res.crashes.length
      + "  silent: " + res.silent.length);
    if (res.crashes.length) { console.log("crashing: " + res.crashes.join(" ")); }
    if (res.silent.length) { console.log("silent: " + res.silent.join(" ")); }
  }
  process.exit(res.crashes.length ? 1 : 0);
}
