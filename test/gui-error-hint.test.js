/**
 * Tests for the API-error humaniser added to the GUI.
 *
 * The function lives in the browser bundle (app.js), so the test extracts the
 * source and evaluates it in isolation: the logic is pure and has no DOM
 * dependency, which is exactly what makes it worth locking down.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const appSource = readFileSync(join(here, "..", "src", "ui", "web", "js", "app.js"), "utf8");

/** Pull one function out of the bundle and make it callable. */
function extractFunction(name) {
  const start = appSource.indexOf("function " + name + "(");
  assert.ok(start > 0, name + " should exist in app.js");
  // Walk braces to find the end of the function body.
  let depth = 0;
  let i = appSource.indexOf("{", start);
  const open = i;
  for (; i < appSource.length; i++) {
    const ch = appSource[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) break;
    }
  }
  const src = appSource.slice(start, i + 1);
  // eslint-disable-next-line no-new-func
  return new Function(src + "; return " + name + ";")();
}

const humanizeApiError = extractFunction("humanizeApiError");

test("a Chinese provider block message gets a risk-control hint", () => {
  const r = humanizeApiError(
    '{"error":{"message":"ZCode: 由于检测到异常活动，请求已被拦截。","type":"api_error"}}'
  );
  assert.equal(r.text, "ZCode: 由于检测到异常活动，请求已被拦截。");
  assert.match(r.hint, /风控/);
});

test("an English risk-control message is recognised too", () => {
  const r = humanizeApiError('{"error":{"message":"request blocked due to unusual activity (code 3012)"}}');
  assert.match(r.hint, /风控/);
});

test("an invalid key points at the provider settings", () => {
  const r = humanizeApiError('{"error":{"message":"Incorrect API key provided"}}');
  assert.match(r.hint, /API Key/);
});

test("a rate limit suggests waiting or switching model", () => {
  const r = humanizeApiError('{"error":{"message":"rate limit exceeded"}}');
  assert.match(r.hint, /频繁|备用模型/);
});

test("an insufficient balance suggests topping up", () => {
  const r = humanizeApiError('{"error":{"message":"insufficient balance"}}');
  assert.match(r.hint, /余额|充值/);
});

test("a missing model suggests picking another one", () => {
  const r = humanizeApiError('{"error":{"message":"当前模型不存在"}}');
  assert.match(r.hint, /模型菜单/);
});

test("a refused connection suggests checking the gateway", () => {
  const r = humanizeApiError("connect ECONNREFUSED 127.0.0.1:3425");
  assert.match(r.hint, /网关|代理|接口地址/);
});

test("a context-length error suggests /compact", () => {
  const r = humanizeApiError('{"error":{"message":"prompt is too long for this model"}}');
  assert.match(r.hint, /compact|上下文/);
});

test("an unrecognised error still returns the raw text and no hint", () => {
  const r = humanizeApiError("something odd happened");
  assert.equal(r.text, "something odd happened");
  assert.equal(r.hint, "");
});

test("a very long message is truncated instead of flooding the UI", () => {
  const long = "x".repeat(5000);
  const r = humanizeApiError(long);
  assert.ok(r.text.length <= 301, "truncated, got " + r.text.length);
  assert.ok(r.text.endsWith("…"));
});

test("a JSON payload without an error field falls back to the raw string", () => {
  const r = humanizeApiError('{"foo":"bar"}');
  assert.ok(r.text.length > 0);
});
