import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { estimateTextTokens } from "../src/tokens.js";

const CN = "你是一位资深全栈软件架构师，在回答问题和编写代码时请遵循以下原则：先给出架构思路与模块边界，再提供高内聚低耦合的实现代码；优先考虑可维护性、类型安全、边界异常处理与性能开销。";

test("Chinese is not underestimated the way chars/4 does", () => {
  const est = estimateTextTokens(CN);
  const naive = Math.ceil(CN.length / 4);
  assert.ok(est > naive * 2, "CJK must exceed the naive estimate: " + est + " vs " + naive);
  // 中文实际约 1 字符 1 token，估算落在这个量级即可
  assert.ok(est >= CN.length * 0.7, "close to one token per character: " + est + " / " + CN.length);
});

test("English keeps the usual four-characters-per-token figure", () => {
  const en = "The quick brown fox jumps over the lazy dog and keeps on running.";
  const est = estimateTextTokens(en);
  assert.ok(est >= Math.ceil(en.length / 5) && est <= Math.ceil(en.length / 3.5), "sane for latin text: " + est);
});

test("mixed text counts both sides", () => {
  const mixed = "请 review 这个 function 的实现是否 safe。";
  const est = estimateTextTokens(mixed);
  assert.ok(est > 0 && est <= mixed.length, "between 1 per char and 1 per 4 chars: " + est);
});

test("empty and non-string inputs are safe", () => {
  assert.equal(estimateTextTokens(""), 0);
  assert.equal(estimateTextTokens(null), 0);
  assert.equal(estimateTextTokens(undefined), 0);
  assert.ok(estimateTextTokens(12345) > 0, "numbers stringify");
});

test("no naive per-character estimation is left in the token display paths", () => {
  for (const f of ["../src/ui/gui-server.js", "../src/ui/web/js/app.js", "../src/agent/agent.js"]) {
    const src = readFileSync(new URL(f, import.meta.url), "utf8");
    const bad = src.match(/Math\.ceil\([^)]*\.length \/ 4\)/g) || [];
    assert.deepEqual(bad, [], f + " still has naive estimates: " + bad.join(", "));
  }
});

test("the GUI mirrors the same formula as src/tokens.js", () => {
  const app = readFileSync(new URL("../src/ui/web/js/app.js", import.meta.url), "utf8");
  const i = app.indexOf("function estimateTextTokens");
  assert.ok(i > 0, "GUI has its own copy");
  const fn = app.slice(i, i + 600);
  assert.ok(fn.includes("cjk + Math.ceil((t.length - cjk) / 4)"), "identical formula");
});
