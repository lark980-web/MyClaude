import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// 用户家目录里的真实技能会漏进这些断言：给测试一个隔离的 MYCLAUDE_HOME，
// 并且必须用动态 import —— 静态 import 会被提升到赋值之前，隔离不生效。
process.env.MYCLAUDE_HOME = mkdtempSync(join(tmpdir(), "myclaude-skills-home-"));
const { loadSkills, findSkill, skillCatalogue, skillDirs, createSkill, deleteSkill } = await import("../src/skills.js");

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
    const skills = loadSkills(root, { builtin: false });
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
    assert.equal(loadSkills(root, { builtin: false }).length, 0, "only directories are skills");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a directory without SKILL.md is not a skill", () => {
  const root = mkdtempSync(join(process.env.TEMP || ".", "skills-nofile-"));
  try {
    mkdirSync(join(root, ".myclaude", "skills", "empty"), { recursive: true });
    assert.equal(loadSkills(root, { builtin: false }).length, 0);
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
    const cat = skillCatalogue(root, { builtin: false });
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

test("skills in .claude/skills (upstream Claude Code layout) are picked up", () => {
  const root = mkdtempSync(join(process.env.TEMP || ".", "skills-claude-"));
  try {
    const base = join(root, ".claude", "skills", "alpha");
    mkdirSync(base, { recursive: true });
    writeFileSync(join(base, "SKILL.md"), "---\ndescription: Alpha from upstream layout\n---\nalpha body\n", "utf8");
    const skills = loadSkills(root, { builtin: false });
    const hit = skills.find((s) => s.name === "alpha");
    assert.ok(hit, "upstream-layout skill must load");
    assert.equal(hit.scope, "project");
    assert.ok(hit.file.includes(".claude"), "file points into .claude/skills");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test(".myclaude/skills overrides a same-named .claude/skills skill", () => {
  const root = mkdtempSync(join(process.env.TEMP || ".", "skills-both-"));
  try {
    for (const [layout, body] of [[".claude", "claude version"], [".myclaude", "myclaude version"]]) {
      const base = join(root, layout, "skills", "dupe");
      mkdirSync(base, { recursive: true });
      writeFileSync(join(base, "SKILL.md"), "---\ndescription: D\n---\n" + body + "\n", "utf8");
    }
    const hit = findSkill("dupe", root);
    assert.ok(hit, "skill found in both layouts");
    assert.match(hit.body, /myclaude version/, "the .myclaude copy wins");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("createSkill writes both layouts; deleteSkill removes both", () => {
  const root = mkdtempSync(join(process.env.TEMP || ".", "skills-crud-"));
  try {
    const r = createSkill({ cwd: root, name: "Bridge Skill", description: "bridge", body: "# bridge\nstep one" });
    assert.ok(r.ok, "createSkill ok: " + (r.error || ""));
    const myPath = join(root, ".myclaude", "skills", "bridge-skill", "SKILL.md");
    const clPath = join(root, ".claude", "skills", "bridge-skill", "SKILL.md");
    for (const f of [myPath, clPath]) {
      assert.ok(existsSync(f), "written to " + f);
    }
    // 名字规范化：大写与空格 → 小写连字符
    assert.equal(findSkill("bridge-skill", root).name, "bridge-skill");
    // 拒绝重复
    const dup = createSkill({ cwd: root, name: "bridge-skill", description: "x", body: "y" });
    assert.equal(dup.ok, false, "duplicate create must fail");
    // 删除双布局
    const d = deleteSkill("bridge-skill", root);
    assert.ok(d.ok);
    for (const f of [myPath, clPath]) {
      assert.equal(existsSync(f), false, "removed " + f);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
