/**
 * Provider 工厂：按 config.provider 选择线协议。
 *
 * 单独一个文件是为了打破循环 —— anthropic.js 在求值期就要 `extends OpenAIProvider`，
 * 工厂放在 openai.js 里就得反向 import anthropic.js。
 */

import { OpenAIProvider } from "./openai.js";
import { AnthropicProvider } from "./anthropic.js";

export { ProviderError } from "./openai.js";

/** 已知 provider 值（/api/config POST 的白名单依据）。 */
export const PROVIDER_KINDS = ["openai", "anthropic", "workbuddy", "qoder"];

export function createProvider(config) {
  switch (config.provider) {
    case "anthropic":
      return new AnthropicProvider(config);
    case "openai":
    case "workbuddy":
    case "qoder":
    default:
      return new OpenAIProvider(config);
  }
}