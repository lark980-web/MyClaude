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
const PLANS_DIR = join(CONFIG_DIR, "plans");

/**
 * Where the plan for one session is kept.
 *
 * Claude keeps the plan in a project file and offers "/plan open" to edit it in
 * the user`s editor. The plan is written when ExitPlanMode is approved, so a
 * session has at most one live plan and /plan can show it again later.
 *
 * @param {string} id session id
 * @returns {string} absolute path
 */
export function planFile(id) {
  return join(PLANS_DIR, String(id || "unknown") + ".md");
}

/** Read the plan for a session, or null when there is none. */
export function readPlan(id) {
  const f = planFile(id);
  if (!existsSync(f)) { return null; }
  try { return readFileSync(f, "utf8"); } catch { return null; }
}

/** Save the plan for a session. Returns the path written. */
export function savePlan(id, text) {
  if (!existsSync(PLANS_DIR)) { mkdirSync(PLANS_DIR, { recursive: true }); }
  const f = planFile(id);
  writeFileSync(f, String(text || ""), "utf8");
  return f;
}

/** Forget the plan for a session. Returns true when one was removed. */
export function clearPlan(id) {
  const f = planFile(id);
  if (!existsSync(f)) { return false; }
  try { unlinkSync(f); return true; } catch { return false; }
}


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
  // A session with no messages is not worth a file. New-chat used to write one
  // per reset, which is where the pile of 2-message duplicates came from.
  if (!Array.isArray(messages) || messages.length === 0) {
    return null;
  }
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

/**
 * Name a session.
 *
 * The title is capped the way the GUI rename already caps it: a sidebar row
 * is one line, so a very long name would only push the rest of the row out.
 *
 * @param {string} id
 * @param {string} title
 * @returns {boolean} false when the session does not exist
 */
export function setSessionTitle(id, title) {
  ensureSessionsDir();
  const file = join(SESSIONS_DIR, `${id}.json`);
  // Naming a conversation before it has messages is legitimate, so a missing
  // file is created rather than rejected: the title is the reason to keep it.
  let data = null;
  if (existsSync(file)) {
    try { data = JSON.parse(readFileSync(file, "utf8")); } catch { data = null; }
  }
  if (!data) {
    const now = new Date().toISOString();
    data = { id, savedAt: now, updatedAt: now, messages: [], turnCount: 0 };
  }
  data.title = String(title || "").slice(0, 120) || null;
  data.updatedAt = new Date().toISOString();
  // Write through a temp file and rename, the way saveSession does: an
  // interrupted write must not leave a truncated session behind.
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
  renameSync(tmp, file);
  return true;
}

/**
 * Fork a session into a new one with the same history.
 *
 * Claude offers this as /fork and /branch: the conversation splits so you can
 * try two approaches from the same point. The original is left untouched, and
 * nothing on disk outside the sessions directory is involved, so git history
 * stays clean.
 *
 * The copy is a snapshot: later turns in one branch never appear in the other.
 *
 * @param {string} id the session to fork
 * @param {{title?: string}} [opts]
 * @returns {{ok: true, id: string, messages: number} | {ok: false, error: string}}
 */
export function forkSession(id, { title = null } = {}) {
  const source = loadSession(id);
  if (!source) { return { ok: false, error: `no such session: ${id}` }; }
  const messages = Array.isArray(source.messages) ? source.messages : [];
  const newId = newSessionId();
  // An empty fork would be indistinguishable from a fresh chat, so refuse.
  if (!messages.length) { return { ok: false, error: "the session has no history to fork" }; }
  const meta = {
    cwd: source.cwd || null,
    model: source.model || null,
    provider: source.provider || null,
    permissionMode: source.permissionMode || null,
    turnCount: source.turnCount || 0,
    forkedFrom: id,
  };
  const file = saveSession(newId, messages, meta);
  if (!file) { return { ok: false, error: "could not write the forked session" }; }
  if (title) { setSessionTitle(newId, title); }
  return { ok: true, id: newId, messages: messages.length };
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

  /**
   * Stop the saver without writing.
   *
   * dispose() flushes first, which is right when the process is shutting down and
   * wrong when the conversation is being discarded: that flush is what left a
   * duplicate file behind on every "new chat".
   */
  function discard() {
    disposed = true;
    clearTimer();
    return lastFile;
  }

  function dispose() {
    const file = write();
    disposed = true;
    clearTimer();
    return file;
  }

  /**
   * Start a fresh session id (used by /clear and the GUI reset button).
   *
   * The write that happens first archives the conversation being left behind,
   * which is right for /clear and wrong for a resume: resuming a session that
   * is already on disk must not leave a copy of it under the saver's old id.
   * That is how one conversation ended up as two entries in the sidebar.
   */
  function rotate(nextId = null, { archive = true } = {}) {
    if (archive) write();
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
    discard,
    rotate,
  };
}

export { SESSIONS_DIR };
