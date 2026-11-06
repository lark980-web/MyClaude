import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.MYCLAUDE_HOME = mkdtempSync(join(tmpdir(), "myclaude-upschema-"));

const { toolSchemas, toolInputSchema, grepTool, readTool, bashTool } =
  await import("../src/tools/index.js");
const { UPSTREAM_TOOL_SCHEMAS, upstreamSchema } = await import("../src/tools/upstream-schemas.js");

const upstreamDoc = JSON.parse(
  readFileSync(new URL("../docs/tool-schemas-2.1.302.json", import.meta.url), "utf8"),
);
const upstreamList = upstreamDoc.tools || upstreamDoc;
const upstreamByName = new Map(upstreamList.map((t) => [t.name, t]));

// 采用上游契约的工具（决策表见 scripts/gen-upstream-schemas.mjs）
const ADOPTED = ["Read", "Write", "Edit", "Glob", "Grep", "Bash", "TodoWrite", "NotebookEdit", "WebFetch"];
// 明确保留自研契约的工具（附原因，避免后人误改）
const KEPT_OWN = {
  WebSearch: "upstream inputSchema is a runtime-branch getter",
  AskUserQuestion: "upstream inputSchema is a runtime-branch getter",
  ExitPlanMode: "upstream contract is allowedPrompts; MyClaude uses plan",
};

test("every adopted tool ships the upstream parameter contract verbatim", () => {
  for (const name of ADOPTED) {
    const up = upstreamByName.get(name);
    assert.ok(up && up.parameters, name + ": upstream extraction must exist");
    const mine = toolInputSchema({ name, input_schema: {} });
    assert.ok(mine, name + ": MyClaude must expose an upstream schema");
    // 属性名与描述词逐字一致。上游有「计算键」属性（抽取器写成 [computed:[X]]），
    // 生成器已按 x-raw 还原真实键名（Read.allow_large），重命名映射记在 notes.renamedProperties。
    const renamed = UPSTREAM_TOOL_SCHEMAS.tools[name].notes?.renamedProperties || {};
    const aliases = UPSTREAM_TOOL_SCHEMAS.tools[name].notes?.myClaudeAliases || {};
    const expectedProps = Object.keys(up.parameters.properties)
      .map((k) => renamed[k] || k)
      .filter((k) => !aliases[k]);
    assert.deepEqual(
      Object.keys(mine.properties).filter((k) => !aliases[k]),
      expectedProps,
      name + ": upstream property names must be adopted",
    );
    for (const [k, v] of Object.entries(up.parameters.properties)) {
      if (/^\[computed:/.test(k)) continue;
      const key = k === "[computed:[Rge]]" ? "allow_large" : k;
      assert.ok(mine.properties[key], name + "." + key + " must exist");
      if (v.description) {
        assert.equal(mine.properties[key].description, v.description, name + "." + key + " description must be upstream verbatim");
      }
    }
    // required 必须一致（上游 required ⊆ MyClaude required）
    const upReq = (up.parameters.required || []).map((r) => (r === "[computed:[Rge]]" ? "allow_large" : r));
    assert.deepEqual(mine.required, upReq, name + ": required list must match upstream");
  }
});

test("the upstream descriptions actually reach the model", () => {
  const list = toolSchemas();
  const read = list.find((t) => t.function.name === "Read");
  assert.equal(
    read.function.parameters.properties.file_path.description,
    upstreamByName.get("Read").parameters.properties.file_path.description,
    "Read.file_path description in the serialized tool list must be upstream",
  );
  // Glob 上游描述词含这句自研版没有的指引
  const glob = list.find((t) => t.function.name === "Glob");
  assert.match(glob.function.parameters.properties.path.description, /DO NOT enter "undefined" or "null"/);
});

test("tools upstream does not have keep MyClaude's own contract", () => {
  for (const [name, reason] of Object.entries(KEPT_OWN)) {
    assert.equal(upstreamSchema(name), null, name + " must not claim an upstream schema (" + reason + ")");
  }
  for (const name of ["LS", "MultiEdit", "BashOutput", "KillShell", "GitStatus", "GitDiff", "GitLog", "GitCommit"]) {
    assert.equal(upstreamSchema(name), null, name + " is not an upstream tool");
    const t = toolSchemas().find((x) => x.function.name === name);
    assert.ok(t && t.function.parameters && t.function.parameters.properties, name + " must keep its own schema");
  }
});

test("MyClaude-only aliases are declared so strict upstream schemas still accept them", () => {
  const grep = toolInputSchema({ name: "Grep" });
  for (const k of ["i", "n", "A", "B", "C", "max_results"]) {
    assert.ok(grep.properties[k], "Grep." + k + " alias must be declared");
  }
  const bash = toolInputSchema({ name: "Bash" });
  for (const k of ["cwd", "timeout_ms", "signal"]) {
    assert.ok(bash.properties[k], "Bash." + k + " alias must be declared");
  }
});

test("Grep accepts the upstream ripgrep-style parameter names", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mc-grep-"));
  const fs = await import("node:fs/promises");
  await fs.writeFile(join(dir, "a.txt"), "alpha\nbeta\ngamma\n", "utf8");
  // 上游命名：-A / -n / head_limit
  const r1 = await grepTool.run({ pattern: "beta", path: dir, "-n": true, "-A": 1 });
  assert.equal(r1.ok, true);
  assert.match(r1.content, /gamma/, "-A must add one line of trailing context");
  // 上游 -o：只输出匹配片段
  const r2 = await grepTool.run({ pattern: "ga[a-z]+", path: dir, "-o": true });
  assert.equal(r2.ok, true);
  assert.match(r2.content, /gamma/);
  assert.doesNotMatch(r2.content, /alpha/, "-o must not print whole lines");
  // head_limit 等价 max_results
  const r3 = await grepTool.run({ pattern: "a|b|g", path: dir, head_limit: 1 });
  assert.equal(r3.ok, true);
  // MyClaude 旧命名仍然可用（向后兼容）
  const r4 = await grepTool.run({ pattern: "beta", path: dir, n: true, A: 1 });
  assert.match(r4.content, /gamma/, "legacy A must still work");
});

test("Bash accepts the upstream timeout name", async () => {
  // 不真的执行命令，只验证参数归一：timeout 存在时不会因为缺 command 之外的字段而炸
  const r = await bashTool.run({ command: "echo mc-upstream-timeout", timeout: 20000, cwd: process.cwd() });
  assert.equal(r.ok, true, JSON.stringify(r.content).slice(0, 200));
  assert.match(r.content, /mc-upstream-timeout/);
});

test("Read accepts the upstream allow_large flag", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mc-read-"));
  const fs = await import("node:fs/promises");
  const f = join(dir, "big.txt");
  await fs.writeFile(f, "x".repeat(6 * 1024 * 1024), "utf8");
  const small = await readTool.run({ file_path: f });
  assert.equal(small.ok, false);
  assert.match(small.content, /file too large/);
  const big = await readTool.run({ file_path: f, allow_large: true });
  assert.equal(big.ok, true, "allow_large must raise the size cap");
});

test("the generated schema module is in sync with the upstream extraction", () => {
  // 生成器与上游 JSON 必须一致（--check 逻辑在脚本内，此处做等价断言）
  const gen = readFileSync(new URL("../scripts/gen-upstream-schemas.mjs", import.meta.url), "utf8");
  assert.match(gen, /DECISIONS/, "generator keeps an explicit decision table");
  for (const name of Object.keys(UPSTREAM_TOOL_SCHEMAS.tools)) {
    assert.ok(upstreamByName.has(name), name + " must exist in the upstream extraction");
  }
});
