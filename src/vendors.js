/**
 * Vendor identification from an API base URL.
 *
 * The endpoint is the authoritative signal: a model name like "glm-5.3" tells
 * you nothing reliable, but whoever serves the request does. Identification is
 * therefore keyed off the host, with the model name only used as a fallback
 * for gateways that proxy several vendors under one domain.
 */

/**
 * Host fragment -> vendor display name, first match wins.
 *
 * Patterns are matched against the hostname only (see hostOf), so they must not
 * be anchored at the end: a base URL always carries a path such as "/v1".
 */
const HOST_VENDORS = [
  [/(^|\.)api\.deepseek\.com/i, "DeepSeek"],
  [/(^|\.)open\.bigmodel\.cn/i, "智谱"],
  [/(^|\.)open\.bitsse\.cn/i, "智谱"],
  [/(^|\.)dashscope\.aliyuncs\.com/i, "阿里通义"],
  [/(^|\.)api\.moonshot\.cn/i, "月之暗面"],
  [/(^|\.)api\.baichuan-ai\.com/i, "百川"],
  [/(^|\.)qianfan\.baidubce\.com/i, "百度"],
  [/(^|\.)api\.anthropic\.com/i, "Anthropic"],
  [/(^|\.)generativelanguage\.googleapis\.com/i, "Google"],
  [/(^|\.)api\.mistral\.ai/i, "Mistral"],
  [/(^|\.)api\.x\.ai/i, "xAI"],
  [/(^|\.)integrate\.api\.nvidia\.com/i, "NVIDIA"],
  [/(^|\.)openrouter\.ai/i, "OpenRouter"],
  [/(^|\.)api\.openai\.com/i, "OpenAI"],
  [/(^|\.)api\.groq\.com/i, "Groq"],
  [/(^|\.)api\.together\.ai/i, "Together"],
  [/(^|\.)api\.fireworks\.ai/i, "Fireworks"],
  [/(^|\.)api\.siliconflow\.cn/i, "硅基流动"],
  [/(^|\.)api\.minimax\.chat/i, "MiniMax"],
];

/** Hostname of a URL, without port or path; falls back to the raw string. */
function hostOf(url) {
  const m = /^https?:\/\/([^/]+)/i.exec(String(url || ""));
  return m ? m[1].replace(/:\d+$/, "") : String(url || "");
}

/** Model-name fallbacks, used only when the host is not a known vendor. */
const NAME_VENDORS = [
  [/^deepseek/i, "DeepSeek"],
  [/^(glm|z-ai\/glm|zhipu)/i, "智谱"],
  [/^(gpt-|o[13]-|text-davinci|chatgpt)/i, "OpenAI"],
  [/^claude/i, "Anthropic"],
  [/^(qwen|tongyi)/i, "阿里通义"],
  [/^(llama|meta\/)/i, "Meta"],
  [/^(kimi|moonshot)/i, "月之暗面"],
  [/^ernie/i, "百度"],
  [/^baichuan/i, "百川"],
  [/^gemini/i, "Google"],
  [/^mistral/i, "Mistral"],
  [/^grok/i, "xAI"],
];

/** A local gateway (127.0.0.1 / localhost / LAN IP) is self-hosted. */
function isLocal(baseUrl) {
  const u = String(baseUrl || "").toLowerCase();
  if (!u) { return false; }
  return /(^|\/\/)(127\.|0\.0\.0\.0|localhost|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(u);
}

/**
 * Vendor display name for a base URL, optionally paired with a model name.
 *
 * @param {string} baseUrl
 * @param {string} [model]
 */
export function vendorFromUrl(baseUrl, model = "") {
  const url = String(baseUrl || "");
  const host = hostOf(url);
  for (const [re, name] of HOST_VENDORS) {
    if (re.test(host)) { return name; }
  }
  // A local gateway proxies many vendors under one host, so the endpoint says
  // nothing and every model would land in a single useless group. Fall back to
  // the model name to surface the vendor behind the gateway; only models we
  // cannot place stay under the gateway label.
  for (const [re, name] of NAME_VENDORS) {
    if (re.test(String(model || ""))) { return name; }
  }
  if (isLocal(url)) { return "本地网关"; }
  const m = /^https?:\/\/([^/]+)/i.exec(url);
  if (m) { return m[1].replace(/^www\./i, ""); }
  return "未知";
}

/** Short, human label for an endpoint, e.g. "本地网关 · 127.0.0.1:8000". */
export function endpointLabel(baseUrl) {
  const url = String(baseUrl || "");
  if (!url) { return "未配置"; }
  const m = /^https?:\/\/([^/]+)/i.exec(url);
  if (!m) { return url; }
  const host = m[1];
  return (isLocal(url) ? "本地网关 · " : "") + host;
}

