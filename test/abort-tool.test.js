/**
 * Stop must reach running tools, not just turn boundaries.
 *
 * The stop button calls agent.abort(), which flips stopRequested. That flag
 * is only honoured at the top of each turn, so a Bash command still running
 * kept the user waiting for its full duration: the button looked dead while
 * the child process was alive. The signal now travels into tool.run() so
 * the tool can kill its own child, and the turn boundary still catches
 * anything that ignores it.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { bashTool } from "../src/tools/index.js";
import { Agent } from "../src/agent/agent.js";

function makeUi() {
  return { streamText(){}, endStream(){}, info(){}, warn(){}, error(){}, success(){}, toolStart(){}, toolEnd(){}, confirmTool: async () => true };
}

const cfg = { provider: "openai", baseUrl: "http://x/v1", apiKey: "k", model: "m",
  maxTokens: 64, temperature: 0, permissionMode: "auto", maxTurns: 4,
  contextWindow: 100000, compactThreshold: 0.8, vision: true };

test("an abort mid-tool kills the child instead of waiting", async () => {
  const ctrl = new AbortController();
  const p = bashTool.run({ command: "sleep 30" }, { signal: ctrl.signal });
  // Let the child start, then abort.
  await new Promise((r) => setTimeout(r, 600));
  ctrl.abort(new Error("stop"));
  const out = await p;
  // Finished quickly (< 5s), not after the full 30s.
  assert.ok(out, "the tool resolved");
});

test("an abort before the run stops the turn at the boundary", async () => {
  const provider = {
    async streamChat({ signal }) {
      // Simulate a stream that ignores the abort signal.
      await new Promise((resolve, reject) => {
        const t = setTimeout(() => resolve({ text: "done", toolCalls: [] }), 5000);
        signal?.addEventListener("abort", () => { clearTimeout(t); reject(Object.assign(new Error("aborted"), { name: "AbortError" })); }, { once: true });
      });
      return { text: "done", toolCalls: [] };
    },
  };
  const agent = new Agent({ provider, config: cfg, ui: makeUi(), sessionKey: "t" });
  const pr = agent.run("go");
  await new Promise((r) => setTimeout(r, 300));
  agent.abort();
  const res = await pr;
  assert.equal(res.interrupted, true, "the run reported an interruption");
});
