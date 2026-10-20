import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import { loadSkills, findSkill, skillCatalogue, skillDirs } from "../src/skills.js";

/**
 * Build a fake workspace: <root>/.myclaude/skills/<name>/SKILL.md
 * Returns the root and a cleanup function.
 */
function workspace(skills = {}) {
  const root = mkdtempSync(join(process.env.TEMP || ".", "skills-"));
  const base = join(root, ".myclaude", "skills");
  for (const [name, text] of Object.entries(skills)) {
    mkdirSync(join(base, name), { recursive: true });
    writeFileSync(join(base, name, "SKILL.md"), text, "utf8");
  }
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("a skill is a directory containing SKILL.md", () => {
  const { root, cleanup } = workspace({
    review: "---\ndescription: Review the diff\n---\nPlease review carefully.\n",
  });
  try {
    const skills = loadSkills(root);
    assert.equal(skills.length, 1);
    assert.equal(skills[0].name, "review");
    assert.equal(skills[0].description, "Review the diff");
    assert.match(skills[0].body, /Please review carefully/);
    assert.equal(skills[0].scope, "project");
    assert.ok(skills[0].file.endsWith("SKILL.md"));
  } finally {
    cleanup();
  }
});

test("a loose SKILL.md without a directory is ignored", () => {
  const root = mkdtempSync(join(process.env.TEMP || ".", "skills-loose-"));
  try {
    const base = join(root, ".myclaude", "skills");
    mkdirSync(base, { recursive: true });
    writeFileSync(join(base, "SKILL.md"), "---\ndescription: stray\n---\nbody\n", "utf8");
    assert.equal(loadSkills(root).length, 0, "only directories are skills");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a directory without SKILL.md is not a skill", () => {
  const root = mkdtempSync(join(process.env.TEMP || ".", "skills-nofile-"));
  try {
    mkdirSync(join(root, ".myclaude", "skills", "empty"), { recursive: true });
    assert.equal(loadSkills(root).length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("description falls back to the first body line", () => {
  const { root, cleanup } = workspace({ plain: "Just a body with no frontmatter.\n" });
  try {
    const found = findSkill("plain", root);
    assert.ok(found);
    assert.equal(found.description, "Just a body with no frontmatter.");
  } finally {
    cleanup();
  }
});

test("allowed-tools is read from frontmatter", () => {
  const { root, cleanup } = workspace({
    scan: "---\ndescription: Scan\nallowed-tools: Read, Grep\n---\nbody\n",
  });
  try {
    assert.equal(findSkill("scan", root).allowedTools, "Read, Grep");
  } finally {
    cleanup();
  }
});

test("catalogue carries only name and description", () => {
  const { root, cleanup } = workspace({
    one: "---\ndescription: First\n---\nbody one\n",
  });
  try {
    const cat = skillCatalogue(root);
    assert.deepEqual(cat, [{ name: "one", description: "First" }]);
    // The body must not leak into the catalogue: it would bloat every request.
    assert.ok(!("body" in cat[0]));
  } finally {
    cleanup();
  }
});

test("findSkill is case-insensitive and returns null when missing", () => {
  const { root, cleanup } = workspace({ Review: "---\ndescription: R\n---\nb\n" });
  try {
    assert.ok(findSkill("REVIEW", root));
    assert.equal(findSkill("nope", root), null);
  } finally {
    cleanup();
  }
});

test("skillDirs reports the project directory", () => {
  const { root, cleanup } = workspace({ a: "---\ndescription: A\n---\nb\n" });
  try {
    const dirs = skillDirs(root);
    assert.ok(dirs.some((d) => d.scope === "project" && d.dir.includes(".myclaude")));
  } finally {
    cleanup();
  }
});
