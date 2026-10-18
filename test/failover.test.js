/**
 * Failover tests: a failing or throttled endpoint must hand over to a fallback
 * instead of ending the conversation, while genuine request errors are not
 * retried everywhere.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { ProviderRouter, isRetryable } from "../src/providers/router.js";

/** Backend whose behaviour is scripted per call. */
async function backend(script) {
  const state = { calls: [], script };
  const server = createServer((req, res) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      const body = JSON.parse(data || "{}");
      state.calls.push({ model: body.model, body });
      const step = state.script.length > 1 ? state.script.shift() : state.script[0];
      if (step === "hang") return; // never answers
      if (typeof step === "number") {
        res.writeHead(step, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: "scripted failure" } }));
        return;
      }
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: step } }] })}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { server, state, url: `http://127.0.0.1:${server.address().port}/v1` };
}

function routerFor(url, fallbacks, extra = {}) {
  const config = {
    provider: "openai",
    baseUrl: url,
    apiKey: "k",
    model: "primary-model",
    maxTokens: 64,
    temperature: 0,
    requestTimeoutMs: 0,
    ...extra
  };
  const switches = [];
  const router = new ProviderRouter({
    config,
    fallbacks,
    onSwitch: (cfg, reason, info) => switches.push({ model: cfg.model, reason, next: info?.next?.model })
  });
  return { router, config, switches };
}

test("classifies retryable failures", () => {
  assert.equal(isRetryable({ status: 429 }), true, "rate limit");
  assert.equal(isRetryable({ status: 503 }), true, "unavailable");
  assert.equal(isRetryable({ status: 500 }), true, "server error");
  assert.equal(isRetryable({ status: 401 }), true, "key may differ per candidate");
  assert.equal(isRetryable(new Error("fetch failed")), true, "network");
  assert.equal(isRetryable(new Error("rate limit exceeded")), true, "text signal");
  assert.equal(isRetryable({ status: 400 }), false, "bad request is permanent");
  assert.equal(isRetryable({ status: 422 }), false, "validation error");
  assert.equal(isRetryable({ name: "AbortError" }), false, "user cancelled");
});

test("a rate-limited primary hands over to the first fallback", async () => {
  const a = await backend([429]);
  const b = await backend(["from fallback"]);
  const { router, switches } = routerFor(a.url, [
    { model: "free-one", baseUrl: b.url, apiKey: "k2" }
  ]);
  try {
    const out = await router.streamChat({
      messages: [{ role: "user", content: "hi" }],
      tools: [],
      onDelta: () => {}
    });
    assert.equal(out.text, "from fallback");
    assert.equal(b.state.calls.at(-1).model, "free-one");
    assert.equal(router.switches, 1);
    assert.equal(switches[0].reason, "failing");
    assert.equal(switches[0].next, "free-one");
    // The chosen model is remembered for subsequent turns.
    assert.equal(router.model, "free-one");
    assert.equal(router.config.model, "free-one");
  } finally {
    await new Promise((r) => a.server.close(r));
    await new Promise((r) => b.server.close(r));
  }
});

test("a 500 on the fallback walks to the next candidate", async () => {
  const a = await backend([503]);
  const b = await backend([500]);
  const c = await backend(["third time lucky"]);
  const { router } = routerFor(a.url, [
    { model: "free-one", baseUrl: b.url },
    { model: "free-two", baseUrl: c.url }
  ]);
  try {
    const out = await router.streamChat({ messages: [{ role: "user", content: "hi" }], tools: [] });
    assert.equal(out.text, "third time lucky");
    assert.equal(router.model, "free-two");
    // `switches` counts adoptions, not attempts: the router only settles on a
    // candidate once, after that candidate has actually answered.
    assert.equal(router.switches, 1);
  } finally {
    for (const s of [a, b, c]) await new Promise((r) => s.server.close(r));
  }
});

test("a hanging endpoint times out and fails over", async () => {
  const a = await backend(["hang"]);
  const b = await backend(["rescued"]);
  const { router } = routerFor(a.url, [{ model: "free-one", baseUrl: b.url }], { requestTimeoutMs: 400 });
  try {
    const started = Date.now();
    const out = await router.streamChat({ messages: [{ role: "user", content: "hi" }], tools: [] });
    assert.equal(out.text, "rescued");
    assert.ok(Date.now() - started < 5000, "timeout fired instead of waiting forever");
  } finally {
    await new Promise((r) => a.server.close(r));
    await new Promise((r) => b.server.close(r));
  }
});

test("a bad request is surfaced immediately, without trying every model", async () => {
  const a = await backend([400]);
  const b = await backend(["should not be used"]);
  const { router } = routerFor(a.url, [{ model: "free-one", baseUrl: b.url }]);
  try {
    await assert.rejects(
      () => router.streamChat({ messages: [{ role: "user", content: "hi" }], tools: [] }),
      (e) => e.status === 400
    );
    assert.equal(b.state.calls.length, 0, "fallback was never contacted");
    assert.equal(router.switches, 0);
  } finally {
    await new Promise((r) => a.server.close(r));
    await new Promise((r) => b.server.close(r));
  }
});

test("when every candidate fails the last error is reported", async () => {
  const a = await backend([429]);
  const b = await backend([503]);
  const { router } = routerFor(a.url, [{ model: "free-one", baseUrl: b.url }]);
  try {
    await assert.rejects(
      () => router.streamChat({ messages: [{ role: "user", content: "hi" }], tools: [] }),
      (e) => e.status === 503
    );
  } finally {
    await new Promise((r) => a.server.close(r));
    await new Promise((r) => b.server.close(r));
  }
});

test("user cancellation is never turned into a failover", async () => {
  const a = await backend(["hang"]);
  const b = await backend(["should not be used"]);
  const { router } = routerFor(a.url, [{ model: "free-one", baseUrl: b.url }], { requestTimeoutMs: 0 });
  try {
    const controller = new AbortController();
    const pending = router.streamChat({
      messages: [{ role: "user", content: "hi" }],
      tools: [],
      signal: controller.signal
    });
    setTimeout(() => controller.abort(), 100);
    await assert.rejects(pending, (e) => e.name === "AbortError");
    assert.equal(b.state.calls.length, 0);
  } finally {
    await new Promise((r) => a.server.close(r));
    await new Promise((r) => b.server.close(r));
  }
});

test("duplicate candidates are not contacted twice", async () => {
  const a = await backend([429]);
  const { router } = routerFor(a.url, [{ model: "primary-model", baseUrl: a.url }]);
  try {
    await assert.rejects(() => router.streamChat({ messages: [{ role: "user", content: "hi" }], tools: [] }));
    assert.equal(router.candidates().length, 1, "same baseUrl+model collapses to one entry");
  } finally {
    await new Promise((r) => a.server.close(r));
  }
});
