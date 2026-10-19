/**
 * Vendor identification tests.
 *
 * The endpoint is the authoritative signal; the model name is only consulted
 * when the host is a gateway that proxies several vendors (which is exactly the
 * local-gateway case).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { vendorFromUrl, endpointLabel } from "../src/vendors.js";

test("known hosts map to their vendor", () => {
  assert.equal(vendorFromUrl("https://api.deepseek.com/v1", "whatever"), "DeepSeek");
  assert.equal(vendorFromUrl("https://open.bigmodel.cn/api/paas/v4", "glm-4"), "智谱");
  assert.equal(vendorFromUrl("https://dashscope.aliyuncs.com/compatible-mode/v1", "qwen-max"), "阿里通义");
  assert.equal(vendorFromUrl("https://api.moonshot.cn/v1", "kimi-k2"), "月之暗面");
  assert.equal(vendorFromUrl("https://api.anthropic.com/v1", "claude-3-5-sonnet"), "Anthropic");
  assert.equal(vendorFromUrl("https://api.openai.com/v1", "gpt-4o"), "OpenAI");
  assert.equal(vendorFromUrl("https://integrate.api.nvidia.com/v1", "meta/llama-3.1"), "NVIDIA");
});

test("a local gateway falls back to the model name", () => {
  // The host says nothing when it proxies many vendors, so the model name must
  // decide; otherwise every model would land in one useless group.
  assert.equal(vendorFromUrl("http://127.0.0.1:8000/v1", "deepseek-v4.1-flash"), "DeepSeek");
  assert.equal(vendorFromUrl("http://localhost:8000/v1", "glm-5.3"), "智谱");
  assert.equal(vendorFromUrl("http://192.168.1.5:8000/v1", "kimi-k2.8"), "月之暗面");
  assert.equal(vendorFromUrl("http://127.0.0.1:8000/v1", "gpt-5.6-sol"), "OpenAI");
});

test("unrecognised models on a local gateway stay under the gateway", () => {
  assert.equal(vendorFromUrl("http://127.0.0.1:8000/v1", "my-internal-model"), "本地网关");
  assert.equal(vendorFromUrl("http://127.0.0.1:8000/v1", ""), "本地网关");
});

test("unknown remote hosts fall back to model name, then hostname", () => {
  assert.equal(vendorFromUrl("https://example-ai.com/v1", "llama-3.1-8b"), "Meta");
  assert.equal(vendorFromUrl("https://example-ai.com/v1", "totally-unknown"), "example-ai.com");
});

test("vendor/model style names resolve", () => {
  assert.equal(vendorFromUrl("http://127.0.0.1:8000/v1", "Qwen/Qwen2.5-72B"), "阿里通义");
  assert.equal(vendorFromUrl("http://127.0.0.1:8000/v1", "z-ai/glm-5.3-flash"), "智谱");
});

test("endpointLabel marks gateways and keeps the host", () => {
  assert.equal(endpointLabel("http://127.0.0.1:8000/v1"), "本地网关 · 127.0.0.1:8000");
  assert.equal(endpointLabel("https://api.deepseek.com/v1"), "api.deepseek.com");
  assert.equal(endpointLabel(""), "未配置");
});
