import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

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

export const DEFAULT_CONFIG = {
  provider: "openai",
  baseUrl: "http://127.0.0.1:8000/v1",
  apiKey: "wb-local-8888",
  model: "deepseek-v4.1-flash",
  // Seconds to wait for a response before considering the endpoint dead.
  requestTimeoutMs: 90000,
  // Free fallbacks, verified to support tool calling.
  fallbacks: [
    { name: "gpt-oss-20b", baseUrl: NVIDIA_BASE, apiKey: nvidiaKey(), model: "openai/gpt-oss-20b" },
    { name: "glm-5.3-flash", baseUrl: NVIDIA_BASE, apiKey: nvidiaKey(), model: "z-ai/glm-5.3-flash" },
    { name: "llama-3.2-11b-vision", baseUrl: NVIDIA_BASE, apiKey: nvidiaKey(), model: "meta/llama-3.2-11b-vision-instruct" }
  ],
  maxTokens: 8192,
  temperature: 0.7,
  permissionMode: "ask",
  vision: true,
  maxTurns: 100,
  contextWindow: 1000000,
  compactThreshold: 0.8,
  mcpServers: {},
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
    baseUrl: process.env.MYCLAUDE_BASE_URL || fileConfig.baseUrl || DEFAULT_CONFIG.baseUrl,
    apiKey: process.env.MYCLAUDE_API_KEY || fileConfig.apiKey || DEFAULT_CONFIG.apiKey,
    model: process.env.MYCLAUDE_MODEL || fileConfig.model || DEFAULT_CONFIG.model,
    provider: process.env.MYCLAUDE_PROVIDER || fileConfig.provider || DEFAULT_CONFIG.provider,
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
