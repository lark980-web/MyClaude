import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.MYCLAUDE_HOME = mkdtempSync(join(tmpdir(), "myclaude-updesc-"));

const { toolSchemas, toolDescription, registerTools } = await import("../src/tools/index.js");
const { upstreamDescription } = await import("../src/tools/upstream-schemas.js");
const { EXTENDED_TOOLS } = await import("../src/tools/extended.js");
const { todoWriteTool, webFetchTool } = await import("../src/tools/extra.js");

// 扩展工具（NotebookEdit/WebSearch/...）与 extra 工具（TodoWrite/WebFetch）是运行时注册的，
// 默认不在 ALL_TOOLS 里 —— 先注册，断言才覆盖得到。
registerTools([...EXTENDED_TOOLS, todoWriteTool, webFetchTool]);

const doc = JSON.parse(readFileSync(new URL("../docs/tool-schemas-2.1.302.json", import.meta.url), "utf8"));
const list = doc.tools || doc;
const ADOPTED = ["Read", "Write", "Edit", "Glob", "Grep", "Bash", "TodoWrite", "NotebookEdit", "WebFetch"];

test("the upstream tool descriptions were extracted", () => {
  for (const name of ADOPTED) {
    const e = list.find((x) => x.name === name);
    assert.ok(e, name + " must exist in the extraction");
    assert.ok(typeof e.description === "string" && e.description.trim().length > 0,
      name + " must have a non-empty upstream description");
    assert.ok(e.descriptionSource, name + " must record how it was extracted");
  }
});

test("upstream descriptions reach the model-facing tool list", () => {
  const schemas = toolSchemas();
  for (const name of ADOPTED) {
    const t = schemas.find((x) => x.function.name === name);
    assert.ok(t, name + " must be in the tool list");
    const upstream = list.find((x) => x.name === name).description;
    assert.equal(t.function.description, upstream, name + " description must be upstream verbatim");
  }
});

test("tools without an upstream description keep MyClaude's own", () => {
  for (const name of ["LS", "MultiEdit", "GitStatus", "GitDiff", "GitLog", "GitCommit"]) {
    assert.equal(upstreamDescription(name), null, name + " has no upstream description");
    const t = toolSchemas().find((x) => x.function.name === name);
    assert.ok(t.function.description && t.function.description.length > 0,
      name + " must still carry a description");
  }
});

test("the upstream descriptions carry the behavioural guidance", () => {
  // 这两条是上游文案里对模型行为最有约束力的部分，自研概括给不出。
  const grep = upstreamDescription("Grep");
  assert.match(grep, /ALWAYS use Grep for search tasks/);
  assert.match(grep, /NEVER invoke `grep` or `rg` as a Bash command/);
  assert.match(grep, /multiline: true/);
  const glob = upstreamDescription("Glob");
  assert.match(glob, /Fast file pattern matching/);
  const todo = upstreamDescription("TodoWrite");
  assert.match(todo, /at least one task is in_progress at all times/);
});

test("the generated module stays in sync with the upstream extraction", () => {
  const gen = readFileSync(new URL("../scripts/gen-upstream-schemas.mjs", import.meta.url), "utf8");
  assert.match(gen, /description: entry\.description \|\| null/, "generator carries the description through");
  assert.match(gen, /export function upstreamDescription/, "generator emits the accessor");
});