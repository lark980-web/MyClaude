import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, readFileSync, mkdtempSync, rmSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CheckpointStore } from "../src/agent/checkpoint.js";

const scratch = () => mkdtempSync(join(tmpdir(), "ckpt-"));

test("persistDir writes snapshot bytes and index metadata", () => {
  const root = scratch();
  const persistDir = join(root, "snaps");
  const target = join(root, "keep.txt");
  try {
    writeFileSync(target, "原始内容", "utf8");

    const store = new CheckpointStore({ persistDir });
    store.capture(target);
    writeFileSync(target, "修改后", "utf8");

    assert.ok(existsSync(join(persistDir, "index.json")), "index written");
    const index = JSON.parse(readFileSync(join(persistDir, "index.json"), "utf8"));
    assert.equal(index.files.length, 1);

    const row = index.files[0];
    assert.equal(row.path, target);
    assert.equal(row.existed, true);
    assert.equal(typeof row.at, "number");
    assert.match(row.stamp, /^[0-9a-f]{16}.snap$/);
    assert.equal(readFileSync(join(persistDir, row.stamp), "utf8"), "原始内容");

    const result = store.restoreAll();
    assert.deepEqual(result.restored, [target]);
    assert.equal(readFileSync(target, "utf8"), "原始内容");

    const after = JSON.parse(readFileSync(join(persistDir, "index.json"), "utf8"));
    assert.deepEqual(after.files, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a new instance can loadFromDisk and restore the earlier contents", () => {
  const root = scratch();
  const persistDir = join(root, "snaps");
  const target = join(root, "survive.txt");
  try {
    writeFileSync(target, "第一次", "utf8");

    const first = new CheckpointStore({ persistDir });
    first.capture(target);
    writeFileSync(target, "第二次", "utf8");

    const second = new CheckpointStore({ persistDir });
    second.loadFromDisk();
    assert.equal(second.size, 1, "snapshot was recovered");
    assert.deepEqual(second.paths(), [target]);

    writeFileSync(target, "第三次", "utf8");
    const r = second.restoreAll();
    assert.deepEqual(r.restored, [target]);
    assert.equal(readFileSync(target, "utf8"), "第一次");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("without persistDir the store stays in memory only", () => {
  const root = scratch();
  const target = join(root, "mem.txt");
  try {
    writeFileSync(target, "v0", "utf8");
    const store = new CheckpointStore();
    store.capture(target);
    assert.equal(store.persistDir, null);
    // Nothing new may appear in the scratch directory.
    assert.deepEqual(readdirSync(root), ["mem.txt"], "no snapshot files written");
    writeFileSync(target, "v1", "utf8");
    const r = store.restoreAll();
    assert.deepEqual(r.restored, [target]);
    assert.equal(readFileSync(target, "utf8"), "v0");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a file that did not exist is removed again on restore", () => {
  const root = scratch();
  const persistDir = join(root, "snaps");
  const target = join(root, "created.txt");
  try {
    const store = new CheckpointStore({ persistDir });
    store.capture(target);
    writeFileSync(target, "new", "utf8");
    const r = store.restoreAll();
    assert.deepEqual(r.deleted, [target]);
    assert.equal(existsSync(target), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
