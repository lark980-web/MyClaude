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

/** Aliases for the vendor segment of a "vendor/model" id. */
const PREFIX_ALIASES = [
  [/^claude$/i, "Anthropic"],
  [/^(deepseek|ds)$/i, "DeepSeek"],
  [/^(openai|gpt|o[13])$/i, "OpenAI"],
  [/^(gemini|google|bard)$/i, "Google"],
  [/^(qwen|tongyi|aliyun|alibaba)$/i, "阿里通义"],
  [/^(glm|z-ai|zhipu|chatglm)$/i, "智谱"],
  [/^(kimi|moonshot)$/i, "月之暗面"],
  [/^(ernie|wenxin|baidu)$/i, "百度"],
  [/^(baichuan)$/i, "百川"],
  [/^(llama|meta)$/i, "Meta"],
  [/^(mistral|mixtral)$/i, "Mistral"],
  [/^(grok|xai|x-ai)$/i, "xAI"],
  [/^(minimax)$/i, "MiniMax"],
  [/^(sensenova)$/i, "商汤"],
  [/^(nvidia)$/i, "NVIDIA"],
  [/^(amd)$/i, "AMD"],
  [/^(opencode-zen|opencode)$/i, "OpenCode Zen"],
  [/^(workbuddy|workbuddy-ai)$/i, "WorkBuddy"],
  [/^(qoder|qoder-cn)$/i, "Qoder"],
  [/^(beatapi)$/i, "BeatAPI"],
  [/^(group|auto)$/i, "路由组"],
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
  // 1) The endpoint is authoritative: a known host wins outright. Checking the
  //    model id first would let "meta/llama-3.1" override the NVIDIA host that
  //    is actually serving the request.
  const host = hostOf(baseUrl);
  for (const [re, name] of HOST_VENDORS) {
    if (re.test(host)) { return name; }
  }

  const m = String(model || "").trim();
  const slash = m.indexOf("/");

  // 2) "vendor/model" is the gateway convention: the segment before the slash
  //    names the vendor. Some prefixes are aliases that need translating.
  if (slash > 0) {
    const prefix = m.slice(0, slash);
    // Common vendor segments are aliases of a display name, so translate them
    // instead of echoing the raw prefix.
    for (const [re, name] of PREFIX_ALIASES) {
      if (re.test(prefix)) { return name; }
    }
    if (/trae/i.test(prefix)) {
      const rest = m.slice(slash + 1);
      for (const [re, name] of NAME_VENDORS) {
        if (re.test(rest)) return name;
      }
      return "Trae";
    }
    return prefix;
  }

  // 3) Bare model name, or a local gateway proxying several vendors.
  for (const [re, name] of NAME_VENDORS) {
    if (re.test(m)) { return name; }
  }
  if (isLocal(baseUrl)) { return "本地网关"; }
  if (host) { return host; }
  return "未知";
}

export function endpointLabel(baseUrl) {
  const url = String(baseUrl || "");
  if (!url) { return "未配置"; }
  const m = /^https?:\/\/([^/]+)/i.exec(url);
  if (!m) { return url; }
  const host = m[1];
  return (isLocal(url) ? "本地网关 · " : "") + host;
}

