import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { GATEWAY_BASE_URL, GATEWAY_KEY_ENV, DEFAULT_MODEL, contextWindowOf, maxTokensOf, MODELS } from "./models.js";

/**
 * Config location. `MYCLAUDE_HOME` overrides the default directory, which lets
 * tests run against a throw-away profile instead of the user's real settings.
 */
const CONFIG_DIR = process.env.MYCLAUDE_HOME ? join(process.env.MYCLAUDE_HOME) : join(homedir(), ".myclaude");
const CONFIG_FILE = join(CONFIG_DIR, "config.json");

/**
 * Free models used when the primary endpoint fails.
 *
 * Each entry is a complete provider override, so a fallback may live on another
 * host with its own key. They are tried in order and only on retryable failures
 * (rate limit, quota, 5xx, timeout, network error).
 *
 * NVIDIA NIM keys are read from `MYCLAUDE_NVIDIA_KEY` (or the first entry of
 * `MYCLAUDE_NVIDIA_KEYS`); set both to "" to disable the pool.
 */
const NVIDIA_BASE = "https://integrate.api.nvidia.com/v1";
const nvidiaKey = () => {
  const env = process.env.MYCLAUDE_NVIDIA_KEY || process.env.MYCLAUDE_NVIDIA_KEYS || "";
  return env.split(/[,\s]+/).filter(Boolean)[0] || "";
};

/** Gateway key from the first environment variable that is set. */
const gatewayKey = () => {
  for (const name of GATEWAY_KEY_ENV) {
    const v = process.env[name];
    if (v && v.trim()) { return v.trim(); }
  }
  return "";
};

/**
 * Failover pool drawn from the same gateway, so a rate limit on one vendor can
 * be served by another without a second endpoint or credential.
 */
const GATEWAY_FALLBACKS = [
  "group/auto-deepseek-v4-1-flash",
  "workbuddy-ai/deepseek-v4.1-flash",
  "amd/DeepSeek-V4.1-Flash",
  "opencode-zen/deepseek-v4.1-flash-free",
  "beatapi/deepseek-v4.1-flash-free",
].map((id) => ({ name: id, model: id, baseUrl: GATEWAY_BASE_URL, apiKey: "" }));

const defaultBaseUrl = process.env.MYCLAUDE_BASE_URL || (process.env.GEMINI_API_KEY ? "https://generativelanguage.googleapis.com/v1beta/openai" : GATEWAY_BASE_URL);
const defaultApiKey = process.env.MYCLAUDE_API_KEY || (process.env.GEMINI_API_KEY ? process.env.GEMINI_API_KEY : gatewayKey());

export const DEFAULT_CONFIG = {
  provider: "openai",
  activeProviderKey: process.env.GEMINI_API_KEY ? "gemini" : "gateway",
  baseUrl: defaultBaseUrl,
  apiKey: defaultApiKey,
  model: DEFAULT_MODEL,
  // Seconds to wait for a response before considering the endpoint dead.
  requestTimeoutMs: 90000,
  // Same-gateway failover pool: a rate limit on one vendor is served by another.
  fallbacks: GATEWAY_FALLBACKS,
  maxTokens: 8192,
  temperature: 0.7,
  permissionMode: "ask",
  vision: true,
  maxTurns: 100,
  // Resolved per model by the agent (see contextWindowOf); this is only the
  // value used before a model is chosen.
  contextWindow: contextWindowOf(DEFAULT_MODEL),
  compactThreshold: 0.8,
  mcpServers: {},
  providers: {}
};

export function ensureConfigDir() {
  if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true });
  return CONFIG_DIR;
}

export function loadConfig() {
  ensureConfigDir();
  let fileConfig = {};
  if (existsSync(CONFIG_FILE)) {
    try {
      fileConfig = JSON.parse(readFileSync(CONFIG_FILE, "utf8"));
    } catch {
      fileConfig = {};
    }
  }
  return {
    ...DEFAULT_CONFIG,
    ...fileConfig,
    activeProviderKey: fileConfig.activeProviderKey || (fileConfig.baseUrl?.includes("anthropic") ? "anthropic" : fileConfig.baseUrl?.includes("deepseek") ? "deepseek" : fileConfig.baseUrl?.includes("googleapis") ? "gemini" : DEFAULT_CONFIG.activeProviderKey),
    baseUrl: process.env.MYCLAUDE_BASE_URL || fileConfig.baseUrl || DEFAULT_CONFIG.baseUrl,
    apiKey: process.env.MYCLAUDE_API_KEY || fileConfig.apiKey || DEFAULT_CONFIG.apiKey,
    model: process.env.MYCLAUDE_MODEL || fileConfig.model || DEFAULT_CONFIG.model,
    provider: process.env.MYCLAUDE_PROVIDER || fileConfig.provider || DEFAULT_CONFIG.provider,
    providers: fileConfig.providers || {}
  };
}

export function saveConfig(patch) {
  ensureConfigDir();
  let current = {};
  if (existsSync(CONFIG_FILE)) {
    try {
      current = JSON.parse(readFileSync(CONFIG_FILE, "utf8"));
    } catch {
      current = {};
    }
  }
  const next = { ...current, ...patch };
  writeFileSync(CONFIG_FILE, JSON.stringify(next, null, 2), "utf8");
  return next;
}

export function configPath() {
  return CONFIG_FILE;
}

export { CONFIG_DIR };
