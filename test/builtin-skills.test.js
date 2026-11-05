import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSkills, skillCatalogue, findSkill } from "../src/skills.js";
import { BUILTIN_SKILLS } from "../src/skills-builtin.js";

test("builtin verify skill ships with the binary", () => {
  assert.ok(BUILTIN_SKILLS.some((s) => s.name === "verify"), "verify is builtin");
  const all = loadSkills();
  const v = all.find((s) => s.name === "verify");
  assert.ok(v, "loaded");
  assert.equal(v.scope, "builtin");
  assert.equal(v.file, "(builtin)");
});

test("builtin verify keeps the runtime-observation discipline", () => {
  const body = BUILTIN_SKILLS.find((s) => s.name === "verify").body;
  for (const k of [
    "Verification is runtime observation",
    "Don't run tests. Don't typecheck.",
    "Don't import-and-call",
    "Internal function? Not a surface",
    "No partial pass",
    "When in doubt, FAIL",
  ]) assert.ok(body.includes(k), "missing: " + k);
  // 上游路径必须本地化
  assert.ok(!body.includes(".claude/skills"), ".claude/skills must be localized");
  assert.ok(body.includes(".myclaude/skills"), ".myclaude/skills referenced");
  // 表面 playbook：verify 只说「去驱动表面」不够，每种表面要给出可执行的驱动方式。
  for (const k of [
    "## Surface playbooks",
    "the evidence is stdout, stderr **and the exit code**",
    "status, headers and body",
    "poll for a ready marker before capturing the pane",
    "import the package boundary, not the internal module",
  ]) assert.ok(body.includes(k), "missing playbook: " + k);
  for (const phantom of ["run-skill-generator", "SendUserFile", "gh pr diff"]) {
    assert.ok(!body.includes(phantom), "upstream-only reference: " + phantom);
  }
});

test("a project skill of the same name overrides the builtin", () => {
  const root = mkdtempSync(join(tmpdir(), "skill-override-"));
  const dir = join(root, ".myclaude", "skills", "verify");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), "---\nname: verify\ndescription: project override\n---\n\nbody here\n", "utf8");
  const found = findSkill("verify", root);
  assert.ok(found, "found");
  assert.equal(found.scope, "project", "project scope wins");
  assert.equal(found.description, "project override");
});

test("the catalogue advertises the builtin skill to the model", () => {
  const cat = skillCatalogue();
  const v = cat.find((s) => s.name === "verify");
  assert.ok(v, "in catalogue");
  assert.ok(v.description.length > 30, "description is informative");
});
