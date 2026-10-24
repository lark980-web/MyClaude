/**
 * Provider routing with automatic failover.
 *
 * A single endpoint failing should not end the conversation. When a request
 * fails for a reason that a *different* model might survive (rate limit, quota,
 * 5xx, timeout, network error), the router walks a list of fallbacks until one
 * answers. Errors that indicate a broken request (400, 422, auth on every
 * candidate) are surfaced immediately instead of being retried everywhere.
 *
 * The router owns nothing but the fallback list; each candidate is a full
 * provider config so a fallback may live on a different host with a different
 * key, not just a different model name.
 */

import { createProvider, ProviderError } from "./openai.js";

/** Status codes worth retrying on another model. */
const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504, 529]);

/** Error text that signals a transient problem even without a status code. */
const RETRYABLE_PATTERN =
  /rate.?limit|too many requests|quota|capacity|overloaded|temporarily unavailable|timeout|timed out/i;

/**
 * Decide whether a failed attempt is worth retrying elsewhere.
 *
 * @param {Error & {status?: number}} error
 * @returns {boolean}
 */
export function isRetryable(error) {
  if (!error) return false;
  const status = Number(error.status || error.code || 0);
  if (RETRYABLE_STATUS.has(status)) return true;
  // Auth problems are permanent for this credential but a sibling candidate
  // may use a different key, so they are treated as retryable too.
  if (status === 401 || status === 403) return true;
  if (status >= 500) return true;
  if (error.name === "AbortError") return false; // the user cancelled
  if (error.name === "TypeError" || /fetch failed|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|EAI_AGAIN/i.test(String(error.message))) {
    return true;
  }
  return RETRYABLE_PATTERN.test(String(error.message || ""));
}

/** Human-readable reason for a failed attempt. */
function describe(error) {
  const status = error && (error.status || error.code);
  const msg = String((error && error.message) || error || "unknown error");
  const short = msg.replace(/\s+/g, " ").slice(0, 160);
  return status ? `${status} ${short}` : short;
}

export class ProviderRouter {
  /**
   * @param {object} options
   * @param {object} options.config        live config object (mutated on switch)
   * @param {Array<object>} [options.fallbacks] additional provider configs
   * @param {(msg: string, kind?: string) => void} [options.onSwitch]
   */
  constructor({ config, fallbacks = [], onSwitch = null, provider = null } = {}) {
    this.config = config;
    // Whole-walk budget: per-attempt timers bound one candidate, but six of
    // them in a row still meant many minutes of silence before an error.
    this.failoverBudgetMs = Number(config.failoverBudgetMs ?? 300_000);
    this.onSwitch = onSwitch;
    // Fallbacks without a usable endpoint are dropped rather than failing later.
    this.fallbacks = fallbacks.filter((f) => f && f.model && (f.baseUrl || config.baseUrl));
    // Reuse the caller's provider when given: agents already build one and tests
    // often construct it from a partial config.
    this.provider = provider || createProvider(config);
    this.switches = 0;
    this.switchedAt = null;
    this.lastError = null;
  }

  /** The provider used for the next request. */
  get active() {
    return this.provider;
  }

  get model() {
    return this.provider.model;
  }

  /**
   * Ordered attempts for one request: the current config first, then every
   * fallback that is not already in the list.
   */
  candidates() {
    const seen = new Set();
    const out = [];
    const push = (cfg) => {
      // A candidate needs something to call. Unit tests inject a bare provider
      // object with no model/baseUrl, which is still a valid single candidate.
      const model = cfg.model || this.provider.model || "";
      const key = `${cfg.baseUrl || ""}|${model}`;
      if (seen.has(key)) return;
      seen.add(key);
      out.push({ ...cfg, model });
    };
    // A provider may have been built without a config.baseUrl (unit tests do
    // this); fall back to whatever the live provider resolved.
    const base = { ...this.config, baseUrl: this.config.baseUrl || this.provider.baseUrl };
    push({ ...base, model: this.provider.model });
    for (const f of this.fallbacks) push({ ...base, ...f });
    return out;
  }

  /** Adopt a candidate: rebuild the provider and remember the choice. */
  use(cfg, reason) {
    this.provider = createProvider({ ...this.config, ...cfg });
    this.config.model = this.provider.model;
    this.config.baseUrl = this.provider.baseUrl;
    if (cfg.apiKey) this.config.apiKey = cfg.apiKey;
    this.switches++;
    this.switchedAt = new Date().toISOString();
    if (this.onSwitch) this.onSwitch(cfg, reason);
  }

  /**
   * Run an operation against each candidate until one succeeds.
   *
   * @template T
   * @param {(provider: object) => Promise<T>} fn
   * @returns {Promise<T>}
   */
  async run(fn) {
    const list = this.candidates();
    let lastError = null;
    const startedAt = Date.now();
    for (let i = 0; i < list.length; i++) {
      if (i > 0 && this.failoverBudgetMs > 0 && Date.now() - startedAt > this.failoverBudgetMs) {
        // Give up loudly rather than walking candidate after candidate in
        // silence; the caller shows this message instead of a hung spinner.
        throw new ProviderError(
          `failover budget exhausted after ${i} attempt(s) (${Math.round((Date.now() - startedAt) / 1000)}s): ${lastError ? lastError.message : "unknown"}`,
          { status: 504 }
        );
      }
      const cfg = list[i];
      const provider = i === 0 ? this.provider : createProvider({ ...this.config, ...cfg });
      try {
        const result = await fn(provider);
        if (i > 0) this.use(cfg, "recovered");
        return result;
      } catch (e) {
        // Never swallow an explicit cancellation.
        if (e && e.name === "AbortError") throw e;
        lastError = e;
        this.lastError = e;
        const more = i < list.length - 1;
        if (!more || !isRetryable(e)) throw e;
        if (this.onSwitch) this.onSwitch(cfg, "failing", { next: list[i + 1], error: e });
      }
    }
    throw lastError || new ProviderError("no provider candidates configured");
  }

  /** Convenience wrapper for the chat call used by the agent. */
  streamChat(args) {
    return this.run((provider) => provider.streamChat(args));
  }

  /**
   * Single non-streaming completion, used for summaries and other internal
   * one-shot prompts.
   *
   * maybeCompact() called this and swallowed the resulting TypeError, so the
   * "summarise with the model" path never actually ran and every compaction
   * fell back to plain truncation.
   */
  complete(args) {
    return this.run((provider) => {
      if (typeof provider.complete === "function") { return provider.complete(args); }
      throw new Error("provider does not implement complete()");
    });
  }

  /** listModels across candidates. */
  listModels() {
    return this.run((provider) => provider.listModels());
  }

  status() {
    return {
      model: this.model,
      baseUrl: this.provider.baseUrl,
      candidates: this.candidates().map((c) => ({ model: c.model, baseUrl: c.baseUrl })),
      switches: this.switches,
      switchedAt: this.switchedAt,
      lastError: this.lastError ? describe(this.lastError) : null
    };
  }
}

export { describe as describeProviderError };
