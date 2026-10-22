/**
 * Permission modes.
 *
 * One registry so the CLI flag parser, the agent, the HTTP layer and the UI
 * all agree on which modes exist and what each one means, instead of each
 * keeping its own copy of the list.
 */

export const PERMISSION_MODES = [
  // Everyday modes: the three a normal session moves between. Phrased the way
  // Claude describes them (933_chunk-0qdm07jf.js) so the difference is readable
  // without opening the docs.
  { id: "ask", label: "ask", zh: "询问", desc: "每次写入前确认", group: "normal" },
  { id: "acceptEdits", label: "accept edits", zh: "接受编辑", desc: "自动批准文件编辑与常见文件命令", group: "normal" },
  { id: "auto", label: "auto", zh: "自动", desc: "常规操作不再询问", group: "normal" },
  // Restrictive and workflow modes: chosen for a reason, not by default.
  { id: "dontAsk", label: "don't ask", zh: "不再提问", desc: "需要确认的一律拒绝", group: "special" },
  { id: "plan", label: "plan mode", zh: "计划", desc: "只读：探索放行，改动拒绝", group: "special" },
  // Dangerous: it removes the guard rails, so it is kept visually apart.
  { id: "bypassPermissions", label: "bypass permissions", zh: "全部放行", desc: "跳过确认（deny 规则仍生效）", group: "danger" },
  // MyClaude-only escape hatch. Not offered in the picker: a mode that also
  // ignores deny rules should take a deliberate act, not a stray click. It is
  // still reachable with --full-access or /mode fullAccess.
  { id: "fullAccess", label: "full access", zh: "完全放行", desc: "跳过确认与 deny 规则", group: "danger", advanced: true },
];

export const MODE_IDS = PERMISSION_MODES.map((m) => m.id);

const ALIASES = {
  default: "ask",
  ask: "ask",
  "accept-edits": "acceptEdits",
  acceptedits: "acceptEdits",
  edits: "acceptEdits",
  auto: "auto",
  "dont-ask": "dontAsk",
  dontask: "dontAsk",
  plan: "plan",
  "bypass-permissions": "bypassPermissions",
  bypasspermissions: "bypassPermissions",
  bypass: "bypassPermissions",
  yolo: "bypassPermissions",
  "full-access": "fullAccess",
  fullaccess: "fullAccess",
  full: "fullAccess",
  root: "fullAccess",
  god: "fullAccess"
};

/** True when the value names a real mode. */
export function isMode(value) {
  return normalizeMode(value) !== null;
}

/**
 * Map any accepted spelling to a canonical mode id, or null.
 * Accepts "acceptEdits", "accept-edits", "ACCEPT EDITS", "edits"...
 */
export function normalizeMode(value) {
  if (typeof value !== "string") { return null; }
  const raw = value.trim();
  if (!raw) { return null; }
  const exact = MODE_IDS.find((id) => id.toLowerCase() === raw.toLowerCase());
  if (exact) { return exact; }
  const key = raw.toLowerCase().replace(/[\s_]+/g, "-");
  return ALIASES[key] || ALIASES[key.replace(/-/g, "")] || null;
}

/** Display metadata for a mode id. */
export function modeInfo(id) {
  const canon = normalizeMode(id) || "ask";
  return PERMISSION_MODES.find((m) => m.id === canon) || PERMISSION_MODES[0];
}

/** Tools that only edit workspace files. */
export const FILE_EDIT_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);

/**
 * Command prefixes that "accept edits" treats as routine file work, so the
 * agent can build and test without a prompt per command. Anything else still
 * asks: the point is to stop interrupting edits, not to trust arbitrary shells.
 */
const COMMON_COMMAND_PREFIXES = [
  "ls", "dir", "cat", "type", "head", "tail", "wc", "find", "which", "where",
  "echo", "pwd", "tree", "stat", "file", "du", "df",
  "mkdir", "touch", "cp", "copy",
  "git status", "git diff", "git log", "git show", "git branch", "git ls-files",
  "npm test", "npm run", "npm ls", "pnpm test", "pnpm run", "pnpm ls",
  "yarn test", "yarn run", "bun test", "bun run",
  "node --version", "node -v", "npx --help",
  "python --version", "pytest", "pip list", "pip show",
  "cargo build", "cargo test", "cargo check", "cargo run",
  "go build", "go test", "go vet", "make", "dotnet build", "dotnet test",
  "tsc", "eslint", "prettier", "vite build", "next build",
];

/**
 * Destructive shapes that must never be auto-approved, even when the leading
 * binary is on the allow list (`git clean -fdx`, `npm publish --force`, …).
 */
const DANGEROUS_PATTERNS = [
  /\brm\b/, /\bdel\b/, /\berase\b/, /\brmdir\b/, /\bremove-item\b/, /\bdeltree\b/,
  /\bgit\s+(push|reset|clean|rebase|checkout\s+\.|restore\s+\.)/,
  /\b(npm|pnpm|yarn|bun)\s+publish/,
  /\bmv\b/, /\bmove-item\b/,
  /--no-preserve-root/, /\s-\w*[rf]\w*\b(?=\s|$|\s\/)/,
  /\bdd\b/, /\bmkfs\b/, /\bfdisk\b/, /\bformat\b/,
  /\bshutdown\b/, /\breboot\b/, /\btaskkill\s+\/f\s+\/t\s+\/fi/,
  /\bchmod\b/, /\bchown\b/, /\bcacls\b/, /\bicacls\b/,
  /\bdrop\s+(table|database)\b/, /\bdelete\s+from\b/,
  /\bsudo\b/, /\bnet\s+user\b/, /\breg\s+(add|delete)\b/,
];

/** True when a command matches one of the destructive shapes above. */
export function isDestructiveCommand(command) {
  const cmd = String(command || "").trim().toLowerCase();
  if (!cmd) { return false; }
  return DANGEROUS_PATTERNS.some((re) => re.test(cmd));
}

/** True when a shell command looks like routine file/build work. */
export function isCommonFileCommand(command) {
  const cmd = String(command || "").trim().toLowerCase();
  if (!cmd) { return false; }
  // A chained command is only as safe as its riskiest part, so refuse to
  // classify anything that chains, redirects or substitutes.
  if (/[;&|`$><]|\$\(|>>/.test(cmd)) { return false; }
  if (isDestructiveCommand(cmd)) { return false; }
  return COMMON_COMMAND_PREFIXES.some((prefix) => cmd === prefix || cmd.startsWith(prefix + " "));
}

