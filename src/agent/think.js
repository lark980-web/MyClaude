/**
 * Separate a leading `implicit reasoning` block from the model's answer.
 *
 * Several OpenAI-compatible gateways (and models asked to "think first") emit
 * their reasoning inline in `content` wrapped in <think>...</think> instead of using
 * a dedicated `reasoning_content` field. That raw text must never reach the
 * transcript: it would be rendered as visible prose, and worse, it would be
 * stored in history and replayed to the model as an assistant message, teaching
 * it to reproduce the tags.
 *
 * Only a *leading* block counts as reasoning — an opening tag buried in the
 * middle of prose is quoted content and is left alone. The closing tag is
 * searched from the opening tag onwards, so a marker mentioned inside the
 * reasoning cannot truncate it.
 */

const OPEN = "<think>";
const CLOSE = "</think>";

/**
 * @param {string} raw
 * @returns {{ reasoning: string, visible: string, open: boolean } | null}
 *   `null` when the text carries no reasoning block. `open` is true while the
 *   closing tag has not arrived yet (streaming mid-thought).
 */
export function splitReasoning(raw) {
  const s = String(raw ?? "");

  // An opening tag only starts a block when nothing but whitespace precedes it.
  const start = s.indexOf(OPEN);
  const leading = start < 0 ? "" : s.slice(0, start);
  if (start < 0 || !/^\s*$/.test(leading)) {
    // No opening tag. A closing tag can still mean the gateway dropped the
    // opener while keeping the reasoning inline: when the tag ends a paragraph
    // the text before it is that reasoning and must leave the answer. A tag
    // quoted mid-line is content and is left untouched.
    const closeAt = s.indexOf(CLOSE);
    if (closeAt < 0) { return null; }
    const before = s.slice(0, closeAt);
    if (/\n\s*$/.test(before) && before.trim()) {
      return {
        reasoning: before.trim(),
        visible: s.slice(closeAt + CLOSE.length).replace(/^\s+/, ""),
        open: false
      };
    }
    return { reasoning: "", visible: s, open: false };
  }

  const end = s.indexOf(CLOSE, start + OPEN.length);
  if (end === -1) {
    return { reasoning: s.slice(start + OPEN.length), visible: "", open: true };
  }
  return {
    reasoning: s.slice(start + OPEN.length, end),
    // Anything before the block (whitespace) is preserved so paragraph breaks
    // the model wrote are not silently merged into the answer.
    visible: leading + s.slice(end + CLOSE.length),
    open: false
  };
}

/**
 * Text safe to store in history and show to the user. A leading reasoning block
 * is dropped; while one is still open the visible text is empty (the reasoning
 * belongs in the "thinking" panel, not the answer).
 *
 * @param {string} raw
 * @returns {string}
 */
export function stripReasoning(raw) {
  const parts = splitReasoning(raw);
  return parts ? parts.visible : String(raw ?? "");
}

/**
 * Whether the text still carries a leading, unterminated reasoning block.
 *
 * @param {string} raw
 * @returns {boolean}
 */
export function hasOpenReasoning(raw) {
  const parts = splitReasoning(raw);
  return !!parts && parts.open;
}
