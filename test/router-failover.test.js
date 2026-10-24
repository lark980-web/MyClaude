/**
 * Failover budget and retry classification.
 *
 * The chain used to be bounded only by each attempt's own timer, so six
 * candidates at 90s each meant a user waited many minutes of silence before
 * an error. The router now carries an overall budget for the walk.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { ProviderRouter, isRetryable } from "../src/providers/router.js";
import { ProviderError } from "../src/providers/openai.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("the failover walk stops when the budget is spent", async () => {
  const called = [];
  const primary = {
    async streamChat() {
      called.push("primary");
      await sleep(150);
      throw new ProviderError("429 too many requests", { status: 429 });
    },
  };
  const config = { model: "primary", baseUrl: "http://primary/v1", failoverBudgetMs: 50 };
  const router = new ProviderRouter({
    config,
    provider: primary,
    fallbacks: [
      { model: "second", baseUrl: "http://127.0.0.1:1/v1" },
    ],
  });
  await assert.rejects(
    router.streamChat({ messages: [{ role: "user", content: "hi" }] }),
    (e) => /budget/i.test(e.message || ""),
    "the walk must give up instead of trying candidate after candidate"
  );
  assert.deepEqual(called, ["primary"], "the second candidate was never tried");
});

test("a silent-stream error counts as retryable", () => {
  const e = new ProviderError("stream idle: no data for 120s (timed out)", { status: 408 });
  assert.equal(isRetryable(e), true);
  assert.equal(isRetryable(new ProviderError("bad key", { status: 401 })), true,
    "auth failures may survive on a sibling candidate");
  assert.equal(isRetryable(new ProviderError("no such model", { status: 404 })), false);
});
