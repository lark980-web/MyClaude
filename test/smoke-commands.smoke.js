/**
 * No slash command may crash the built exe.
 *
 * Two bugs got through static checks because they were not failures of the
 * file - they were failures of one command:
 *   /plan    used `saver`, which that branch never defined
 *   /memory  used `loadMemory`, which was never imported
 * node --check passes on both. Only running the binary catches them.
 *
 * The suite skips when the exe has not been built, so a source-only checkout
 * stays green rather than failing over a missing artefact.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const EXE = join(ROOT, "dist", "myclaude.exe");
const hasExe = existsSync(EXE);

const { smoke } = await import("../scripts/smoke-commands.mjs");

// Probing takes a couple of minutes, so the run is shared by both tests.
const res = hasExe ? smoke() : null;

test("every slash command runs without crashing", (t) => {
  if (!hasExe) { t.skip("exe not built - run npm run build:exe"); return; }
  assert.deepEqual(res.crashes, [],
    "these commands die on the first keystroke:\n" + res.crashes.join("\n"));
  assert.ok(res.results.length >= 20, "only " + res.results.length + " commands probed");
});

test("every slash command prints something it can be judged by", (t) => {
  // A silent command is how a feature quietly stops working: it still
  // exists, so the matrix still says yes.
  if (!hasExe) { t.skip("exe not built - run npm run build:exe"); return; }
  // /exit ends the session, so it is allowed to say nothing.
  const silent = res.silent.filter((c) => c !== "/exit");
  assert.deepEqual(silent, [],
    "these commands print nothing at all:\n" + silent.join("\n"));
});
