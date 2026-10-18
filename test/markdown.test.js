/**
 * Unit tests for the browser Markdown renderer.
 *
 * The file is written as a classic script (it must run from a <script> tag with
 * no bundler), so the test loads it through `new Function` instead of import.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SOURCE = readFileSync(fileURLToPath(new URL("../src/ui/web/js/markdown.js", import.meta.url)), "utf8");

/** Evaluate the script in a bare sandbox and return the exported API. */
function load() {
  const mod = { exports: {} };
  const fn = new Function("module", "exports", SOURCE + "\nreturn module.exports;");
  return fn(mod, mod.exports);
}

const md = load();

test("headings and paragraphs", () => {
  assert.equal(md.render("# Title"), "<h1>Title</h1>");
  assert.equal(md.render("### Deep"), "<h3>Deep</h3>");
  assert.equal(md.render("one\n\ntwo"), "<p>one</p>\n<p>two</p>");
});

test("inline emphasis, code and strikethrough", () => {
  const html = md.render("a **bold** *it* ~~gone~~ \`code\` b");
  assert.match(html, /<strong>bold<\/strong>/);
  assert.match(html, /<em>it<\/em>/);
  assert.match(html, /<del>gone<\/del>/);
  assert.match(html, /<code class="inline">code<\/code>/);
});

test("unordered, ordered and task lists", () => {
  assert.equal(md.render("- a\n- b"), "<ul><li>a</li><li>b</li></ul>");
  assert.equal(md.render("1. a\n2. b"), "<ol><li>a</li><li>b</li></ol>");
  const tasks = md.render("- [x] done\n- [ ] todo");
  assert.match(tasks, /class="task done"/);
  assert.match(tasks, /class="task"/);
});

test("tables render headers and rows", () => {
  const html = md.render("| a | b |\n|---|---|\n| 1 | 2 |");
  assert.match(html, /<table>/);
  assert.match(html, /<th>a<\/th>/);
  assert.match(html, /<td>1<\/td>/);
});

test("fenced code is highlighted and labelled", () => {
  const html = md.render("\`\`\`js\nconst x = 1;\n\`\`\`");
  assert.match(html, /class="codeblock"/);
  assert.match(html, /class="cb-lang">js</);
  assert.match(html, /token|tok-k/);
  assert.match(html, /data-copy/);
});

test("blockquotes and horizontal rules", () => {
  assert.match(md.render("> quoted"), /<blockquote><p>quoted<\/p><\/blockquote>/);
  assert.match(md.render("a\n\n---\n\nb"), /<hr>/);
});

test("html in the source is escaped, not executed", () => {
  const html = md.render("<script>alert(1)</script>");
  assert.ok(!html.includes("<script>"));
  assert.match(html, /&lt;script&gt;/);
  assert.ok(!md.render('<img src=x onerror="alert(1)">').includes("<img"));
});

test("javascript: urls are rejected in links and images", () => {
  const link = md.render("[x](javascript:alert(1))");
  assert.ok(!/href="javascript:/i.test(link), "no executable href");
  assert.match(link, /href="#blocked-/, "rewritten to an inert anchor");

  const img = md.render("![x](javascript:alert(1))");
  assert.ok(!/src="javascript:/i.test(img), "no executable src");

  // data: is only tolerated for images, never for navigation
  assert.ok(!/href="data:/i.test(md.render("[x](data:text/html,<b>hi</b>)")));
  assert.ok(!/href="vbscript:/i.test(md.render("[x](vbscript:msgbox)")));
});

test("safe links and images survive", () => {
  const link = md.render("[docs](https://example.com)");
  assert.match(link, /href="https:\/\/example\.com"/);
  assert.match(link, /rel="noopener noreferrer"/);
  assert.match(md.render("![alt](https://e.com/a.png)"), /<img src="https:\/\/e\.com\/a\.png"/);
});

test("toText flattens markdown for titles", () => {
  const out = md.toText("# T\n\nsome **bold** [link](https://x.y) and `code`");
  assert.equal(out.includes("#"), false);
  assert.ok(out.includes("bold"));
  assert.ok(out.includes("link"));
  assert.ok(out.includes("code"));
});

test("the highlighter escapes code before colouring", () => {
  const html = md.highlight("if (a < b) { return \"<x>\"; }", "js");
  assert.ok(!html.includes("<x>"));
  assert.match(html, /&lt;x&gt;/);
});
