// Verify the new failover pool: each candidate's effective timeout, then a
// real run() that must survive a hung first hop.
import { DEFAULT_CONFIG } from "../src/config.js";
import { createProvider } from "../src/providers/openai.js";
import { ProviderRouter } from "../src/providers/router.js";

const base = { ...DEFAULT_CONFIG, model: "group/auto-deepseek-v4-1-flash" };
console.log("--- effective timeouts");
for (const f of DEFAULT_CONFIG.fallbacks) {
  const p = createProvider({ ...base, ...f });
  console.log(`  ${f.model.padEnd(42)} ${p.timeoutMs / 1000}s`);
}

console.log("--- failover run from a hung first hop");
const cfg = { ...base };
const router = new ProviderRouter({
  config: cfg,
  fallbacks: DEFAULT_CONFIG.fallbacks,
  onSwitch: (c, reason, extra) => {
    if (reason === "failing") {
      console.log(`  ${c.model} failed (${extra.error?.status || extra.error?.message}) -> ${extra.next.model}`);
    } else {
      console.log(`  recovered with ${c.model}`);
    }
  },
});

const started = Date.now();
try {
  const res = await router.run((p) => p.listModels().then(() => p));
  console.log(`OK via ${res.model} in ${((Date.now() - started) / 1000).toFixed(1)}s`);
} catch (e) {
  console.log(`ALL FAILED after ${((Date.now() - started) / 1000).toFixed(1)}s: ${e.message}`);
}
