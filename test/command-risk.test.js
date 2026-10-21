import test from "node:test";
import assert from "node:assert/strict";

import { isDestructiveCommand, isCommonFileCommand } from "../src/agent/modes.js";

test("destructive commands are recognised", () => {
  for (const cmd of [
    "rm -rf /",
    "rm -rf node_modules",
    "del /s /q C:\\temp",
    "Remove-Item -Recurse -Force build",
    "git push --force origin main",
    "git reset --hard HEAD~5",
    "git clean -fd",
    "npm publish",
    "format C:",
    "shutdown /s /t 0",
    "taskkill /F /T /FI",
    "chmod 777 /etc/passwd",
    "reg add HKLM\\Software\\X",
  ]) {
    assert.equal(isDestructiveCommand(cmd), true, cmd);
  }
});

test("ordinary commands are not destructive", () => {
  for (const cmd of [
    "ls -la",
    "npm test",
    "node --version",
    "git status",
    "git log --oneline -5",
    "echo hello",
    "cargo build --release",
  ]) {
    assert.equal(isDestructiveCommand(cmd), false, cmd);
  }
});

test("a destructive command is not treated as a common file command", () => {
  assert.equal(isCommonFileCommand("npm test"), true);
  assert.equal(isCommonFileCommand("rm -rf node_modules"), false);
});

test("chained commands are never treated as common", () => {
  // A chain is only as safe as its riskiest part, so the classifier refuses to
  // call it safe at all.
  for (const cmd of [
    "npm test && rm -rf dist",
    "npm test; rm -rf dist",
    "npm test | tee log.txt",
    "cat file | sh",
  ]) {
    assert.equal(isCommonFileCommand(cmd), false, cmd);
  }
});
