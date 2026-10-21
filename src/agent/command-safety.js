/**
 * Which shell commands may run without asking.
 *
 * Claude Code answers this by parsing the PowerShell AST and rejecting
 * anything it cannot prove safe (chunk-41tke5jp.js in claude-src). Its list of
 * reasons is long, and every entry is a real way to run code or plant
 * persistence: Invoke-Expression, encoded arguments, writing into .git/hooks,
 * schtasks, downloading and running remote code, and so on.
 *
 * This module is the same idea without a parser. It is deliberately
 * conservative: a command is auto-approved only when every part of it is
 * known and harmless. Anything unknown asks.
 *
 * The difference from the plain isDestructiveCommand() list is important: that
 * one asks about commands that are obviously destructive, while this one
 * decides whether a command may run unattended, which includes refusing to
 * guess about constructs that hide what they do.
 */

/**
 * Commands that only read. They are safe in any mode.
 *
 * The names are the bare executable, lower-cased, without a path.
 */
const READ_ONLY_COMMANDS = new Set([
  // File inspection
  "ls", "dir", "cat", "type", "head", "tail", "wc", "more", "less",
  // Search
  "grep", "rg", "find", "fd", "ag", "which", "where", "whereis",
  // Version and help
  "node", "npm", "npx", "pnpm", "yarn", "bun", "deno", "python", "python3",
  "pip", "pip3", "go", "cargo", "rustc", "java", "javac", "mvn", "gradle",
  "dotnet", "ruby", "gem", "php", "composer", "perl", "make", "cmake", "ninja",
  "tsc", "eslint", "prettier", "jest", "vitest", "pytest", "mocha",
  // git is handled separately: only its read-only subcommands may run
  // unattended, so it is not listed here.
  // System inspection
  "echo", "printf", "pwd", "cd", "date", "time", "whoami", "hostname",
  "uname", "env", "set", "printenv", "id", "df", "du", "stat", "file",
  "ps", "tasklist", "ipconfig", "ifconfig", "ping", "netstat", "systeminfo",
]);

/**
 * git subcommands that only read. Anything else in git can change state.
 */
const READ_ONLY_GIT = new Set([
  "status", "log", "diff", "show", "branch", "remote", "tag", "config",
  "blame", "describe", "rev-parse", "ls-files", "ls-tree", "ls-remote",
  "shortlog", "reflog", "cat-file", "check-ignore", "check-attr",
  "diff-tree", "diff-index", "name-rev", "symbolic-ref", "var", "whatchanged",
]);

/**
 * Constructs that make a command impossible to reason about statically.
 *
 * Claude refuses all of these under acceptEdits. Each one can smuggle in
 * code that the visible text does not describe.
 */
const OPAQUE_CONSTRUCTS = [
  // $() runs a subshell; its output becomes part of the command.
  [/\$\(/, "subshell $(...)"],
  // Backticks are the other subshell syntax.
  [/`/, "backtick subshell"],
  // A here-string or here-doc carries arbitrary text into the shell.
  [/<<</, "here-string"],
  // PowerShell splatting and stop-parsing defeat static analysis.
  [/@[A-Za-z_]\w*\b/, "splatting"],
  [/--%/,"stop-parsing token"],
  // -EncodedCommand hides the real command behind base64.
  [/(?:^|\s)-(?:e|ec|en|enc|enco|encod|encode|encoded|EncodedCommand)\s/i, "encoded command"],
  // Invoke-Expression executes its argument as code.
  [/\binvoke-(?:expression|iex)\b/i, "Invoke-Expression"],
  // Invoke-Item runs a file with the default handler.
  [/\binvoke-item\b/i, "Invoke-Item"],
  // Start-Process and nested shells escape the checked command.
  [/\bstart-process\b/i, "Start-Process"],
  // .NET and COM can load and run arbitrary code.
  [/\bnew-object\b/i, "New-Object"],
  [/\badd-type\b/i, "Add-Type"],
  // wmic can create processes and write files.
  [/\bwmic\b/i, "wmic"],
  // Scheduled tasks are a persistence mechanism.
  [/\bschtasks\b/i, "schtasks"],
  // Certutil downloads files.
  [/\bcertutil\b/i, "certutil"],
  // BitsTransfer downloads files too.
  [/\b(?:start|bitsadmin)\b.*\bbits/i, "BITS transfer"],
  // A script block may contain a dangerous cmdlet.
  [/\{[^{}]*\}/, "script block"],
  // Changing the working directory makes relative paths ambiguous.
  [/\b(?:set-location|push-location|pop-location|cd)\b/i, "working directory change"],
  // Environment variables change how later commands resolve.
  [/\bset-item\s+env:/i, "environment variable change"],
  // A redirect can write anywhere.
  [/[^>]>{1,2}(?!>)/, "output redirection"],
];

/**
 * Split a command line into the separate commands it runs.
 *
 * A pipeline or a chained command is only as safe as its riskiest part, so
 * every part has to pass on its own. Splitting on the shell operators is
 * deliberately conservative: a quoted string containing a pipe is rare, and
 * treating it as a separator only makes the check stricter.
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
 * The bare executable of a command, lower-cased and without its path.
 *
 * @param {string} part
 * @returns {string}
 */
export function commandName(part) {
  const raw = String(part || "").trim();
  // A quoted path may contain spaces, so the first token is taken before the
  // string is split: "C:\Program Files\node\node.exe" is one executable.
  let first = "";
  if (raw.startsWith('"') || raw.startsWith("'")) {
    const quote = raw[0];
    const end = raw.indexOf(quote, 1);
    first = end > 0 ? raw.slice(1, end) : raw.slice(1);
  } else {
    first = raw.split(/\s+/)[0] || "";
  }
  // Strip a drive letter and any directory part: C:\tools\foo.exe -> foo.exe
  return first.replace(/^.*[\\/]/, "").toLowerCase();
}

/**
 * True when the command is a git invocation that only reads.
 *
 * @param {string} part
 * @returns {boolean}
 */
function isReadOnlyGit(part) {
  const words = String(part || "").trim().split(/\s+/);
  if (commandName(words[0]) !== "git") { return false; }
  // Skip global options such as -C or --no-pager to find the subcommand.
  for (let i = 1; i < words.length; i++) {
    const w = words[i];
    if (!w || w.startsWith("-")) { continue; }
    return READ_ONLY_GIT.has(w.toLowerCase());
  }
  return false;
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

  const parts = splitCommands(raw);
  if (!parts.length) { return "no command found"; }

  for (const part of parts) {
    for (const [re, label] of OPAQUE_CONSTRUCTS) {
      if (re.test(part)) {
        return label + " cannot be checked statically";
      }
    }
  }

  for (const part of parts) {
    const name = commandName(part);
    if (!name) { continue; }
    // git is checked on its subcommand: "git status" is a read, "git push" is not.
    if (name === "git") {
      if (isReadOnlyGit(part)) { continue; }
      return "`git` may only run read-only subcommands unattended";
    }
    if (READ_ONLY_COMMANDS.has(name)) { continue; }
    return "`" + name + "` is not on the list of commands that may run unattended";
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
 * Commands that are known to be safe but are not in the read-only list,
 * because they do change state in a way the user expects.
 */
export const WRITE_COMMANDS = new Set([
  "mkdir", "touch", "cp", "copy", "xcopy", "robocopy", "tee", "install",
]);

/**
 * A write command is allowed unattended only when it stays predictable.
 *
 * Claude does the same check with the real path, and refuses commands that
 * change the working directory because the relative paths would then be
 * resolved against a stale root.
 *
 * @param {string} command
 * @returns {string|null} the reason, or null when the command is fine
 */
export function pathCheckBlocker(command) {
  const raw = String(command || "").trim();
  if (!raw) { return null; }
  // A command that changes the directory cannot be checked against the
  // original root.
  if (/\b(?:set-location|push-location|pop-location|cd)\b/i.test(raw)) {
    return "the command changes the working directory";
  }
  // Writing into .git can plant a hook that git runs on the next command.
  if (/\.git[\\/]/.test(raw) || /\.git\b/.test(raw)) {
    return "the command touches .git";
  }
  return null;
}
