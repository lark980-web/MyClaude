import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bashTool } from "../src/tools/index.js";

/** Make a shell command that prints a lot of output on any platform. */
function loudCommand(lines) {
  // node -e is present everywhere this project runs and needs no shell quoting help.
  return `node -e "for(let i=0;i<${lines};i++)console.log('line '+i+' xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx')"`;
}

test("small output is returned as-is, nothing written to disk", async () => {
  const r = await bashTool.run({ command: "node --version" });
  assert.equal(r.ok, true);
  assert.match(r.content, /^v?\d+\.\d+/);
  assert.equal(r.persistedOutputPath, undefined);
});

test("oversized output is written to disk and the path is returned", async () => {
  const r = await bashTool.run({ command: loudCommand(1200) });
  assert.equal(r.ok, true);
  // The command printed ~48KB, well past the 30k threshold.
  assert.ok(r.persistedOutputPath, "a path was returned");
  assert.ok(r.persistedOutputSize > 30000, `size recorded: ${r.persistedOutputSize}`);
  assert.match(r.content, /完整输出已保存到/);

  // The file must hold the whole log, not the clipped version.
  const onDisk = readFileSync(r.persistedOutputPath, "utf8");
  assert.ok(onDisk.length > 30000, "file is complete");
  assert.match(onDisk, /line 1199/, "last line survived");
  // What the model sees is the head plus the pointer, so it must be short.
  assert.ok(r.content.length < onDisk.length, "returned text is the head, not the whole log");
  rmSync(r.persistedOutputPath, { force: true });
});

test("a non-zero exit still reports the failure it saw", async () => {
  const r = await bashTool.run({ command: "node -e \"process.exit(3)\"" });
  assert.equal(r.ok, false);
});
