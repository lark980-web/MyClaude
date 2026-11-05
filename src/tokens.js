/**
 * Token 估算：CJK 与拉丁文分别处理。
 *
 * 英文经验值是「约 4 字符 1 token」，把它直接套到中文会低估 3-4 倍：
 * 一个 144 字的中文提示词按 chars/4 只有 36 token，实际约 120-150。
 * 低估的后果不是数字难看，而是上下文占用看起来比实际小得多、压缩触发得太晚。
 *
 * 口径：中日韩文字与全角标点按 ~1 字符 1 token；其余按 4 字符 1 token。
 * 这是估算，不是分词器 —— 它只需要在「中文占多数」时不再系统性偏低。
 */

const CJK_RANGES = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af\u3000-\u303f\uff00-\uffef]/g;

/** 纯文本的 token 估算（不含每条消息的固定开销）。 */
export function estimateTextTokens(text) {
  const s = typeof text === "string" ? text : String(text == null ? "" : text);
  if (!s) return 0;
  const cjk = (s.match(CJK_RANGES) || []).length;
  return cjk + Math.ceil((s.length - cjk) / 4);
}
