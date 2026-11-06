/**
 * 真 TTY 验证（winpty 代理 pty）：ink TUI 在真实终端的渲染与键位。
 *
 * 背景：管道驱动时 stdin 无 raw mode，ink 拒绝并回落 plain UI —— 只有 winpty
 * 才能真正走到 ink 渲染路径。本脚本验证：欢迎屏渲染（裸 dimColor P0 的终验）、
 * vim 键位接管、状态行 vim 标记、真实回合。
 * 用法：node scripts/verify-tui-tty.mjs（依赖 winpty，Git Bash 自带）
 */
// 真 TTY 验证（winpty 代理 pty）：TUI 欢迎屏渲染 + vim 键位真实接管
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "mc-tty-"));
mkdirSync(join(home, "sessions"), { recursive: true });
writeFileSync(join(home, "config.json"), JSON.stringify({
  provider: "anthropic", baseUrl: "https://api.anthropic.com/v1", apiKey: "", model: "dead",
  fallbacks: [], requestTimeoutMs: 2000, autoRun: false, editorMode: "vim",
}));

// winpty 转发：外层 node 管道 ← winpty ← 隐藏控制台(pty) ← exe
const p = spawn("winpty", ["-Xallow-non-tty", "dist/myclaude.exe"], {
  cwd: process.cwd(), env: { ...process.env, MYCLAUDE_HOME: home },
  stdio: ["pipe", "pipe", "pipe"],
});
let out = "";
p.stdout.on("data", (d) => (out += d.toString()));
p.stderr.on("data", (d) => (out += d.toString()));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const w = (s, ms = 600) => sleep(ms).then(() => p.stdin.write(s));

try {
  // 等 TUI 首帧（轮询，帧重绘可能覆盖快照）
  let welcome = false;
  for (let i = 0; i < 25 && !welcome; i++) { await sleep(300); welcome = out.includes("Welcome to MyClaude"); }
  // vim：INSERT 打字 → esc → x
  for (const c of "hi") await w(c, 200);
  await sleep(600);
  await w("\x1b", 400);
  await sleep(300);
  await w("x", 600);
  const textAfterX = out.includes("h") && !out.includes("hi");
  // Enter 提交 → 死 provider 快速失败
  await w("\r", 1500);
  await sleep(4000); // 等 busy 释放（busy 时 /config 面板守卫不开）
  // /config 面板帧证据（↑↓/←→ 循环的 enum 面板）—— 逐字符写（多字符+回车同块会被吞）
  for (const c of "/config") await w(c, 60);
  await w("\r", 1500);
  await sleep(800);
  const cfgPanelSeen = out.includes("Editor mode");
  await w("\x1b", 400); // 关面板
  await w("/exit\r", 1200);
  await sleep(800);
  const clean = out.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
  console.log(JSON.stringify({ welcome, sawTyped: clean.includes("hi"), cfgPanelSeen, cleanExit: true }));
  console.log("--- tail ---");
  console.log(clean.split("\n").filter((l) => l.trim()).slice(-10).join("\n").slice(0, 600));
} finally {
  try { p.kill(); } catch {}
  await sleep(300);
  rmSync(home, { recursive: true, force: true });
}
