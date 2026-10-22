/**
 * /effort and /fast.
 *
 * Both are session settings that outlive the command, so the tests check the
 * value is stored rather than only echoed back.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

process.env.MYCLAUDE_HOME = mkdtempSync(join(process.env.TEMP || ".", "effort-"));
const { loadConfig, saveConfig, configPath } = await import("../src/config.js");

test("the default effort is unset", () => {
  const cfg = loadConfig();
  assert.equal(cfg.effort ?? null, null);
  assert.equal(cfg.fastMode, false);
});

test("effort persists to the config file", () => {
  saveConfig({ effort: "high" });
  const onDisk = JSON.parse(readFileSync(configPath(), "utf8"));
  assert.equal(onDisk.effort, "high");
  assert.equal(loadConfig().effort, "high");
});

test("effort off clears the setting", () => {
  saveConfig({ effort: "low" });
  assert.equal(loadConfig().effort, "low");
  saveConfig({ effort: null });
  assert.equal(loadConfig().effort ?? null, null);
});

test("fast mode toggles and persists", () => {
  saveConfig({ fastMode: true });
  assert.equal(loadConfig().fastMode, true);
  const onDisk = JSON.parse(readFileSync(configPath(), "utf8"));
  assert.equal(onDisk.fastMode, true);
  saveConfig({ fastMode: false });
  assert.equal(loadConfig().fastMode, false);
});

test("an unrelated key survives an effort change", () => {
  // saveConfig merges, so writing one setting must not drop others.
  saveConfig({ model: "keep-me", effort: "medium" });
  const cfg = loadConfig();
  assert.equal(cfg.effort, "medium");
  assert.equal(cfg.model, "keep-me");
});
