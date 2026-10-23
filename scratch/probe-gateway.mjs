// Probe the local gateway for each failover model id and print the real error.
const BASE = "http://127.0.0.1:3425/v1";
const KEY = process.env.MAGPIE_GATEWAY_KEY || process.env.DSH_GATEWAY_KEY || "";
const ids = [
  "group/auto-deepseek-v4-1-flash",
  "workbuddy-ai/deepseek-v4.1-flash",
  "amd/DeepSeek-V4.1-Flash",
  "opencode-zen/deepseek-v4.1-flash-free",
  "beatapi/deepseek-v4.1-flash-free",
  "qoder-cn/gfmodel",
];

for (const model of ids) {
  const started = Date.now();
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 30000);
    const r = await fetch(`${BASE}/chat/completions`, {
      method: "POST",
      signal: ctrl.signal,
      headers: { "content-type": "application/json", ...(KEY ? { authorization: `Bearer ${KEY}` } : {}) },
      body: JSON.stringify({ model, messages: [{ role: "user", content: "hi" }], max_tokens: 4 }),
    });
    clearTimeout(t);
    const text = await r.text();
    console.log(`${model}\n  -> ${r.status} ${Date.now() - started}ms  ${text.slice(0, 220)}`);
  } catch (e) {
    console.log(`${model}\n  -> FAILED ${Date.now() - started}ms  ${e.name}: ${e.message} ${e.cause?.code || ""}`);
  }
}
