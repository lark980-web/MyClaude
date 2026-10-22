/**
 * The reviewer that screens an action in auto mode.
 *
 * Claude describes auto mode as "no routine prompts; a reviewer model screens
 * actions" (933_chunk-0qdm07jf.js). Without that reviewer, auto mode here was
 * simply "run everything", which is a different promise than the one the mode
 * makes.
 *
 * The reviewer is deliberately narrow. It answers one question — does this
 * specific tool call need a human to look at it — and anything it cannot
 * decide counts as needing a look, because the cost of stopping to ask is a
 * click while the cost of the wrong allow is the workspace.
 *
 * It costs one extra request per tool call, so config.autoReview gates it and
 * the default is off.
 */

/** The patterns that never need a reviewer: reading cannot break anything. */
const READ_ONLY_TOOLS = new Set(["Read", "LS", "Glob", "Grep", "NotebookRead", "BashOutput", "TaskOutput"]);

/**
 * Ask the reviewer whether a tool call may proceed.
 *
 * @param {{complete: Function}} provider an object with complete(args)
 * @param {string} toolName
 * @param {object} args
 * @param {{timeoutMs?: number}} [opts]
 * @returns {Promise<{allow: boolean, reason: string}>}
 */
export async function reviewToolCall(provider, toolName, args, opts = {}) {
  // Reading is always fine; asking about it would be noise on every turn.
  if (READ_ONLY_TOOLS.has(toolName)) {
    return { allow: true, reason: "read-only" };
  }
  if (!provider || typeof provider.complete !== "function") {
    // No way to ask means no way to be sure, so let the normal permission
    // flow decide rather than silently allowing.
    return { allow: null, reason: "no reviewer available" };
  }
  const payload = JSON.stringify({ tool: toolName, arguments: args || {} });
  const prompt =
    "You are screening one tool call for an autonomous coding agent.\n" +
    "Answer with exactly one word: ALLOW if a careful engineer would let this" +
    " run without asking, or ASK if a human should look first.\n" +
    "Treat anything that deletes data, rewrites history, publishes, spends" +
    " money, or reaches outside the repository as ASK.\n\n" +
    "Tool call: " + payload;
  let answer = "";
  try {
    const res = await provider.complete({ prompt, maxTokens: 8, temperature: 0 });
    answer = String((res && (res.text || res.content)) || "").trim().toUpperCase();
  } catch (e) {
    // A failed review is not an allow: fall back to asking.
    return { allow: null, reason: "reviewer failed: " + (e && e.message) };
  }
  // Match the whole answer, not a prefix: a sentence like "I would ALLOW this,"
  // "but it touches the network" carries a condition, and a prefix test would
  // read it as a yes. Only the bare word counts; anything else is undecided.
  const word = answer.replace(/[^A-Z]/g, "");
  if (word === "ALLOW" || word === "ALLOWED") { return { allow: true, reason: "reviewer allowed" }; }
  if (word === "ASK") { return { allow: false, reason: "reviewer wants a human" }; }
  // An unreadable answer is treated as needing a look, never as an allow.
  return { allow: null, reason: "reviewer answered nothing usable" };
}
