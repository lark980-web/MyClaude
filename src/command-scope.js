/**
 * Temporary scope for a slash command's frontmatter metadata.
 *
 * A custom command can declare `model` and `allowed-tools`. Those fields were
 * parsed but never applied, so such a command ran with whatever the session
 * happened to have. The scope is temporary by design: the next prompt must not
 * inherit it.
 *
 * Kept out of main.js on purpose — main.js starts the REPL at import time, so
 * anything tests need to import must live elsewhere.
 */
import { findModel } from "./models.js";

/**
 * Run `fn` with the command's model and tool allowlist applied, then restore.
 *
 * Unknown values warn and leave the current setting alone rather than abort:
 * a typo in frontmatter should not make the command unusable.
 */
export async function withCommandScope(agent, config, provider, custom, fn) {
  const saved = {
    model: config.model,
    modelOnProvider: provider ? provider.model : undefined,
    tools: agent.tools,
  };
  let changed = false;

  if (custom && custom.model) {
    if (findModel(custom.model)) {
      config.model = custom.model;
      if (provider) { provider.model = custom.model; }
      if (typeof agent.setModel === "function") { agent.setModel(custom.model); }
      changed = true;
    } else {
      agent.ui.warn(`/${custom.name}: unknown model "${custom.model}", keeping ${saved.model}`);
    }
  }

  if (custom && custom.allowedTools) {
    const wanted = String(custom.allowedTools)
      .split(/[,\s]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (wanted.length) {
      const known = new Set(agent.tools.map((t) => t.function && t.function.name));
      const missing = wanted.filter((w) => !known.has(w));
      if (missing.length) {
        agent.ui.warn(`/${custom.name}: unknown tool(s) in allowed-tools: ${missing.join(", ")}`);
      }
      const kept = agent.tools.filter((t) => t.function && wanted.includes(t.function.name));
      if (kept.length) {
        agent.tools = kept;
        changed = true;
      }
    }
  }

  try {
    return await fn();
  } finally {
    if (changed) {
      agent.tools = saved.tools;
      config.model = saved.model;
      if (provider) { provider.model = saved.modelOnProvider; }
      if (typeof agent.setModel === "function") { agent.setModel(saved.model); }
    }
  }
}
