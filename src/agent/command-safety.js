/**
 * Which shell commands may run without asking.
 *
 * Claude Code gates the same decision on a PowerShell AST: it parses the
 * command and refuses anything it cannot prove safe (chunk-41tke5jp.js in
 * claude-src). The list of reasons in that module is a catalogue of real
 * escapes — Invoke-Expression, encoded arguments, writing into .git/hooks,
 * schtasks, downloading and running remote code, and so on.
 *
 * This module keeps that idea without a parser. The rule is:
 *
 *   acceptEdits means "edits and the commands around them", so ordinary work
 *   (build, test, install, git add/commit, mkdir, writing a file) is approved.
 *   What still asks is what can escape the workspace or hide what it does.
 *
 * An earlier version of this file used a read-only allowlist and refused
 * anything else, which turned `git add`, `mkdir` and even `node -e` into
 * prompts. That is not what acceptEdits is for, so the check now asks
 * "is this dangerous?" instead of "is this on a list?".
 */

/** Buffer cap for one command's parsed form. */
const MAX_COMMAND_CHARS = 8000;

/**
 * Commands that always ask, whatever the arguments.
 *
 * These either destroy data outright or run code the user never saw.
 */
const ALWAYS_ASK = [
  [/\brm\b.*\s-[a-z]*[rf]/i, "recursive or forced delete"],
  [/\brmdir\s+\/s/i, "recursive directory delete"],
  [/\bdel\b.*\s\/[sq]\s*\/[sq]/i, "forced delete"],
  [/\bformat\b/i, "disk format"],
  [/\bmkfs\b/i, "filesystem creation"],
  [/\bdd\b.*\bof=/i, "raw disk write"],
  [/--no-preserve-root/, "root delete"],
  [/\bshutdown\b/i, "system shutdown"],
  [/\breboot\b/i, "system reboot"],
  // A push leaves the machine: it publishes work, so it is not an edit. Any
  [/\bgit\s+push\b/i, "push"],
  // These rewrite what is already on disk or on the remote.
  [/\bgit\s+reset\s+--hard\b/i, "hard reset"],
  [/\bgit\s+clean\b.*-[a-z]*[fd]/i, "git clean"],
  [/\b(npm|pnpm|yarn|bun)\s+publish\b/i, "package publish"],
  [/\bdrop\s+(?:table|database)\b/i, "database drop"],
  [/\bdelete\s+from\b/i, "SQL delete"],
  // Windows-specific escapes
  [/\bschtasks\b/i, "scheduled task"],
  [/\breg\s+(?:add|delete)\b/i, "registry write"],
  [/\b(?:cacls|icacls)\b.*\/grant/i, "ACL grant"],
  [/\bnet\s+user\b.*\/add/i, "user creation"],
  [/\btaskkill\b.*\/f\s+\/t\s+\/fi/i, "broad process kill"],
];

/**
 * Constructs that hide what a command does.
 *
 * Each one can turn visible text into arbitrary code. These are narrower than
 * the Claude catalogue on purpose: only the forms that genuinely obscure the
 * command are listed, so writing a file or passing a flag stays approved.
 */
const OPAQUE_CONSTRUCTS = [
  // A subshell or a backtick splices another command's output into this one.
  [/\$\(/, "subshell $(...)"],
  [/\x60/, "backtick subshell"],
  // Invoke-Expression evaluates its argument as code.
  [/\binvoke-expression\b/i, "Invoke-Expression"],
  [/\biex\b/i, "Invoke-Expression"],
  // -EncodedCommand carries a base64 payload. The long spellings only: a bare
  // -e is node's own flag and must stay approved.
  [/-encodedcommand\b/i, "encoded command"],
  [/(?:^|\s)-enc\s+[A-Za-z0-9+/=]{20,}/i, "encoded command"],
  // A script block or .NET load can contain anything.
  [/\binvoke-item\b/i, "Invoke-Item"],
  [/\bstart-process\b/i, "Start-Process"],
  [/\bnew-object\b/i, "New-Object"],
  [/\badd-type\b/i, "Add-Type"],
  // wmic and certutil are both remote-execution vectors.
  [/\bwmic\b/i, "wmic"],
  [/\bcertutil\b.*-urlcache/i, "certutil download"],
  [/\bbitsadmin\b/i, "BITS transfer"],
  // Downloading and immediately running something.
  [/\b(?:curl|wget)\b[^|]*\|\s*(?:sh|bash|zsh|powershell|cmd)\b/i, "piped remote script"],
  // PowerShell elevation.
  [/\bsudo\b/i, "sudo"],
  [/Start-Process\b.*-Verb\s+RunAs/i, "elevation"],
];

/**
 * Split a command line into the separate commands it runs.
 *
 * A chain is only as safe as its riskiest part, so every part is checked. The
 * split is deliberately conservative: a quoted string containing a pipe is
 * rare and treating it as a separator only makes the check stricter.
 *
 * @param {string} command
 * @returns {string[]}
 */
export function splitCommands(command) {
  return String(command || "")
    .split(/\s*(?:&&|\|\||[|;&])\s*/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * The reason a command may not run unattended, or null when it may.
 *
 * @param {string} command
 * @returns {string|null}
 */
export function autoApprovalBlocker(command) {
  const raw = String(command || "").trim();
  if (!raw) { return "empty command"; }
  if (raw.length > MAX_COMMAND_CHARS) { return "command is too long to inspect"; }

  for (const [re, label] of OPAQUE_CONSTRUCTS) {
    if (re.test(raw)) { return label + " cannot be checked statically"; }
  }

  for (const [re, label] of ALWAYS_ASK) {
    if (re.test(raw)) { return label + " needs approval"; }
  }

  // Writing into .git can plant a hook that git runs on the next command.
  if (/\.git[\\/](?:hooks|config)\b/i.test(raw)) {
    return "writing into .git can plant a hook";
  }

  return null;
}

/**
 * True when the command may run without asking.
 *
 * @param {string} command
 * @returns {boolean}
 */
export function isAutoApprovable(command) {
  return autoApprovalBlocker(command) === null;
}

/**
 * A command that changes the working directory makes relative paths in the
 * rest of the line ambiguous. It is not blocked, only reported, because a
 * "cd build && npm test" is ordinary work.
 *
 * @param {string} command
 * @returns {string|null}
 */
export function directoryChangeNote(command) {
  const raw = String(command || "").trim();
  if (/\b(?:set-location|push-location|pop-location)\b/i.test(raw)) {
    return "the command changes the working directory";
  }
  return null;
}
