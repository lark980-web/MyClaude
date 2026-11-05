import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadMemory } from "../src/agent/permissions.js";

function ws() {
  const root = mkdtempSync(join(tmpdir(), "mem-"));
  mkdirSync(join(root, ".git"), { recursive: true });
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("project memory is loaded exactly once", () => {
  // Windows 与 macOS 大小写不敏感：MYCLAUDE.md 与 myclaude.md 是同一个文件，
  // 按字面路径去重会把同一份内存读两遍（每轮请求白多一份）。
  const { root, cleanup } = ws();
  try {
    writeFileSync(join(root, "MYCLAUDE.md"), "# proj\n\nrules here\n", "utf8");
    const mem = loadMemory(root);
    assert.ok(mem, "memory found");
    const hits = (mem.match(/# From /g) || []).length;
    assert.equal(hits, 1, "one memory file, one section");
    assert.equal((mem.match(/rules here/g) || []).length, 1, "body appears once");
  } finally { cleanup(); }
});

test("memory walks up to the git root", () => {
  const { root, cleanup } = ws();
  try {
    writeFileSync(join(root, "MYCLAUDE.md"), "root rules\n", "utf8");
    const nested = join(root, "src", "deep");
    mkdirSync(nested, { recursive: true });
    const mem = loadMemory(nested);
    assert.ok(mem && mem.includes("root rules"), "ancestor memory still found");
  } finally { cleanup(); }
});

test("no memory file means no memory section", () => {
  const { root, cleanup } = ws();
  try { assert.equal(loadMemory(root), null); } finally { cleanup(); }
});
