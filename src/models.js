/**
 * Model catalogue.
 *
 * Every entry is reachable through one local gateway, exactly as DSH wires it:
 * the model id carries the vendor as its first segment ("qoder-cn/gfmodel"), so
 * the vendor never has to be guessed from a name. Keeping the catalogue in code
 * (rather than in config.json) means a fresh install already knows the context
 * window and token ceiling of each model instead of assuming one global number.
 */

/** Gateway that fronts every provider. */
export const GATEWAY_BASE_URL = "http://127.0.0.1:3425/v1";

/** Environment variables that may hold the gateway key, first hit wins. */
export const GATEWAY_KEY_ENV = ["MAGPIE_GATEWAY_KEY", "DSH_GATEWAY_KEY"];

/**
 * 供应商预设配置列表，用于设置弹窗与模型切换
 */
export const PROVIDER_PRESETS = [
  {
    key: "anthropic",
    name: "Anthropic Claude",
    badge: "Claude 官方",
    icon: "✳",
    color: "#D97757",
    baseUrl: "https://api.anthropic.com/v1",
    defaultModel: "claude-3-7-sonnet",
    keyPlaceholder: "sk-ant-api03-...",
    keyEnvVar: "ANTHROPIC_API_KEY",
    docUrl: "https://docs.anthropic.com",
    models: [
      { id: "claude-3-7-sonnet", name: "Claude 3.7 Sonnet · 混合推理与编程旗舰", contextWindow: 200000, maxTokens: 64000, input: ["text", "image"], thinking: true, category: "coding", tag: "旗舰推理" },
      { id: "claude-3-5-sonnet", name: "Claude 3.5 Sonnet · 前端与全栈编程王者", contextWindow: 200000, maxTokens: 8192, input: ["text", "image"], category: "coding", tag: "编程王者" },
      { id: "claude-3-5-haiku", name: "Claude 3.5 Haiku · 极速轻量与低延迟", contextWindow: 200000, maxTokens: 8192, input: ["text", "image"], category: "general", tag: "极速响应" },
      { id: "claude-3-opus", name: "Claude 3 Opus · 深度学术与复杂分析", contextWindow: 200000, maxTokens: 4096, input: ["text", "image"], category: "context", tag: "复杂分析" }
    ]
  },
  {
    key: "deepseek",
    name: "DeepSeek 深度求索",
    badge: "DeepSeek 官方",
    icon: "🐋",
    color: "#0066FF",
    baseUrl: "https://api.deepseek.com/v1",
    defaultModel: "deepseek-chat",
    keyPlaceholder: "sk-...",
    keyEnvVar: "DEEPSEEK_API_KEY",
    docUrl: "https://platform.deepseek.com",
    models: [
      { id: "deepseek-chat", name: "DeepSeek-V3 · 强力通用与编程代码 (V3)", contextWindow: 64000, maxTokens: 8192, input: ["text"], category: "coding", tag: "通用代码" },
      { id: "deepseek-reasoner", name: "DeepSeek-R1 · 深度思考与逻辑推理 (R1)", contextWindow: 64000, maxTokens: 8192, input: ["text"], thinking: true, category: "coding", tag: "深度思考" },
      { id: "deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash · 百万长文本 (1M)", contextWindow: 1048576, maxTokens: 384000, input: ["text", "image"], category: "context", tag: "1M长文本" },
      { id: "deepseek-v4-flash", name: "DeepSeek V4 Flash · 高性能极速", contextWindow: 1048576, maxTokens: 384000, input: ["text", "image"], category: "general", tag: "极速" }
    ]
  },
  {
    key: "gemini",
    name: "Google Gemini",
    badge: "Gemini 官方",
    icon: "✨",
    color: "#1A73E8",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    defaultModel: "gemini-2.5-flash",
    keyPlaceholder: "AIzaSy... (环境已自带免费密钥)",
    keyEnvVar: "GEMINI_API_KEY",
    docUrl: "https://aistudio.google.com",
    models: [
      { id: "gemini-2.5-flash", name: "Gemini 2.5 Flash · 百万超长上下文极速 (内置就绪)", contextWindow: 1048576, maxTokens: 65536, input: ["text", "image"], category: "general", tag: "免配即用" },
      { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro · 强力多模态与高级复杂推理", contextWindow: 1048576, maxTokens: 65536, input: ["text", "image"], category: "coding", tag: "多模态旗舰" },
      { id: "gemini-2.0-flash", name: "Gemini 2.0 Flash · 实时超快交互", contextWindow: 1048576, maxTokens: 8192, input: ["text", "image"], category: "general", tag: "极速" }
    ]
  },
  {
    key: "openai",
    name: "OpenAI",
    badge: "OpenAI 官方",
    icon: "🟢",
    color: "#10A37F",
    baseUrl: "https://api.openai.com/v1",
    defaultModel: "gpt-4o",
    keyPlaceholder: "sk-proj-...",
    keyEnvVar: "OPENAI_API_KEY",
    docUrl: "https://platform.openai.com",
    models: [
      { id: "gpt-4o", name: "GPT-4o · 全模态旗舰 (Omni)", contextWindow: 128000, maxTokens: 16384, input: ["text", "image"], category: "coding", tag: "全模态" },
      { id: "gpt-4o-mini", name: "GPT-4o Mini · 极速高性价比", contextWindow: 128000, maxTokens: 16384, input: ["text", "image"], category: "general", tag: "高性价比" },
      { id: "o1", name: "OpenAI o1 · 强化复杂推理旗舰", contextWindow: 128000, maxTokens: 32768, input: ["text", "image"], thinking: true, category: "coding", tag: "高阶推理" },
      { id: "o3-mini", name: "OpenAI o3-mini · 极速代码与数学推理", contextWindow: 128000, maxTokens: 65536, input: ["text"], thinking: true, category: "coding", tag: "代码推理" }
    ]
  },
  {
    key: "zhipu",
    name: "智谱 AI (GLM)",
    badge: "智谱清言",
    icon: "🟣",
    color: "#385BF5",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    defaultModel: "glm-4-flash",
    keyPlaceholder: "zhipu-api-key...",
    keyEnvVar: "ZHIPU_API_KEY",
    docUrl: "https://open.bigmodel.cn",
    models: [
      { id: "glm-4-plus", name: "GLM-4 Plus · 高性能基座与长文本旗舰", contextWindow: 128000, maxTokens: 4096, input: ["text", "image"], category: "coding", tag: "智谱旗舰" },
      { id: "glm-4-flash", name: "GLM-4 Flash · 免费极速调用", contextWindow: 128000, maxTokens: 4096, input: ["text"], category: "general", tag: "免费极速" }
    ]
  },
  {
    key: "qwen",
    name: "通义千问 (Qwen)",
    badge: "阿里云百炼",
    icon: "🔷",
    color: "#FF6600",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    defaultModel: "qwen-2.5-coder-32b",
    keyPlaceholder: "sk-...",
    keyEnvVar: "DASHSCOPE_API_KEY",
    docUrl: "https://bailian.console.aliyun.com",
    models: [
      { id: "qwen-2.5-coder-32b", name: "Qwen 2.5 Coder 32B · 开源编程标杆", contextWindow: 128000, maxTokens: 8192, input: ["text"], category: "coding", tag: "编程标杆" },
      { id: "qwen-max", name: "Qwen Max · 阿里超大规模复杂推理", contextWindow: 128000, maxTokens: 8192, input: ["text"], category: "coding", tag: "全能旗舰" }
    ]
  },
  {
    key: "gateway",
    name: "OpenCode Zen / 多模型网关",
    badge: "聚合网关",
    icon: "⚡",
    color: "#8B5CF6",
    baseUrl: GATEWAY_BASE_URL,
    defaultModel: "group/auto-deepseek-v4-1-flash-free",
    keyPlaceholder: "可留空或填写网关 Token",
    keyEnvVar: "DSH_GATEWAY_KEY",
    docUrl: "http://127.0.0.1:3425",
    models: [] // 下方合并
  },
  {
    key: "ollama",
    name: "Ollama 本地大模型",
    badge: "本地私有",
    icon: "🦙",
    color: "#6B7280",
    baseUrl: "http://localhost:11434/v1",
    defaultModel: "deepseek-r1:8b",
    keyPlaceholder: "Ollama 无需 API Key",
    keyEnvVar: "",
    docUrl: "https://ollama.com",
    models: [
      { id: "deepseek-r1:8b", name: "DeepSeek-R1 8B · 本地轻量思考模型", contextWindow: 32000, maxTokens: 8192, input: ["text"], thinking: true, category: "coding", tag: "本地思考" },
      { id: "qwen2.5-coder:7b", name: "Qwen 2.5 Coder 7B · 本地轻量代码模型", contextWindow: 32000, maxTokens: 8192, input: ["text"], category: "coding", tag: "本地代码" },
      { id: "llama3.3:70b", name: "Llama 3.3 70B · Meta 开源旗舰", contextWindow: 128000, maxTokens: 8192, input: ["text"], category: "general", tag: "本地旗舰" }
    ]
  },
  {
    key: "custom",
    name: "自定义兼容网关 (OneAPI / 中转站)",
    badge: "自定义 API",
    icon: "🌐",
    color: "#4B5563",
    baseUrl: "",
    defaultModel: "",
    keyPlaceholder: "自定义 API 密钥 (Bearer Token)",
    keyEnvVar: "MYCLAUDE_API_KEY",
    docUrl: "",
    models: []
  }
];

// 提取预设供应商中的所有内建模型
const BUILTIN_MODELS = [];
PROVIDER_PRESETS.forEach((p) => {
  (p.models || []).forEach((m) => {
    BUILTIN_MODELS.push({
      ...m,
      providerKey: p.key,
      vendor: p.name,
      badge: p.badge,
      color: p.color
    });
  });
});

/**
 * 网关及内置模型全量列表
 */
export const MODELS = [
  ...BUILTIN_MODELS,
  { id: "group/auto-deepseek-v4-1-flash-free", name: "DeepSeek V4.1 Flash Free · routing group", contextWindow: 200000, maxTokens: 32000, input: ["text", "image"], providerKey: "gateway", vendor: "OpenCode Zen", badge: "聚合网关" },
  { id: "group/auto-glm-5-3-flash-free", name: "GLM-5.3-Flash Free · routing group", contextWindow: 200000, maxTokens: 32000, input: ["text", "image"], providerKey: "gateway", vendor: "OpenCode Zen", badge: "聚合网关" },
  { id: "group/auto-deepseek-v4-1-flash", name: "DeepSeek V4.1 Flash · routing group", contextWindow: 1048576, maxTokens: 384000, input: ["text", "image"], providerKey: "gateway", vendor: "OpenCode Zen", badge: "聚合网关" },
  { id: "group/auto-deepseek-v4-flash", name: "DeepSeek V4 Flash · routing group", contextWindow: 1048576, maxTokens: 384000, input: ["text", "image"], providerKey: "gateway", vendor: "OpenCode Zen", badge: "聚合网关" },
  { id: "group/auto-hy3", name: "Hy3 · routing group", contextWindow: 192000, maxTokens: 64000, input: ["text", "image"], providerKey: "gateway", vendor: "腾讯混元", badge: "聚合网关" },
  { id: "group/auto-step-5-preview", name: "Step-5-Preview · routing group", contextWindow: 200000, maxTokens: 32000, input: ["text", "image"], providerKey: "gateway", vendor: "阶跃星辰", badge: "聚合网关" },
  { id: "opencode-zen/cat-jam-free", name: "Cat-Jam Free · OpenCode Zen", contextWindow: 200000, maxTokens: 32000, input: ["text", "image"], providerKey: "gateway", vendor: "OpenCode Zen", badge: "免费" },
  { id: "opencode-zen/beam-free", name: "Beam Free · OpenCode Zen", contextWindow: 200000, maxTokens: 32000, input: ["text", "image"], providerKey: "gateway", vendor: "OpenCode Zen", badge: "免费" },
  { id: "opencode-zen/fledge-alpha-free", name: "Fledge-Alpha Free · OpenCode Zen", contextWindow: 200000, maxTokens: 32000, input: ["text", "image"], providerKey: "gateway", vendor: "OpenCode Zen", badge: "免费" },
  { id: "opencode-zen/ling-3.1-flash-free", name: "Ling 3.1 Flash Free · OpenCode Zen", contextWindow: 200000, maxTokens: 32000, input: ["text", "image"], providerKey: "gateway", vendor: "OpenCode Zen", badge: "免费" },
  { id: "opencode-zen/space-bunny-free", name: "Space Bunny Free · OpenCode Zen", contextWindow: 200000, maxTokens: 32000, input: ["text", "image"], providerKey: "gateway", vendor: "OpenCode Zen", badge: "免费" },
  { id: "opencode-zen/mimo-v2.6-flash-free", name: "MiMo-V2.6-Flash Free · OpenCode Zen", contextWindow: 200000, maxTokens: 32000, input: ["text", "image"], providerKey: "gateway", vendor: "OpenCode Zen", badge: "免费" },
  { id: "opencode-zen/deepseek-v4.1-flash-free", name: "DeepSeek V4.1 Flash Free · OpenCode Zen", contextWindow: 200000, maxTokens: 32000, input: ["text", "image"], providerKey: "gateway", vendor: "DeepSeek", badge: "免费" },
  { id: "opencode-zen/glm-5.3-flash-free", name: "GLM-5.3-Flash Free · OpenCode Zen", contextWindow: 200000, maxTokens: 32000, input: ["text", "image"], providerKey: "gateway", vendor: "智谱", badge: "免费" },
  { id: "opencode-zen/exo-free", name: "Exo Free · OpenCode Zen", contextWindow: 200000, maxTokens: 32000, input: ["text", "image"], providerKey: "gateway", vendor: "OpenCode Zen", badge: "免费" },
  { id: "trae-cn/glm-5.2", name: "GLM-5.2 · Trae CN", contextWindow: 200000, maxTokens: 32000, input: ["text", "image"], providerKey: "gateway", vendor: "智谱", badge: "Trae" },
  { id: "trae-cn/DeepSeek-V4-Flash", name: "DeepSeek V4 Flash · Trae CN", contextWindow: 1048576, maxTokens: 384000, input: ["text", "image"], providerKey: "gateway", vendor: "DeepSeek", badge: "Trae" },
  { id: "trae-cn/DeepSeek-V4-Pro", name: "DeepSeek V4 Pro · Trae CN", contextWindow: 200000, maxTokens: 32000, input: ["text", "image"], providerKey: "gateway", vendor: "DeepSeek", badge: "Trae" },
  { id: "trae-cn/qwen-3.7-plus", name: "Qwen 3.7 Plus · Trae CN", contextWindow: 200000, maxTokens: 32000, input: ["text", "image"], providerKey: "gateway", vendor: "阿里通义", badge: "Trae" },
  { id: "trae-cn/kimi-k2.6", name: "Kimi K2.6 · Trae CN", contextWindow: 200000, maxTokens: 32000, input: ["text", "image"], providerKey: "gateway", vendor: "月之暗面", badge: "Trae" },
  { id: "qoder-cn/gfmodel", name: "GfModel · Qoder CN", contextWindow: 200000, maxTokens: 32000, input: ["text", "image"], providerKey: "gateway", vendor: "Qoder", badge: "网关" }
];

/** Default model: the local gateway, usable without any third-party key. */
export const DEFAULT_MODEL = "qoder-cn/gfmodel";

/**
 * The preset whose endpoint is configured out of the box. PROVIDER_PRESETS
 * carries optional third-party endpoints (Anthropic / Gemini / OpenAI) that a
 * user can enable with their own key, but the shipped default must point at
 * the local gateway: a fresh install has no third-party key, so defaulting to
 * "claude-3-7-sonnet" made the very first message fail with
 * 404 "magpie knows no model".
 */
export const DEFAULT_PROVIDER_KEY = "gateway";

/** Look up a catalogue entry by id, or null. */
export function findModel(id) {
  return MODELS.find((m) => m.id === id) || null;
}

/** Context window for a model, falling back to a conservative default. */
export function contextWindowOf(id) {
  return findModel(id)?.contextWindow ?? 200000;
}

/** Output token ceiling for a model. */
export function maxTokensOf(id) {
  return findModel(id)?.maxTokens ?? 32000;
}

/** Whether a model accepts image attachments. */
export function supportsVision(id) {
  const m = findModel(id);
  return m ? m.input.includes("image") : true;
}

/** Vendor segment of a model id, e.g. "qoder-cn" of "qoder-cn/gfmodel". */
export function vendorOfModel(id) {
  const m = findModel(id);
  if (m && m.vendor) return m.vendor;
  const s = String(id || "");
  const i = s.indexOf("/");
  return i > 0 ? s.slice(0, i) : s;
}

/** Distinct vendors present in the catalogue, in catalogue order. */
export function vendorList() {
  const seen = [];
  for (const m of MODELS) {
    const v = vendorOfModel(m.id);
    if (!seen.includes(v)) { seen.push(v); }
  }
  return seen;
}

