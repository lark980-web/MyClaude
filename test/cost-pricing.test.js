/**
 * /cost pricing.
 *
 * The catalogue is the only price table. These tests pin the arithmetic, the
 * four-decimal display, and the fact that an unverifiable model reports a
 * notice instead of pretending to cost zero.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  MODELS,
  priceOfModel,
  estimateCostUsd,
  formatUsd,
  costLineFor,
  NO_PRICE_NOTICE,
} from "../src/models.js";

test("mainstream models carry both input and output rates", () => {
  for (const id of [
    "claude-3-7-sonnet",
    "claude-3-5-sonnet",
    "claude-3-5-haiku",
    "claude-3-opus",
    "gpt-4o",
    "gpt-4o-mini",
    "o1",
    "o3-mini",
    "gemini-2.5-flash",
    "gemini-2.0-flash",
    "deepseek-chat",
    "deepseek-reasoner",
  ]) {
    const price = priceOfModel(id);
    assert.ok(price, `${id} should have a verified price`);
    assert.ok(price.inputPrice > 0, `${id} input rate`);
    assert.ok(price.outputPrice > 0, `${id} output rate`);
  }
});

test("no entry is half-priced", () => {
  const partiallyPriced = MODELS.filter(
    (m) => (typeof m.inputPrice === "number") !== (typeof m.outputPrice === "number")
  );
  assert.deepEqual(partiallyPriced.map((m) => m.id), []);
});

test("cost is the input rate plus the output rate", () => {
  assert.equal(estimateCostUsd("claude-3-7-sonnet", 1_000_000, 0), 3);
  assert.equal(estimateCostUsd("claude-3-7-sonnet", 0, 1_000_000), 15);
  assert.equal(estimateCostUsd("claude-3-7-sonnet", 1_000_000, 1_000_000), 18);
  assert.equal(estimateCostUsd("gpt-4o-mini", 1_000_000, 1_000_000), 0.75);
  assert.equal(estimateCostUsd("gpt-4o", 1_000_000, 1_000_000), 12.5);

  const expected = (200_000 / 1e6) * 0.55 + (100_000 / 1e6) * 2.19;
  const actual = estimateCostUsd("deepseek-reasoner", 200_000, 100_000);
  assert.ok(Math.abs(actual - expected) < 1e-12, "reasoner cost");
});

test("unpriced models return null rather than zero", () => {
  assert.equal(priceOfModel("llama3.3:70b"), null);
  assert.equal(estimateCostUsd("llama3.3:70b", 10_000, 10_000), null);
  assert.equal(priceOfModel("does-not-exist"), null);
  assert.equal(estimateCostUsd("does-not-exist", 10_000, 10_000), null);
});

test("unpriced models explain the omission instead of n/a", () => {
  const line = costLineFor("llama3.3:70b", 1_234, 5_678);
  assert.equal(line, NO_PRICE_NOTICE);
  assert.match(line, /未配置价格/);
  assert.match(line, /token 用量/);
  assert.ok(!/n\/a/i.test(line), "the old n/a text must be gone");
  assert.notEqual(line, "$0.0000");
});

test("amounts always use exactly four decimals", () => {
  assert.equal(formatUsd(18), "$18.0000");
  assert.equal(formatUsd(0.08892), "$0.0889");
  assert.equal(costLineFor("claude-3-7-sonnet", 1_234, 5_678), "$0.0889");
  assert.match(costLineFor("gpt-4o", 1_000_000, 1_000_000), /^\$\d+\.\d{4}$/);
});
