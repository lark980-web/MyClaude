/**
 * 上游安全判定桥（代码层复刻 A3）。
 *
 * 目标：让 MyClaude 的 Bash 判定能用**上游 Claude Code 的真实代码**给。上游判定来自其
 * Bash 工具对象（chunk-e0x0xb6d.js 导出的 Li）的 `isReadOnly(input, sessionEnvVarKeys)`
 * 与 `notReadOnlyReason(...)`。
 *
 * 为什么只能进程内：提取树是 `bun build --compile` 的产物，模块间用 Bun 专有的
 * `import.meta.require(...)` 同步加载 ESM —— Node 26 没有该 API，这棵树原生只能在 Bun 下加载。
 * 因此：
 *   - **Bun 运行时（= 打好的 exe，也是产品的实际运行环境）**：进程内直接 import，零额外进程。
 *   - **Node（开发模式）**：上游不可用，退回自研启发式，并在状态里标明，不假装上游可用。
 * 之前试过「常驻 sidecar + NDJSON」方案：stdio 管道句柄无论怎么 unref 都吊住父进程，
 * 会让测试与 CLI 无法退出 —— 已放弃，sidecar 只保留为测试辅助（scripts/upstream-safety-sidecar.mjs）。
 */

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_CLI = "B:/~BUN/root/cli";

let upstreamBash = null;
let loaded = false;
let lastError = null;

/** 显式关闭上游判定（MYCLAUDE_UPSTREAM_SAFETY=off）。 */
export function upstreamSafetyDisabled() {
  return String(process.env.MYCLAUDE_UPSTREAM_SAFETY || "").toLowerCase() === "off";
}

/** 当前状态：上游判定是否可用。 */
export function upstreamSafetyStatus() {
  return { available: Boolean(upstreamBash), error: lastError, disabled: upstreamSafetyDisabled(), runtime: process.versions.bun ? "bun" : "node" };
}

function modulesDir() {
  const cli = process.env.MYCLAUDE_ENGINE_CLI || DEFAULT_CLI;
  return dirname(cli);
}

/** 加载上游 Bash 工具对象。加载失败不抛 —— 上游不可用是常态，不是错误。 */
export async function initUpstreamSafety() {
  if (loaded) { return Boolean(upstreamBash); }
  loaded = true;
  if (upstreamSafetyDisabled()) { lastError = "disabled by MYCLAUDE_UPSTREAM_SAFETY=off"; return false; }
  if (!process.versions.bun) {
    lastError = "upstream tree requires Bun (it uses import.meta.require); current runtime is " + process.version;
    return false;
  }
  const mod = join(modulesDir(), "chunk-e0x0xb6d.js");
  if (!existsSync(mod)) {
    lastError = "upstream module not found: " + mod + " (需要 subst 映射，见 docs/authentic-claude-code-run.md)";
    return false;
  }
  try {
    const m = await import(pathToFileURL(mod).href);
    if (m && m.Li && typeof m.Li.isReadOnly === "function") {
      upstreamBash = m.Li;
      lastError = null;
      return true;
    }
    lastError = "upstream module does not export the Bash tool (Li)";
  } catch (e) {
    lastError = "upstream import failed: " + String((e && e.message) || e).slice(0, 240);
  }
  return false;
}

/**
 * 同步问上游：这条命令能否不经询问直接跑。
 *
 * 上游不可用或没给出结论时 readOnly 为 null，调用方应走自研启发式。
 *
 * @param {string} command
 * @returns {{available:boolean, readOnly:boolean|null, reason:string|null, part:string|null}}
 */
export function upstreamCommandVerdictSync(command) {
  if (!upstreamBash) { return { available: false, readOnly: null, reason: null, part: null }; }
  const input = { command: String(command == null ? "" : command) };
  if (!input.command.trim()) { return { available: true, readOnly: true, reason: null, part: null }; }
  try {
    const readOnly = upstreamBash.isReadOnly(input, []);
    if (readOnly) { return { available: true, readOnly: true, reason: null, part: null }; }
    const why = upstreamBash.notReadOnlyReason(input, []);
    return { available: true, readOnly: false, reason: (why && why.message) || null, part: (why && why.part) || null };
  } catch (e) {
    return { available: true, readOnly: null, reason: null, part: null, error: String((e && e.message) || e).slice(0, 200) };
  }
}

/** 异步包装（保持调用点接口一致）。加载完成后即为同步查询。 */
export async function upstreamCommandVerdict(command) {
  if (!loaded) { await initUpstreamSafety(); }
  return upstreamCommandVerdictSync(command);
}

/** 释放（当前无子进程，留作接口稳定）。 */
export function stopUpstreamSafety() {
  upstreamBash = null;
  loaded = false;
}