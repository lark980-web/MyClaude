#!/usr/bin/env node
/**
 * Inline the GUI sources into src/ui/assets.js so `bun build --compile` can
 * ship a single executable with the full interface inside.
 *
 * Run automatically by `npm run build`; safe to run any time (idempotent).
 * `node bin/myclaude.js --gui` keeps reading the files from disk, so this step
 * only matters for the standalone binary.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import * as esbuild from "esbuild";

const root = fileURLToPath(new URL("..", import.meta.url));
const ASSETS = join(root, "src", "ui", "assets.js");

const chartEntry = join(root, "src", "ui", "web", "js", "usage-chart.jsx");
const chartOut = join(root, "src", "ui", "web", "js", "usage-chart.js");
if (existsSync(chartEntry)) {
  esbuild.buildSync({
    entryPoints: [chartEntry],
    outfile: chartOut,
    bundle: true,
    format: "iife",
    platform: "browser",
    target: ["es2020"],
    minify: true,
    define: { "process.env.NODE_ENV": '"production"' }
  });
}

const FILES = {
  page: "src/ui/web/page.html",
  styles: "src/ui/web/css/styles.css",
  markdown: "src/ui/web/js/markdown.js",
  usageChart: "src/ui/web/js/usage-chart.js",
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

const raw = readFileSync(ASSETS, "utf8");

// 历史堆积清理：EMBEDDED 前的 banner 注释曾被逐轮追加到上百层，且存在
// 两代形态（3 行旧版 / 4 行新版）。行级状态机：`/**` 起始的注释若在
// 闭合前含有 banner 文本，整块删除（残渣孤立 `*/` 一并吞掉）。
let source = raw;
{
  const lines = raw.split(/\r?\n/);
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i] === "/**") {
      // 看这个注释块是否是 banner（闭合 ` */` 前含 banner 文本）
      let j = i + 1;
      let isBanner = false;
      for (; j < lines.length; j++) {
        if (lines[j].includes("Embedded copies of src/ui/web/*")) { isBanner = true; }
        if (lines[j] === " */" || lines[j] === "*/") { break; }
      }
      if (isBanner) {
        i = j; // 连同闭合行一起跳过
        continue;
      }
    }
    out.push(lines[i]);
  }
  source = out.join("\n");
}

// Replace the whole `const EMBEDDED = {...};` declaration, whatever preceded it.
// Matching the declaration (not a comment) keeps this script idempotent.
const declAt = source.indexOf("const EMBEDDED = {");
if (declAt < 0) throw new Error("assets.js has no EMBEDDED declaration to fill");
const start = declAt;
const end = source.indexOf("\n};", declAt);
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
