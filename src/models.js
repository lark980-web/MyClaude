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
 * The catalogue, in the order DSH lists them (so the UI matches what users
 * already know). Fields mirror the DSH model descriptor.
 */
export const MODELS = [
  { id: "group/auto-deepseek-v4-1-flash-free", name: "DeepSeek V4.1 Flash Free · routing group", contextWindow: 200000, maxTokens: 32000, input: ["text", "image"] },
  { id: "group/auto-glm-5-3-flash-free", name: "GLM-5.3-Flash Free · routing group", contextWindow: 200000, maxTokens: 32000, input: ["text", "image"] },
  { id: "group/auto-deepseek-v4-1-flash", name: "DeepSeek V4.1 Flash · routing group", contextWindow: 1048576, maxTokens: 384000, input: ["text", "image"] },
  { id: "group/auto-deepseek-v4-flash", name: "DeepSeek V4 Flash · routing group", contextWindow: 1048576, maxTokens: 384000, input: ["text", "image"] },
  { id: "group/auto-hy3", name: "Hy3 · routing group", contextWindow: 192000, maxTokens: 64000, input: ["text", "image"] },
  { id: "group/auto-step-5-preview", name: "Step-5-Preview · routing group", contextWindow: 200000, maxTokens: 32000, input: ["text", "image"] },
  { id: "opencode-zen/cat-jam-free", name: "Cat-Jam Free · OpenCode Zen", contextWindow: 200000, maxTokens: 32000, input: ["text", "image"] },
  { id: "opencode-zen/beam-free", name: "Beam Free · OpenCode Zen", contextWindow: 200000, maxTokens: 32000, input: ["text", "image"] },
  { id: "opencode-zen/fledge-alpha-free", name: "Fledge-Alpha Free · OpenCode Zen", contextWindow: 200000, maxTokens: 32000, input: ["text", "image"] },
  { id: "opencode-zen/ling-3.1-flash-free", name: "Ling 3.1 Flash Free · OpenCode Zen", contextWindow: 200000, maxTokens: 32000, input: ["text", "image"] },
  { id: "opencode-zen/space-bunny-free", name: "Space Bunny Free · OpenCode Zen", contextWindow: 200000, maxTokens: 32000, input: ["text", "image"] },
  { id: "opencode-zen/mimo-v2.6-flash-free", name: "MiMo-V2.6-Flash Free · OpenCode Zen", contextWindow: 200000, maxTokens: 32000, input: ["text", "image"] },
  { id: "opencode-zen/deepseek-v4.1-flash-free", name: "DeepSeek V4.1 Flash Free · OpenCode Zen", contextWindow: 200000, maxTokens: 32000, input: ["text", "image"] },
  { id: "opencode-zen/glm-5.3-flash-free", name: "GLM-5.3-Flash Free · OpenCode Zen", contextWindow: 200000, maxTokens: 32000, input: ["text", "image"] },
  { id: "opencode-zen/exo-free", name: "Exo Free · OpenCode Zen", contextWindow: 200000, maxTokens: 32000, input: ["text", "image"] },
  { id: "workbuddy/hy4-preview", name: "Hy4-Preview · WorkBuddy", contextWindow: 200000, maxTokens: 32000, input: ["text", "image"] },
  { id: "workbuddy/hy3", name: "Hy3 · WorkBuddy", contextWindow: 192000, maxTokens: 64000, input: ["text", "image"] },
  { id: "workbuddy/step-5-preview", name: "Step-5-Preview · WorkBuddy", contextWindow: 200000, maxTokens: 32000, input: ["text", "image"] },
  { id: "workbuddy-ai/hy3", name: "Hy3 · WorkBuddy AI", contextWindow: 192000, maxTokens: 64000, input: ["text", "image"] },
  { id: "workbuddy-ai/step-5-preview", name: "Step-5-Preview · WorkBuddy AI", contextWindow: 200000, maxTokens: 32000, input: ["text", "image"] },
  { id: "workbuddy-ai/deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash · WorkBuddy AI", contextWindow: 1048576, maxTokens: 384000, input: ["text", "image"] },
  { id: "qoder-cn/qfmodel", name: "QfModel · Qoder CN", contextWindow: 200000, maxTokens: 32000, input: ["text", "image"] },
  { id: "qoder-cn/gfmodel", name: "GfModel · Qoder CN", contextWindow: 200000, maxTokens: 32000, input: ["text", "image"] },
  { id: "qoder-cn/gmodel", name: "GModel · Qoder CN", contextWindow: 200000, maxTokens: 32000, input: ["text", "image"] },
  { id: "trae-cn/glm-5.2", name: "GLM-5.2 · Trae CN", contextWindow: 200000, maxTokens: 32000, input: ["text", "image"] },
  { id: "trae-cn/DeepSeek-V4-Flash", name: "DeepSeek V4 Flash · Trae CN", contextWindow: 1048576, maxTokens: 384000, input: ["text", "image"] },
  { id: "trae-cn/DeepSeek-V4-Pro", name: "DeepSeek V4 Pro · Trae CN", contextWindow: 200000, maxTokens: 32000, input: ["text", "image"] },
  { id: "trae-cn/qwen-3.7-plus", name: "Qwen 3.7 Plus · Trae CN", contextWindow: 200000, maxTokens: 32000, input: ["text", "image"] },
  { id: "trae-cn/kimi-k2.6", name: "Kimi K2.6 · Trae CN", contextWindow: 200000, maxTokens: 32000, input: ["text", "image"] },
  { id: "sensenova/sensenova-6.8-flash-lite", name: "SenseNova 6.8 Flash Lite", contextWindow: 200000, maxTokens: 32000, input: ["text", "image"] },
  { id: "opencode-zen/muse-spark-1.3-contributor-free", name: "Muse-Spark 1.3 Free · OpenCode Zen", contextWindow: 200000, maxTokens: 32000, input: ["text", "image"] },
  { id: "amd/DeepSeek-V4.1-Flash", name: "DeepSeek V4.1 Flash · AMD", contextWindow: 1048576, maxTokens: 384000, input: ["text", "image"] },
  { id: "amd/MiniCPM-V-4.7-35B-A3B", name: "MiniCPM-V 4.7 · AMD", contextWindow: 200000, maxTokens: 32000, input: ["text", "image"] },
  { id: "amd/MiMo-V2.6-Flash", name: "MiMo-V2.6-Flash · AMD", contextWindow: 200000, maxTokens: 32000, input: ["text", "image"] },
  { id: "amd/DeepSeek-V4-Flash-Vision-Exp", name: "DeepSeek V4 Flash Vision · AMD", contextWindow: 200000, maxTokens: 32000, input: ["text", "image"] },
  { id: "amd/Gemma-4-31B-IT", name: "Gemma 4 31B · AMD", contextWindow: 200000, maxTokens: 32000, input: ["text", "image"] },
  { id: "amd/GLM-5.3-Flash", name: "GLM-5.3-Flash · AMD", contextWindow: 200000, maxTokens: 32000, input: ["text", "image"] },
  { id: "amd/DeepSeek-V4-Flash", name: "DeepSeek V4 Flash · AMD", contextWindow: 1048576, maxTokens: 384000, input: ["text", "image"] },
  { id: "amd/Qwen3.8-Flash-Next", name: "Qwen3.8 Flash Next · AMD", contextWindow: 200000, maxTokens: 32000, input: ["text", "image"] },
  { id: "amd/Qwen3.8-27B", name: "Qwen3.8 27B · AMD", contextWindow: 200000, maxTokens: 32000, input: ["text", "image"] },
  { id: "beatapi/deepseek-v4.1-flash-free", name: "DeepSeek V4.1 Flash Free · BeatAPI", contextWindow: 200000, maxTokens: 32000, input: ["text", "image"] },
  { id: "beatapi/deepseek-v4-flash-0731-free", name: "DeepSeek V4 Flash Free · BeatAPI", contextWindow: 200000, maxTokens: 32000, input: ["text", "image"] },
  { id: "beatapi/gemini-3.8-flash-free", name: "Gemini 3.8 Flash Free · BeatAPI", contextWindow: 200000, maxTokens: 32000, input: ["text", "image"] },
  { id: "beatapi/glm-5.3-flash-free", name: "GLM-5.3-Flash Free · BeatAPI", contextWindow: 200000, maxTokens: 32000, input: ["text", "image"] },
  { id: "beatapi/glm-5.3-free", name: "GLM-5.3 Free · BeatAPI", contextWindow: 200000, maxTokens: 32000, input: ["text", "image"] },
  { id: "opencode-zen/minimax-m3-free", name: "MiniMax-M3 Free · OpenCode Zen", contextWindow: 200000, maxTokens: 32000, input: ["text", "image"] },
];

/** Model DSH selects by default. */
export const DEFAULT_MODEL = "qoder-cn/gfmodel";

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

