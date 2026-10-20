/**
 * File checkpoints.
 *
 * Before a tool mutates a file we keep its previous contents, so a bad edit
 * can be undone. This is what /rewind needs: rewinding only the conversation
 * leaves the workspace in the broken state the model just produced.
 *
 * Design notes:
 * - Snapshots live in memory, keyed by absolute path, holding the most recent
 *   previous content. Only one level is kept: the goal is "undo what just
 *   happened", not a full version-control system.
 * - Binary and very large files are skipped rather than buffered.
 * - Restoring writes the old bytes back, or deletes the file if it did not
 *   exist before the tool created it.
 * - With persistDir, the same state is mirrored to disk so a later process can
 *   still /rewind. The index records the original absolute path; snapshot files
 *   use a short hash so drive letters and separators never become file names.
 */
import { existsSync, readFileSync, writeFileSync, statSync, unlinkSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";

/** Refuse to snapshot files above this size (bytes). */
const MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024;

const INDEX_NAME = "index.json";
const STAMP_PATTERN = /^[0-9a-f]{16}\.snap$/;

export class CheckpointStore {
  /**
   * @param {{persistDir?: string}} [options] When set, every captured snapshot is
   *   mirrored into that directory so a later process, or a run after a restart,
   *   can still undo the change. Omitting it keeps the store purely in memory,
   *   which is what the existing tests use.
   */
  constructor({ persistDir = null } = {}) {
    /** @type {Map<string, {existed: boolean, content: Buffer|null}>} */
    this.entries = new Map();
    /** Order of first capture, so a rewind can report what it restored. */
    this.order = [];
    /** Directory snapshots are mirrored to, or null for memory-only. */
    this.persistDir = persistDir ? resolve(String(persistDir)) : null;
    /** Rows from index.json, keyed by absolute path. */
    this._index = new Map();
    if (this.persistDir) { this.loadFromDisk(); }
  }

  /**
   * Snapshot file name for a path.
   *
   * Absolute paths carry slashes and a drive letter, neither of which belongs in
   * a file name, so a short digest is used instead and index.json holds the
   * mapping back to the original path.
   */
  _stamp(file) {
    return createHash("sha1").update(file).digest("hex").slice(0, 16) + ".snap";
  }

  _indexPath() {
    return join(this.persistDir, INDEX_NAME);
  }

  /**
   * Memory-only stores keep the caller's path exactly as it was before this
   * feature existed. Persisted stores use an absolute key so a restart from a
   * different working directory still restores the same file.
   */
  _key(filePath) {
    return this.persistDir ? resolve(String(filePath)) : String(filePath);
  }

  _readIndex() {
    if (!this.persistDir) { return []; }
    try {
      const file = this._indexPath();
      if (!existsSync(file)) { return []; }
      const data = JSON.parse(readFileSync(file, "utf8"));
      return data && Array.isArray(data.files) ? data.files : [];
    } catch {
      // A damaged index must not stop the agent from starting.
      return [];
    }
  }

  _writeIndex() {
    if (!this.persistDir) { return; }
    try {
      mkdirSync(this.persistDir, { recursive: true });
      writeFileSync(
        this._indexPath(),
        JSON.stringify({ version: 1, files: [...this._index.values()] }, null, 2),
        "utf8",
      );
    } catch {
      // Losing the index is better than failing the edit that follows.
    }
  }

  /**
   * Merge snapshots recorded by an earlier process into this store.
   *
   * Existing in-memory captures win, so calling this after a capture does not
   * replace newer state with an older index. Missing or corrupt snapshot files
   * are skipped individually; one bad row does not discard the rest.
   */
  loadFromDisk() {
    if (!this.persistDir) { return this; }
    for (const row of this._readIndex()) {
      if (!row || typeof row.path !== "string" || typeof row.stamp !== "string") {
        continue;
      }
      if (!STAMP_PATTERN.test(row.stamp)) { continue; }

      const abs = resolve(row.path);
      const existed = row.existed !== false;
      try {
        if (existed) {
          const snap = join(this.persistDir, row.stamp);
          if (!existsSync(snap)) { continue; }
          if (!this.entries.has(abs)) {
            this.entries.set(abs, { existed: true, content: readFileSync(snap) });
            this.order.push(abs);
          }
        } else if (!this.entries.has(abs)) {
          this.entries.set(abs, { existed: false, content: null });
          this.order.push(abs);
        }
        this._index.set(abs, {
          path: abs,
          stamp: row.stamp,
          existed,
          at: typeof row.at === "number" ? row.at : Date.now(),
        });
      } catch {
        // A damaged snapshot must not stop the agent from starting.
      }
    }
    return this;
  }

  /** Persist one snapshot and record it in the index. */
  _publish(abs, entry) {
    if (!this.persistDir) { return; }
    try {
      mkdirSync(this.persistDir, { recursive: true });
      const stamp = this._stamp(abs);
      if (entry.existed) {
        writeFileSync(join(this.persistDir, stamp), entry.content);
      } else {
        // The file did not exist at capture time, so there is no payload. Drop
        // any older snapshot for the same path so it cannot be restored later.
        const previous = this._index.get(abs);
        if (previous && STAMP_PATTERN.test(previous.stamp)) {
          const old = join(this.persistDir, previous.stamp);
          if (existsSync(old)) { unlinkSync(old); }
        }
      }
      this._index.set(abs, {
        path: abs,
        stamp,
        existed: !!entry.existed,
        at: Date.now(),
      });
      this._writeIndex();
    } catch {
      // Losing a snapshot is better than failing the edit that follows.
    }
  }

  /**
   * Remember a file's current state before it is changed.
   *
   * Capturing is idempotent per path: once a file has been recorded, later
   * edits within the same turn do not overwrite the original snapshot — the
   * point is to get back to where the turn started.
   */
  capture(filePath) {
    if (!filePath) { return; }
    const abs = this._key(filePath);
    if (this.entries.has(abs)) { return; }
    try {
      if (!existsSync(abs)) {
        this.entries.set(abs, { existed: false, content: null });
        this.order.push(abs);
        this._publish(abs, this.entries.get(abs));
        return;
      }
      const st = statSync(abs);
      if (!st.isFile() || st.size > MAX_SNAPSHOT_BYTES) { return; }
      const buf = readFileSync(abs);
      // A NUL byte means binary; storing it as text would corrupt the restore.
      if (buf.includes(0)) { return; }
      this.entries.set(abs, { existed: true, content: buf });
      this.order.push(abs);
      this._publish(abs, this.entries.get(abs));
    } catch {
      // A snapshot failure must never block the edit itself.
    }
  }

  /** True when there is anything to undo. */
  get size() { return this.entries.size; }

  /** Paths captured so far, in capture order. */
  paths() { return [...this.order]; }

  /**
   * Put every captured file back the way it was.
   *
   * @returns {{restored: string[], deleted: string[], failed: Array<{path: string, error: string}>}}
   */
  restoreAll() {
    const restored = [];
    const deleted = [];
    const failed = [];
    for (const abs of this.order) {
      const entry = this.entries.get(abs);
      if (!entry) { continue; }
      try {
        if (entry.existed) {
          mkdirSync(dirname(abs), { recursive: true });
          writeFileSync(abs, entry.content);
          restored.push(abs);
        } else if (existsSync(abs)) {
          // The tool created this file; undo by removing it.
          unlinkSync(abs);
          deleted.push(abs);
        }
      } catch (e) {
        failed.push({ path: abs, error: String(e && e.message ? e.message : e) });
      }
    }
    this.clear();
    return { restored, deleted, failed };
  }

  /** Forget everything captured (after a successful rewind or a new turn). */
  clear() {
    this.entries.clear();
    this.order = [];
    if (!this.persistDir) {
      this._index.clear();
      return;
    }
    for (const row of this._index.values()) {
      try {
        if (row && STAMP_PATTERN.test(row.stamp)) {
          const snap = join(this.persistDir, row.stamp);
          if (existsSync(snap)) { unlinkSync(snap); }
        }
      } catch {
        // A stale snapshot is harmless; index cleanup still proceeds.
      }
    }
    this._index.clear();
    this._writeIndex();
  }
}
