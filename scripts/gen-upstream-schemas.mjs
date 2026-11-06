#!/usr/bin/env node
/**
 * 生成 MyClaude 的上游工具契约（代码层复刻 A 片段）。
 *
 * 事实来源：docs/tool-schemas-2.1.302.json —— AST 级从 claude-re-2.1.302 提取树抽出的
 * 上游内置工具 input_schema（含属性级描述词）。该 JSON 是唯一权威来源；
 * 03-features/tools-permissions.md 的 67 条表是启发式噪声（15 条 name 为 null、
 * 且不含 Write/Read/Glob 等核心工具），不要用。
 *
 * 本脚本做两件事：
 *   1) 按 DECISIONS 表逐工具决定「采用上游 / 合并 / 保留自研」，把决策固化在代码里；
 *   2) 产出 src/tools/upstream-schemas.js —— 一个纯 ESM 数据模块，
 *      bun --compile 能内联，双击 exe 不依赖 docs/ 目录。
 *
 * 用法：node scripts/gen-upstream-schemas.mjs [--check]
 *   --check 只比对现有产物是否与上游一致（CI 用，不写文件）。
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "docs", "tool-schemas-2.1.302.json");
const OUT = join(ROOT, "src", "tools", "upstream-schemas.js");

/**
 * 逐工具决策表。
 *
 * adopt  = 完全采用上游 properties/required，MyClaude 的 run() 无需改
 * merge  = 采用上游 properties，再并入 MyClaude 自有别名（run() 需同时认两套命名）
 * own    = 保留 MyClaude 自研契约（上游无此工具，或上游 schema 是运行时分支不可静态化简）
 *
 * merge 的 aliases：上游没有、但 MyClaude 的 run() 一直在用的字段。
 * 以别名形式并入，既不破坏既有行为，又让模型可以用上游命名。
 */
const DECISIONS = {
  Read:          { mode: "merge", aliases: { allow_large: { type: "boolean", description: "Set to true to read a text file, or a line range of one, that is over the usual size limits, up to what still fits in your context." } } },
  Write:         { mode: "adopt" },
  Edit:          { mode: "adopt" },
  Glob:          { mode: "adopt" },
  Grep:          { mode: "merge", aliases: {
                     i: { type: "boolean", description: "MyClaude 兼容别名：等同上游 -i（忽略大小写）。" },
                     n: { type: "boolean", description: "MyClaude 兼容别名：等同上游 -n（显示行号）。" },
                     A: { type: "number", description: "MyClaude 兼容别名：等同上游 -A（匹配行后上下文行数）。" },
                     B: { type: "number", description: "MyClaude 兼容别名：等同上游 -B（匹配行前上下文行数）。" },
                     C: { type: "number", description: "MyClaude 兼容别名：等同上游 -C（上下文行数）。" },
                     max_results: { type: "number", description: "MyClaude 兼容别名：等同上游 head_limit（最多返回条数）。" },
                   } },
  Bash:          { mode: "merge", aliases: {
                     cwd: { type: "string", description: "MyClaude 扩展：工作目录（上游无此参数）。" },
                     timeout_ms: { type: "number", description: "MyClaude 兼容别名：等同上游 timeout（毫秒）。" },
                     signal: { type: "string", description: "MyClaude 扩展：终止后台 shell 的信号名（上游无此参数）。" },
                   } },
  TodoWrite:     { mode: "adopt" },
  NotebookEdit:  { mode: "merge", aliases: {
                     cell_index: { type: "number", description: "MyClaude 扩展：按序号定位单元格（上游用 cell_id）。" },
                   } },
  WebFetch:      { mode: "merge", aliases: {
                     max_chars: { type: "number", description: "MyClaude 扩展：最多抓取字符数（上游无此参数）。" },
                   } },
  // 上游 schema 是运行时分支 getter（(){if(f())return A();return B()}），静态抽不出单一 schema
  WebSearch:     { mode: "own", reason: "upstream inputSchema is a runtime-branch getter; not statically reducible" },
  AskUserQuestion:{ mode: "own", reason: "upstream inputSchema is a runtime-branch getter; not statically reducible" },
  // 上游契约与 MyClaude 不同（上游 allowedPrompts vs MyClaude plan）
  ExitPlanMode:  { mode: "own", reason: "upstream contract is allowedPrompts; MyClaude uses plan" },
};

/** 上游抽取器留下的元数据键，不属于 JSON Schema，透传给模型会污染契约。 */
const META_KEYS = new Set(["x-spreads", "x-conditionals", "x-source", "x-evidence", "x-unresolved", "x-raw", "x-resolved-from", "x-conditional"]);

function stripMeta(node) {
  if (!node || typeof node !== "object") return node;
  if (Array.isArray(node)) return node.map(stripMeta);
  const out = {};
  for (const [k, v] of Object.entries(node)) {
    if (META_KEYS.has(k)) continue;
    out[k] = stripMeta(v);
  }
  return out;
}

/**
 * 属性名归一：上游用压缩标识符当计算键时，抽取器会写成 [computed:[X]]。
 * 少数情况下 x-raw 里留着真实键名（Read.allow_large 就是），能还原就还原。
 */
function normalizeKey(propName, prop) {
  if (!/^\[computed:/.test(propName)) return propName;
  const raw = prop && prop["x-raw"];
  if (typeof raw === "string") {
    const m = raw.match(/^"([A-Za-z_][A-Za-z0-9_]*)"$/);
    if (m) return m[1];
  }
  return null;
}

/** type:"unknown" 的属性不猜类型 —— 猜错比不写更糟。JSON Schema 允许只留 description。 */
function sanitizeProp(v) {
  if (!v || typeof v !== "object") return v;
  const out = { ...v };
  if (out.type === "unknown") delete out.type;
  return out;
}

function buildSchema(entry, decision) {
  const raw = entry.parameters;
  if (!raw) return null;
  const properties = {};
  const notes = {};
  for (const [k0, v0] of Object.entries(raw.properties || {})) {
    const k = normalizeKey(k0, v0) || k0;
    const v = sanitizeProp(stripMeta(v0));
    if (k0 !== k) notes["renamedProperties"] = Object.assign(notes["renamedProperties"] || {}, { [k0]: k });
    if (v0 && v0["x-unresolved"]) notes["unresolvedProperties"] = Object.assign(notes["unresolvedProperties"] || {}, { [k]: v0["x-raw"] });
    properties[k] = v;
  }
  const required = Array.isArray(raw.required) ? raw.required.map((r) => normalizeKey(r, raw.properties && raw.properties[r]) || r) : [];
  const schema = { type: "object", properties, required, additionalProperties: raw.additionalProperties !== false };
  if (decision.mode === "merge" && decision.aliases) {
    for (const [k, v] of Object.entries(decision.aliases)) {
      if (!properties[k]) { properties[k] = v; notes["myClaudeAliases"] = Object.assign(notes["myClaudeAliases"] || {}, { [k]: true }); }
    }
  }
  if (raw["x-spreads"]) notes["upstreamSpreads"] = raw["x-spreads"];
  if (raw["x-conditionals"]) notes["upstreamConditionals"] = raw["x-conditionals"];
  return { schema, notes };
}

function main() {
  const check = process.argv.includes("--check");
  if (!existsSync(SRC)) { console.error("missing source: " + SRC); process.exit(1); }
  const upstream = JSON.parse(readFileSync(SRC, "utf8"));
  const list = upstream.tools || upstream;
  const byName = new Map(list.map((t) => [t.name, t]));
  const out = {};
  const decisions = [];
  for (const [name, d] of Object.entries(DECISIONS)) {
    const entry = byName.get(name);
    if (!entry) { decisions.push({ name, mode: "own", reason: "not present in upstream extraction" }); continue; }
    if (d.mode === "own") { decisions.push({ name, mode: "own", reason: d.reason || "kept MyClaude contract" }); continue; }
    const built = buildSchema(entry, d);
    if (!built) { decisions.push({ name, mode: "own", reason: "upstream has no static parameters" }); continue; }
    out[name] = {
      schema: built.schema,
      notes: built.notes,
      source: entry.source,
      searchHint: entry.searchHint || null,
      // 工具级描述词：上游运行时真实取值（见 docs/tool-schemas-2.1.302.json 的 _meta.descriptions）
      description: entry.description || null,
    };
    decisions.push({ name, mode: d.mode, required: built.schema.required, properties: Object.keys(built.schema.properties) });
  }
  const payload = {
    _meta: {
      generatedBy: "scripts/gen-upstream-schemas.mjs",
      upstreamSource: "docs/tool-schemas-2.1.302.json",
      upstreamVersion: upstream._meta ? upstream._meta.version : "2.1.302",
      note: "MyClaude 的工具契约（description 之外的参数面）逐字采用上游；run() 执行体仍是 MyClaude 自研。",
      decisions,
    },
    tools: out,
  };
  const text = [
    "// 本文件由 scripts/gen-upstream-schemas.mjs 生成，请勿手改。",
    "// 上游事实来源：docs/tool-schemas-2.1.302.json（AST 级抽取，Claude Code 2.1.302）。",
    "",
    "export const UPSTREAM_TOOL_SCHEMAS = " + JSON.stringify(payload, null, 2) + ";",
    "",
    "/** 取某工具的上游契约；没有则返回 null（调用方保留自研 schema）。 */",
    "export function upstreamSchema(name) {",
    "  const e = UPSTREAM_TOOL_SCHEMAS.tools[name];",
    "  return e ? e.schema : null;",
    "}",
    "",
    "/** 取某工具的上游描述词；没有则返回 null（调用方保留自研描述词）。 */",
    "export function upstreamDescription(name) {",
    "  const e = UPSTREAM_TOOL_SCHEMAS.tools[name];",
    "  return e && e.description ? e.description : null;",
    "}",
    "",
    "/** 该工具是否采用/合并了上游契约。 */",
    "export function usesUpstreamSchema(name) {",
    "  return Boolean(UPSTREAM_TOOL_SCHEMAS.tools[name]);",
    "}",
    "",
  ].join("\n");
  if (check) {
    if (!existsSync(OUT)) { console.error("missing generated file: " + OUT); process.exit(1); }
    const cur = readFileSync(OUT, "utf8");
    if (cur !== text) { console.error("OUT OF DATE: " + OUT); process.exit(1); }
    console.log("upstream-schemas.js 与上游一致");
    return;
  }
  writeFileSync(OUT, text, "utf8");
  console.log("wrote " + OUT + "  (" + Object.keys(out).length + " tools adopted/merged)");
}

main();