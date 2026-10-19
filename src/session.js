/**
 * Session persistence.
 *
 * Every interactive run gets a session id and an auto-saver that writes the
 * conversation to ~/.myclaude/sessions/<id>.json after each turn. Saves are
 * throttled (default 1s) and flushed on exit so a crash loses at most the
 * current turn instead of the whole history.
 */
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  existsSync,
  unlinkSync,
  renameSync,
} from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { CONFIG_DIR } from "./config.js";

const SESSIONS_DIR = join(CONFIG_DIR, "sessions");

export const DEFAULT_AUTOSAVE_INTERVAL_MS = 1000;
export const DEFAULT_SESSION_KEEP = 50;

export function ensureSessionsDir() {
  if (!existsSync(SESSIONS_DIR)) mkdirSync(SESSIONS_DIR, { recursive: true });
  return SESSIONS_DIR;
}

export function newSessionId() {
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const rand = randomBytes(3).toString("hex");
  return `${ts}_${rand}`;
}

/**
 * Write a session file atomically (tmp + rename) so an interrupted write never
 * leaves a truncated JSON file behind.
 *
 * @param {string} id
 * @param {Array<object>} messages
 * @param {object} [meta] extra fields such as cwd, model, turnCount
 */
export function saveSession(id, messages, meta = {}) {
  ensureSessionsDir();
  const file = join(SESSIONS_DIR, `${id}.json`);
  const tmp = `${file}.${process.pid}.tmp`;
  const now = new Date().toISOString();
  let prev = null;
  if (existsSync(file)) {
    try {
      prev = JSON.parse(readFileSync(file, "utf8"));
    } catch {}
  }
  const payload = {
    id,
    savedAt: prev?.savedAt || now,
    updatedAt: now,
    ...(prev?.title !== undefined ? { title: prev.title } : {}),
    ...(prev?.pinned !== undefined ? { pinned: prev.pinned } : {}),
    ...(prev?.archived !== undefined ? { archived: prev.archived } : {}),
    ...(prev?.unarchived !== undefined ? { unarchived: prev.unarchived } : {}),
    ...meta,
    messages: messages || [],
  };
  writeFileSync(tmp, JSON.stringify(payload, null, 2), "utf8");
  renameSync(tmp, file);
  return file;
}

export function loadSession(id) {
  const file = join(SESSIONS_DIR, `${id}.json`);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

export function sessionFile(id) {
  return join(SESSIONS_DIR, `${id}.json`);
}

export function listSessions() {
  ensureSessionsDir();
  return readdirSync(SESSIONS_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => {
      const full = join(SESSIONS_DIR, f);
      try {
        const data = JSON.parse(readFileSync(full, "utf8"));
        return {
          id: data.id,
          savedAt: data.savedAt,
          updatedAt: data.updatedAt ?? data.savedAt,
          messages: data.messages?.length ?? 0,
          cwd: data.cwd ?? null,
          model: data.model ?? null,
          turns: data.turnCount ?? null,
          title: data.title ?? null,
          pinned: data.pinned === true,
          archived: data.archived === true,
          unarchived: data.unarchived === true,
        };
      } catch {
        return { id: f.replace(/\.json$/, ""), savedAt: null, messages: 0 };
      }
    })
    .sort((a, b) => String(b.updatedAt ?? b.savedAt).localeCompare(String(a.updatedAt ?? a.savedAt)));
}

/** Most recently updated session, optionally filtered to one working directory. */
export function latestSession({ cwd = null } = {}) {
  const list = listSessions().filter((s) => !cwd || s.cwd === cwd);
  return list[0] ?? null;
}

export function deleteSession(id) {
  const file = join(SESSIONS_DIR, `${id}.json`);
  if (!existsSync(file)) return false;
  unlinkSync(file);
  return true;
}

/**
 * Keep the newest `keep` sessions (and drop anything older than `maxAgeDays`
 * when provided). Returns the ids that were removed.
 */
export function pruneSessions({ keep = DEFAULT_SESSION_KEEP, maxAgeDays = null } = {}) {
  const list = listSessions();
  const removed = [];
  const cutoff = maxAgeDays ? Date.now() - maxAgeDays * 86400_000 : null;
  list.forEach((s, i) => {
    const stale = cutoff != null && s.updatedAt && Date.parse(s.updatedAt) < cutoff;
    if (i >= keep || stale) {
      if (deleteSession(s.id)) removed.push(s.id);
    }
  });
  return removed;
}

/**
 * Throttled auto-save handle bound to one conversation.
 *
 * @param {object} opts
 * @param {string} [opts.id]            session id (a new one is generated)
 * @param {() => Array<object>} opts.getMessages
 * @param {() => object} [opts.getMeta] extra metadata written with each save
 * @param {number} [opts.intervalMs]    minimum time between writes
 */
export function createAutoSaver({ id, getMessages, getMeta, intervalMs = DEFAULT_AUTOSAVE_INTERVAL_MS } = {}) {
  let sessionId = id || newSessionId();
  let lastSaved = 0;
  let timer = null;
  let pending = false;
  let disposed = false;
  let lastFile = null;

  const meta = () => {
    try {
      return getMeta?.() ?? {};
    } catch {
      return {};
    }
  };

  function write() {
    if (disposed && !pending) return lastFile;
    pending = false;
    clearTimer();
    try {
      lastFile = saveSession(sessionId, getMessages?.() ?? [], meta());
      lastSaved = Date.now();
    } catch {
      // Auto-save must never break a conversation (disk full, permissions, …).
    }
    return lastFile;
  }

  function clearTimer() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  }

  /**
   * Record the current state. Writes immediately when the throttle window has
   * elapsed, otherwise schedules a trailing write.
   */
  function save({ force = false } = {}) {
    if (disposed && !force) return lastFile;
    const wait = intervalMs - (Date.now() - lastSaved);
    if (force || wait <= 0) return write();
    pending = true;
    if (!timer) {
      timer = setTimeout(() => {
        timer = null;
        if (pending) write();
      }, wait);
      timer.unref?.();
    }
    return lastFile;
  }

  /** Write now, even if the throttle window has not elapsed. */
  function flush() {
    return write();
  }

  function dispose() {
    const file = write();
    disposed = true;
    clearTimer();
    return file;
  }

  /** Start a fresh session id (used by /clear and the GUI reset button). */
  function rotate(nextId = null) {
    write();
    sessionId = nextId || newSessionId();
    lastSaved = 0;
    pending = false;
    lastFile = null;
    return sessionId;
  }

  return {
    get id() {
      return sessionId;
    },
    get lastSaved() {
      return lastSaved;
    },
    get file() {
      return lastFile;
    },
    save,
    flush,
    dispose,
    rotate,
  };
}

export { SESSIONS_DIR };
