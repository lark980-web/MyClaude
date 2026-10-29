import { VERSION } from "../version.js";
import readline from "node:readline";
import { stdin, stdout } from "node:process";

const C = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  gray: "\x1b[90m",
  claude: "\x1b[38;5;173m",
};

function color(enabled) {
  return enabled ? C : Object.fromEntries(Object.keys(C).map((k) => [k, ""]));
}

export class TerminalUI {
  constructor({ useColor = stdout.isTTY } = {}) {
    this.c = color(useColor);
    this.inStream = false;
    this.rl = null;
  }

  start() {
    readline.emitKeypressEvents(stdin);
    this.lastEscapeAt = 0;
    stdin.on("keypress", (str, key) => {
      if (!key) return;
      if (key.name === "escape") {
        const now = Date.now();
        if (isDoubleEscape(now, this.lastEscapeAt)) {
          this.lastEscapeAt = 0;
          if (typeof this.onEditPrevious === "function") { this.onEditPrevious(); }
          return;
        }
        this.lastEscapeAt = now;
        return;
      }
      this.lastEscapeAt = 0;
    });
    this.rl = readline.createInterface({
      input: stdin,
      output: stdout,
      terminal: true,
      historySize: 500,
    });
    return this.rl;
  }

  stop() {
    this.rl?.close();
  }

  prompt(text = "> ") {
    if (!this.rl) this.start();
    return new Promise((resolve) => {
      this.rl.question(`${this.c.cyan}${this.c.bold}${text}${this.c.reset}`, (answer) => {
        resolve(answer);
      });
    });
  }

  streamText(chunk) {
    if (!this.inStream) {
      stdout.write(`\n${this.c.magenta}`);
      this.inStream = true;
    }
    stdout.write(chunk);
  }

  endStream() {
    if (this.inStream) {
      stdout.write(`${this.c.reset}\n`);
      this.inStream = false;
    }
  }

  info(msg) {
    this.endStream();
    console.log(`${this.c.gray}${msg}${this.c.reset}`);
  }

  warn(msg) {
    this.endStream();
    console.log(`${this.c.yellow}${msg}${this.c.reset}`);
  }

  error(msg) {
    this.endStream();
    console.log(`${this.c.red}${msg}${this.c.reset}`);
  }

  success(msg) {
    this.endStream();
    console.log(`${this.c.green}${msg}${this.c.reset}`);
  }

  banner(config) {
    const lines = [
      `${this.c.claude}  ██████████`,
      `${this.c.claude} ██  ██  ████`,
      `${this.c.claude} ████████████`,
      `${this.c.claude}  ██ ████ ██`,
      ``,
      `${this.c.claude}${this.c.bold}Welcome to MyClaude${this.c.reset} ${this.c.gray}v${VERSION}${this.c.reset}`,
      `${this.c.gray}model ${config.model} · mode ${config.permissionMode} · ${process.cwd()}${this.c.reset}`,
      `${this.c.gray}/help for commands${this.c.reset}`,
    ];
    console.log("\n" + lines.join("\n") + "\n");
  }

  toolStart(name, args) {
    this.endStream();
    const summary = summarizeArgs(args);
    console.log(`${this.c.claude}● ${this.c.bold}${name}${this.c.reset}${this.c.gray}(${summary})${this.c.reset}`);
  }

  toolEnd(name, ok, elapsed, content) {
    const lines = String(content || "").split("\n");
    const preview = lines.slice(0, 6).join("\n");
    const more = lines.length > 6;
    console.log(`${this.c.gray}  ${this.c.dim}⎿  ${elapsed}ms${this.c.reset}`);
    if (preview.trim()) {
      for (const line of preview.split("\n")) {
        console.log(`${this.c.gray}${this.c.dim}  ⎿  ${line}${this.c.reset}`);
      }
      if (more) console.log(`${this.c.gray}${this.c.dim}  ⎿  …${this.c.reset}`);
    }
  }

  async confirmTool(name, args) {
    this.endStream();
    const summary = summarizeArgs(args);
    const answer = await this.prompt(`  allow ${name}(${summary})? [y/N/a=always] `);
    const a = answer.trim().toLowerCase();
    if (a === "a" || a === "always") {
      this.autoApprove = true;
      return true;
    }
    return a === "y" || a === "yes";
  }

  async confirm(message) {
    const answer = await this.prompt(`${message} [y/N] `);
    return ["y", "yes"].includes(answer.trim().toLowerCase());
  }
}

/**
 * Double-Escape detector (Claude Code parity: Esc+Esc recalls the previous
 * user message for editing). Pure so it can be unit-tested.
 */
export function isDoubleEscape(now, lastEscapeAt, windowMs = 500) {
  return lastEscapeAt > 0 && now - lastEscapeAt <= windowMs;
}

function summarizeArgs(args) {
  if (!args || typeof args !== "object") return "";
  const parts = [];
  for (const [k, v] of Object.entries(args)) {
    if (v == null) continue;
    let s = typeof v === "string" ? v : JSON.stringify(v);
    if (s.length > 60) s = s.slice(0, 57) + "...";
    parts.push(`${k}: ${s}`);
    if (parts.length >= 3) break;
  }
  return parts.join(", ");
}
