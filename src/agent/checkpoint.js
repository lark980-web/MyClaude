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
 */
import { existsSync, readFileSync, writeFileSync, statSync, unlinkSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

/** Refuse to snapshot files above this size (bytes). */
const MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024;

export class CheckpointStore {
  constructor() {
    /** @type {Map<string, {existed: boolean, content: string|null}>} */
    this.entries = new Map();
    /** Order of first capture, so a rewind can report what it restored. */
    this.order = [];
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
    const abs = String(filePath);
    if (this.entries.has(abs)) { return; }
    try {
      if (!existsSync(abs)) {
        this.entries.set(abs, { existed: false, content: null });
        this.order.push(abs);
        return;
      }
      const st = statSync(abs);
      if (!st.isFile() || st.size > MAX_SNAPSHOT_BYTES) { return; }
      const buf = readFileSync(abs);
      // A NUL byte means binary; storing it as text would corrupt the restore.
      if (buf.includes(0)) { return; }
      this.entries.set(abs, { existed: true, content: buf });
      this.order.push(abs);
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
  }
}
