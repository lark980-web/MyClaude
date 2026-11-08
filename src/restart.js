// /restart — 上游 chunk-e0x0xb6d @2195979：{type:"local",name:"restart",aliases:["update"],
// description:"Restart Claude Code and keep this session"}。本地机制：保存会话 → 以 --resume 重启自身。
import { spawn } from "node:child_process";

/** Build the argv for a restarted process that resumes the given session.
 *  Keeps the original flags (gui/port/plain/…) and replaces any prior --resume. */
export function restartArgs(argv, sessionId) {
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--resume" || argv[i] === "-r") { i++; continue; }
    out.push(argv[i]);
  }
  if (sessionId) out.push("--resume", String(sessionId));
  return out;
}

/** Spawn a detached replacement and exit the current process.
 *  Returns the child pid (for tests/logging); never returns in production. */
export function performRestart({ sessionId, argv = process.argv.slice(2), execPath = process.execPath, exit = (code) => process.exit(code), spawner = spawn } = {}) {
  const args = [process.argv[1], ...restartArgs(argv, sessionId)].filter(Boolean);
  const child = spawner(execPath, args, { detached: true, stdio: "inherit", cwd: process.cwd(), env: process.env });
  child.unref();
  exit(0);
  return child.pid;
}
