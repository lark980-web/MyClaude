/**
 * Git tools.
 *
 * Instead of letting the agent shell out through Bash (no permission
 * granularity, unstructured text), these expose the commands an agent really
 * needs, with stable output the GUI can render. GitDiff returns a parsed diff
 * so the client can colour it line by line.
 */
import { exec } from "node:child_process";

function ok(content, extra) {
  return Object.assign({ ok: true, content: content }, extra || {});
}
function err(content) {
  return { ok: false, content: content };
}

const MAX_OUTPUT = 40000;

function truncate(text, limit) {
  const max = limit || MAX_OUTPUT;
  const value = String(text == null ? "" : text);
  return value.length <= max ? value : value.slice(0, max) + "\n...[truncated " + (value.length - max) + " chars]";
}

/**
 * Quote a value for a PowerShell / cmd command line.
 * Doubling embedded double quotes and wrapping the whole thing is the portable
 * form that both shells accept.
 */
function shellArg(value) {
  return '"' + String(value).replace(/"/g, '""') + '"';
}

/** Quote a path (or revision) that may contain spaces. */
function shellPath(value) {
  return shellArg(value);
}

/** Run git inside a repo and capture stdout/stderr. */
function git(args, cwd) {
  return new Promise(function (resolvePromise) {
    exec("git " + args, { cwd: cwd, maxBuffer: 16 * 1024 * 1024, windowsHide: true }, function (error, stdout, stderr) {
      resolvePromise({
        ok: !error,
        stdout: String(stdout || ""),
        stderr: String(stderr || ""),
        code: error && typeof error.code === "number" ? error.code : null
      });
    });
  });
}

/** Surface git own error text, trimmed, when a command fails. */
function unwrap(result) {
  if (!result.ok) {
    return err(truncate((result.stderr || result.stdout || "git failed").trim()));
  }
  return null;
}

/* --------------------------------------------------------------- 结构化 diff */

/**
 * Parse a unified diff into hunks the client can colour.
 *
 * Returns { files: [{ name, added, removed, hunks: [{ header, lines: [{ type, text }] }] }] }.
 * Lines are typed "add" | "del" | "ctx" | "meta".
 */
export function parseUnifiedDiff(text) {
  const files = [];
  let current = null;

  const lines = String(text || "").split(/\r?\n/);
  for (const raw of lines) {
    if (raw.startsWith("diff --git")) {
      const m = /b\/(.+)$/.exec(raw);
      current = { name: m ? m[1] : raw, added: 0, removed: 0, hunks: [] };
      files.push(current);
      continue;
    }
    if (!current) { continue; }

    if (raw.startsWith("@@")) {
      current.hunks.push({ header: raw, lines: [] });
      continue;
    }
    // ---/+++ introduce the file; they are metadata, not content lines.
    if (raw.startsWith("--- ") || raw.startsWith("+++ ")) {
      if (raw.startsWith("--- ")) {
        current.oldPath = raw.slice(4).replace(/^a\//, "");
      } else {
        current.newPath = raw.slice(4).replace(/^b\//, "");
      }
      current.hunks.push({ header: null, lines: [{ type: "meta", text: raw }] });
      continue;
    }
    if (raw.startsWith("index ") || raw.startsWith("new file") ||
        raw.startsWith("deleted file") || raw.startsWith("old mode") ||
        raw.startsWith("new mode") || raw.startsWith("similarity index") ||
        raw.startsWith("rename from") || raw.startsWith("rename to") ||
        raw.startsWith("copy from") || raw.startsWith("copy to")) {
      current.hunks.push({ header: null, lines: [{ type: "meta", text: raw }] });
      continue;
    }
    const hunk = current.hunks[current.hunks.length - 1];
    if (!hunk || hunk.header === null) {
      current.hunks.push({ header: null, lines: [{ type: "meta", text: raw }] });
      continue;
    }

    if (raw.startsWith("+")) {
      hunk.lines.push({ type: "add", text: raw.slice(1) });
      current.added++;
    } else if (raw.startsWith("-")) {
      hunk.lines.push({ type: "del", text: raw.slice(1) });
      current.removed++;
    } else if (raw.startsWith("\\")) {
      hunk.lines.push({ type: "meta", text: raw });
    } else {
      hunk.lines.push({ type: "ctx", text: raw.replace(/^ /, "") });
    }
  }
  return files;
}

/** Human one-liner summarising a diff: 3 files, +42 / -17. */
export function diffSummary(files) {
  if (!files || !files.length) { return "(no changes)"; }
  const added = files.reduce((s, f) => s + f.added, 0);
  const removed = files.reduce((s, f) => s + f.removed, 0);
  const names = files.map((f) => f.name).join(", ");
  return files.length + " file" + (files.length > 1 ? "s" : "") + ", +" + added + " / -" + removed + "  " + names;
}

/* =============================================================== GitStatus === */

export const gitStatusTool = {
  name: "GitStatus",
  description:
    "Show the working tree status: current branch, staged/unstaged/untracked files, " +
    "ahead/behind counts and recent commits. Read-only.",
  input_schema: {
    type: "object",
    properties: {
      cwd: { type: "string", description: "Any directory inside the repository (default: cwd)" }
    }
  },
  async run({ cwd = process.cwd() }) {
    const branch = await git("rev-parse --abbrev-ref HEAD", cwd);
    if (!branch.ok) {
      return err("not a git repository (or git is not installed): " + branch.stderr.trim());
    }

    const status = await git("status --porcelain=v1 --branch", cwd);
    const failure = unwrap(status);
    if (failure) { return failure; }

    const lines = status.stdout.split(/\r?\n/).filter(Boolean);
    const branchLine = lines.find((l) => l.startsWith("##")) || "";
    const entries = lines.filter((l) => !l.startsWith("##"));

    const staged = [];
    const unstaged = [];
    const untracked = [];
    for (const line of entries) {
      const x = line[0];
      const y = line[1];
      const file = line.slice(3);
      if (x === "?") { untracked.push(file); continue; }
      if (x !== " " && x !== undefined) { staged.push(x + " " + file); }
      if (y !== " " && y !== undefined) { unstaged.push(y + " " + file); }
    }

    const log = await git("log --oneline -5", cwd);
    const recent = log.ok ? log.stdout.trim().split(/\r?\n/).filter(Boolean) : [];

    const text = [
      "branch: " + branch.stdout.trim(),
      branchLine.replace("## ", "") || null,
      "",
      "staged (" + staged.length + "):",
      staged.length ? staged.map((s) => "  " + s).join("\n") : "  (none)",
      "",
      "unstaged (" + unstaged.length + "):",
      unstaged.length ? unstaged.map((s) => "  " + s).join("\n") : "  (none)",
      "",
      "untracked (" + untracked.length + "):",
      untracked.length ? untracked.map((s) => "  " + s).join("\n") : "  (none)",
      "",
      "recent commits:",
      recent.length ? recent.map((s) => "  " + s).join("\n") : "  (none)"
    ]
      .filter((l) => l !== null)
      .join("\n");

    return ok(truncate(text), {
      git: {
        kind: "status",
        branch: branch.stdout.trim(),
        tracking: branchLine.replace("## ", ""),
        staged: staged,
        unstaged: unstaged,
        untracked: untracked,
        recent: recent
      }
    });
  }
};

/* ================================================================ GitDiff === */

export const gitDiffTool = {
  name: "GitDiff",
  description:
    "Show unstaged or staged changes as a unified diff. Provide paths to limit scope. " +
    "Read-only.",
  input_schema: {
    type: "object",
    properties: {
      staged: { type: "boolean", description: "Show staged changes instead of the working tree" },
      paths: { type: "array", items: { type: "string" }, description: "Limit the diff to these paths" },
      stat_only: { type: "boolean", description: "Only show the file/summary line, not the full diff" },
      cwd: { type: "string", description: "Any directory inside the repository (default: cwd)" }
    }
  },
  async run({ staged = false, paths = [], stat_only = false, cwd = process.cwd() }) {
    const args = ["diff --no-color"];
    if (staged) { args.push("--cached"); }
    if (stat_only) { args.push("--stat"); }
    args.push("--");
    for (const p of paths) { args.push(shellPath(p)); }
    const result = await git(args.join(" "), cwd);
    const failure = unwrap(result);
    if (failure) { return failure; }

    const text = truncate(result.stdout.trim());
    if (!text) { return ok("(no changes)"); }
    if (stat_only) { return ok(text); }

    const files = parseUnifiedDiff(result.stdout);
    return ok(text, {
      git: { kind: "diff", files: files, summary: diffSummary(files) },
      diff: files
    });
  }
};

/* ================================================================ GitLog === */

export const gitLogTool = {
  name: "GitLog",
  description:
    "Show recent commit history with hash, author, date and subject. " +
    "Use paths or a revision range to narrow it down. Read-only.",
  input_schema: {
    type: "object",
    properties: {
      count: { type: "number", description: "Number of commits (default 20, max 200)" },
      paths: { type: "array", items: { type: "string" }, description: "Limit history to these paths" },
      range: { type: "string", description: "Revision range, e.g. HEAD~5..HEAD or main..feature" },
      oneline: { type: "boolean", description: "One line per commit instead of full metadata" },
      cwd: { type: "string", description: "Any directory inside the repository (default: cwd)" }
    }
  },
  async run({ count = 20, paths = [], range = null, oneline = false, cwd = process.cwd() }) {
    const n = Math.max(1, Math.min(Number(count) || 20, 200));
    const args = ["log --no-color --date=short -" + n];
    if (oneline) {
      args.push("--pretty=oneline");
    } else {
      // The default medium format carries hash/author/date/subject without a
      // %-style placeholder, which PowerShell would otherwise swallow.
      args.push("--pretty=medium");
    }
    if (range) { args.push(shellArg(range) + "^.."); }
    else if (range !== null) { args.push(shellArg(range)); }
    args.push("--");
    for (const p of paths) { args.push(shellPath(p)); }
    const result = await git(args.join(" "), cwd);
    const failure = unwrap(result);
    if (failure) { return failure; }
    const text = truncate(result.stdout.trim());
    if (!text) { return ok("(no commits)"); }
    return ok(text, { git: { kind: "log", oneline: !!oneline } });
  }
};

/* ============================================================== GitCommit === */

export const gitCommitTool = {
  name: "GitCommit",
  description:
    "Stage the given paths (or all changes with add_all) and create a commit. " +
    "Returns the new commit hash and a diffstat. Requires approval.",
  input_schema: {
    type: "object",
    properties: {
      message: { type: "string", description: "Commit message (required, non-empty)" },
      paths: { type: "array", items: { type: "string" }, description: "Paths to stage before committing" },
      add_all: { type: "boolean", description: "Stage every change (git add -A) instead of specific paths" },
      amend: { type: "boolean", description: "Amend the previous commit instead of creating a new one" },
      cwd: { type: "string", description: "Any directory inside the repository (default: cwd)" }
    },
    required: ["message"]
  },
  async run({ message, paths = [], add_all = false, amend = false, cwd = process.cwd() }) {
    const msg = String(message || "").trim();
    if (!msg) { return err("commit message must not be empty"); }

    const inside = await git("rev-parse --is-inside-work-tree", cwd);
    if (!inside.ok) { return err("not a git repository: " + inside.stderr.trim()); }

    // Stage first, so a failed commit never leaves a half-staged index behind.
    if (add_all) {
      const add = await git("add -A", cwd);
      const failure = unwrap(add);
      if (failure) { return failure; }
    } else if (paths.length) {
      const quoted = paths.map(shellPath).join(" ");
      const add = await git("add -- " + quoted, cwd);
      const failure = unwrap(add);
      if (failure) { return failure; }
    }

    // Refuse to commit nothing.
    const staged = await git("diff --cached --name-only", cwd);
    if (staged.ok && !staged.stdout.trim()) {
      return err("nothing staged: pass paths or add_all");
    }

    const body = "-m " + shellArg(msg.split("\n").join("%0A"));
    const commit = await git("commit" + (amend ? " --amend" : "") + " " + body, cwd);
    if (!commit.ok) {
      return err(truncate((commit.stderr || commit.stdout || "commit failed").trim()));
    }

    const hash = await git("rev-parse --short HEAD", cwd);
    const stat = await git("show --stat --oneline HEAD", cwd);
    const short = hash.ok ? hash.stdout.trim() : "(unknown)";
    const text = "created commit " + short + "\n\n" + (stat.ok ? truncate(stat.stdout.trim()) : commit.stdout.trim());
    return ok(text, { git: { kind: "commit", hash: short } });
  }
};


export const GIT_TOOLS = [gitStatusTool, gitDiffTool, gitLogTool, gitCommitTool];
