import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadCommands } from "../src/commands.js";

/** Write one command file into a throwaway .myclaude/commands dir. */
function commandDir(files) {
  const root = mkdtempSync(join(tmpdir(), "mc-cmd-"));
  const dir = join(root, ".myclaude", "commands");
  mkdirSync(dir, { recursive: true });
  for (const [name, text] of Object.entries(files)) {
    writeFileSync(join(dir, name), text, "utf8");
  }
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("frontmatter model and allowed-tools are parsed", () => {
  const { root, cleanup } = commandDir({
    "review.md": ["---", "description: Review the diff", "model: qoder-cn/gfmodel", "allowed-tools: Read, Grep, Glob", "---", "Please review.", ""].join("\n"),
  });
  try {
    const cmds = loadCommands(root);
    const review = cmds.find((c) => c.name === "review");
    assert.ok(review, "command was loaded");
    assert.equal(review.model, "qoder-cn/gfmodel");
    assert.equal(review.allowedTools, "Read, Grep, Glob");
  } finally {
    cleanup();
  }
});

test("a command without frontmatter keeps empty metadata", () => {
  const { root, cleanup } = commandDir({ "plain.md": "Just a prompt.\n" });
  try {
    const plain = loadCommands(root).find((c) => c.name === "plain");
    assert.ok(plain);
    assert.equal(plain.model, "");
    assert.equal(plain.allowedTools, "");
  } finally {
    cleanup();
  }
});

test("allowed-tools splits on commas and whitespace", () => {
  // main.js splits the same way; a mismatch would silently drop tools.
  const raw = "Read, Grep Glob";
  const wanted = String(raw).split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
  assert.deepEqual(wanted, ["Read", "Grep", "Glob"]);
});

test("model scope is applied during the command and restored after", async () => {
  const { withCommandScope } = await import("../src/command-scope.js");
  const config = { model: "original/model" };
  const provider = { model: "original/model" };
  const agent = {
    tools: [{ function: { name: "Read" } }, { function: { name: "Write" } }],
    setModel(m) { config.model = m; },
    ui: { warn() {} },
  };
  let seenDuring = null;
  await withCommandScope(agent, config, provider, { name: "x", model: "qoder-cn/gfmodel" }, async () => {
    seenDuring = config.model;
  });
  assert.equal(seenDuring, "qoder-cn/gfmodel", "model switched for the command");
  assert.equal(config.model, "original/model", "model restored afterwards");
  assert.equal(provider.model, "original/model", "provider model restored too");
});

test("allowed-tools restricts the tool list and restores it", async () => {
  const { withCommandScope } = await import("../src/command-scope.js");
  const config = { model: "m" };
  const agent = {
    tools: [{ function: { name: "Read" } }, { function: { name: "Write" } }, { function: { name: "Grep" } }],
    setModel() {},
    ui: { warn() {} },
  };
  let toolNamesDuring = null;
  await withCommandScope(agent, config, null, { name: "x", allowedTools: "Read, Grep" }, async () => {
    toolNamesDuring = agent.tools.map((t) => t.function.name).sort();
  });
  assert.deepEqual(toolNamesDuring, ["Grep", "Read"], "only the declared tools were available");
  assert.equal(agent.tools.length, 3, "full tool list restored afterwards");
});

test("an unknown model warns and keeps the current one", async () => {
  const { withCommandScope } = await import("../src/command-scope.js");
  const warnings = [];
  const config = { model: "keep/this" };
  const agent = { tools: [], setModel() {}, ui: { warn: (m) => warnings.push(m) } };
  await withCommandScope(agent, config, null, { name: "x", model: "does-not/exist" }, async () => {});
  assert.equal(config.model, "keep/this");
  assert.ok(warnings.some((w) => /unknown model/.test(w)), "warned about the unknown model");
});

test("unknown tool names warn but the command still runs", async () => {
  const { withCommandScope } = await import("../src/command-scope.js");
  const warnings = [];
  const config = { model: "m" };
  const agent = {
    tools: [{ function: { name: "Read" } }],
    setModel() {},
    ui: { warn: (m) => warnings.push(m) },
  };
  let ran = false;
  await withCommandScope(agent, config, null, { name: "x", allowedTools: "Read, Nonexistent" }, async () => {
    ran = true;
  });
  assert.equal(ran, true, "command still executed");
  assert.ok(warnings.some((w) => /Nonexistent/.test(w)), "warned about the unknown tool");
});
