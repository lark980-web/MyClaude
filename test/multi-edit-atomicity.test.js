/**
 * MultiEdit 原子性行为测试（逻辑层）：
 * 上游描述 "All edits are validated first; if any fails, nothing is written."
 * 即：全部验证后才写入，任何一个失败 → 整体不落盘。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.MYCLAUDE_HOME = mkdtempSync(join(tmpdir(), 'myclaude-medit-'));
const { multiEditTool } = await import('../src/tools/index.js');

const WORK = mkdtempSync(join(tmpdir(), 'medit-work-'));
const setup = (content) => {
  const f = join(WORK, 'test-' + Date.now() + '-' + Math.random().toString(36).slice(2) + '.txt');
  writeFileSync(f, content, 'utf8');
  return f;
};

test('MultiEdit 原子性：全部成功 → 所有替换落盘', async () => {
  const f = setup('alpha beta gamma delta');
  const r = await multiEditTool.run({ file_path: f, edits: [
    { old_string: 'alpha', new_string: 'ALPHA' },
    { old_string: 'gamma', new_string: 'GAMMA' },
  ]});
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.match(readFileSync(f, 'utf8'), /ALPHA beta GAMMA delta/);
});

test('MultiEdit 原子性：一个失败 → 什么都不写入', async () => {
  const original = 'alpha beta gamma delta';
  const f = setup(original);
  const r = await multiEditTool.run({ file_path: f, edits: [
    { old_string: 'alpha', new_string: 'ALPHA' }, // 会成功
    { old_string: 'nonexistent_string', new_string: 'NEVER' }, // 会失败
  ]});
  assert.equal(r.ok, false, '第二个失败 → 整体返回 false');
  // 原文件不被修改（原子性：nothing is written）
  assert.equal(readFileSync(f, 'utf8'), original, '原文件未被修改（原子性）');
});

test('MultiEdit 原子性：第一个就失败 → 后续不执行', async () => {
  const original = 'alpha beta gamma';
  const f = setup(original);
  const r = await multiEditTool.run({ file_path: f, edits: [
    { old_string: 'MISSING', new_string: 'X' },
    { old_string: 'alpha', new_string: 'ALPHA' },
  ]});
  assert.equal(r.ok, false);
  assert.equal(readFileSync(f, 'utf8'), original, '第一个失败后续不执行');
});

test('MultiEdit 原子性：文件不存在 → 错误且不创建', async () => {
  const f = join(WORK, 'nonexistent-' + Date.now() + '.txt');
  const r = await multiEditTool.run({ file_path: f, edits: [
    { old_string: 'a', new_string: 'b' },
  ]});
  assert.equal(r.ok, false, '文件不存在报错');
  assert.equal(existsSync(f), false, '不创建不存在的文件');
});

test('MultiEdit: replace_all 只影响目标项', async () => {
  const f = setup('a b a b a b');
  const r = await multiEditTool.run({ file_path: f, edits: [
    { old_string: 'a', new_string: 'X', replace_all: true },
  ]});
  assert.equal(r.ok, true);
  assert.equal(readFileSync(f, 'utf8'), 'X b X b X b');
});

test('MultiEdit: 空编辑列表 → ok 但无操作', async () => {
  const original = 'nothing changes';
  const f = setup(original);
  const r = await multiEditTool.run({ file_path: f, edits: [] });
  assert.equal(readFileSync(f, 'utf8'), original);
});
