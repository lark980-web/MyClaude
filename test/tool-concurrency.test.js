/**
 * Independent tool calls in one turn must run at the same time.
 *
 * This is the ordinary tool path (five Reads in one turn), not the Task
 * sub-agent path, which subagent-parallel.test.js already covers. Awaiting
 * them one by one turns "read these five files" into five round trips, and
 * the failure is quiet: nothing errors, the agent just gets slower.
 *
 * Results still have to be recorded in the order the calls were made,
 * because the provider matches each result to its own tool_call id.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Agent } from "../src/agent/agent.js";

function makeUi() {
  return {
    streamText() {}, endStream() {}, info() {}, warn() {}, error() {}, success() {},
    toolStart() {}, toolEnd() {}, confirmTool: async () => true,
  };
}

function makeConfig() {
  return {
    provider: "openai", baseUrl: "http://x/v1", apiKey: "k", model: "m",
    maxTokens: 100, temperature: 0, permissionMode: "auto", maxTurns: 4,
    contextWindow: 100000, compactThreshold: 0.8, vision: true,
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A provider that asks for n reads, then stops. */
function providerAskingFor(reads, onTurn) {
  let turn = 0;
  return {
    async streamChat() {
      turn++;
      await onTurn(turn);
      if (turn === 1) {
        return {
          text: "",
          toolCalls: reads.map((r, i) => ({
            id: "c" + (i + 1),
            name: "Read",
            arguments: { file_path: r.path },
          })),
        };
      }
      return { text: "done", toolCalls: [] };
    },
  };
}

test("several reads in one turn run concurrently", async () => {
  // Each read resolves after 250ms. Sequential execution would take ~750ms;
  // concurrent execution finishes in a little over 250ms. The timing is the
  // point: nothing else in this test can tell the two apart, because both
  // produce the same results, only at different speeds.
  const SLOW = 250;
  const dir = mkdtempSync(join(tmpdir(), "mc-conc-"));
  const files = ["a", "b", "c"].map((n, i) => {
    const p = join(dir, n + ".txt");
    writeFileSync(p, "body-" + n);
    return { path: p, name: n };
  });

  let started = 0;
  let maxConcurrent = 0;
  const agent = new Agent({
    provider: providerAskingFor(files, () => {}),
    config: makeConfig(),
    ui: makeUi(),
  });
  // Make the tool slow so concurrency is observable, without touching Read.
  const { findTool } = await import("../src/tools/index.js");
  const readTool = findTool("Read");
  const originalRun = readTool.run;
  readTool.run = async function (args, ctx) {
    started++;
    maxConcurrent = Math.max(maxConcurrent, started);
    await sleep(SLOW);
    started--;
    return originalRun.call(this, args, ctx);
  };

  const t0 = Date.now();
  try {
    await agent.run("read three files");
  } finally {
    readTool.run = originalRun;
  }
  const elapsed = Date.now() - t0;

  assert.equal(maxConcurrent, 3, "all three reads were in flight at once");
  assert.ok(elapsed < SLOW * 2.2,
    "three 250ms reads took " + elapsed + "ms, which is sequential");
});

test("results are recorded in the order the calls were made", async () => {
  // Concurrency must not scramble the transcript: the provider matches each
  // tool result to its own call id, so out-of-order results break the turn.
  const dir = mkdtempSync(join(tmpdir(), "mc-order-"));
  // The first file is the slowest, so it finishes last - the worst case for
  // an implementation that appends results as they arrive.
  const specs = [
    { name: "slow", delay: 260 },
    { name: "fast", delay: 20 },
  ];
  const files = specs.map((s) => {
    const p = join(dir, s.name + ".txt");
    writeFileSync(p, "body-" + s.name);
    return { path: p, name: s.name, delay: s.delay };
  });

  const agent = new Agent({
    provider: providerAskingFor(files, () => {}),
    config: makeConfig(),
    ui: makeUi(),
  });
  const { findTool } = await import("../src/tools/index.js");
  const readTool = findTool("Read");
  const originalRun = readTool.run;
  readTool.run = async function (args, ctx) {
    const which = files.find((f) => f.path === args.file_path);
    await sleep(which ? which.delay : 0);
    return originalRun.call(this, args, ctx);
  };
  try {
    await agent.run("read two files");
  } finally {
    readTool.run = originalRun;
  }

  const toolMsgs = agent.messages.filter((m) => m.role === "tool");
  assert.equal(toolMsgs.length, 2, "one result per call");
  // The slow file was asked for first, so its result must come first even
  // though it finished last.
  assert.match(toolMsgs[0].content, /body-slow/, "first call result first");
  assert.match(toolMsgs[1].content, /body-fast/, "second call result second");
  assert.equal(toolMsgs[0].tool_call_id, "c1");
  assert.equal(toolMsgs[1].tool_call_id, "c2");
});
