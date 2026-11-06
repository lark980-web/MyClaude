#!/usr/bin/env bun
/**
 * 上游 Claude Code 安全判定 sidecar。
 *
 * 为什么是独立进程：claude-re-2.1.302 的提取树是 `bun build --compile` 的产物，
 * 它用 Bun 专有的 `import.meta.require(...)` 同步加载 ESM 模块 —— Node 26 没有这个 API，
 * 所以这棵树原生只能在 Bun 下加载。MyClaude 的开发模式跑在 Node 上，因此把「调用上游真实
 * 代码」这件事放进一个常驻 Bun 进程里，由 MyClaude 通过 NDJSON 询问。
 *
 * 协议（stdin/stdout，一行一个 JSON）：
 *   请求 {"id":1,"command":"ls -la"}
 *   响应 {"id":1,"ok":true,"readOnly":true,"reason":null,"destructive":false}
 *
 * 判定来自上游工具对象本身的真实方法（chunk-e0x0xb6d.js 导出的 Li = Bash 工具）：
 *   isReadOnly(input, sessionEnvVarKeys)      —— 这条命令能否不经询问直接跑
 *   notReadOnlyReason(input, sessionEnvVarKeys) —— 不能的话，上游给的理由与具体片段
 *   isDestructive(input)                       —— 上游的破坏性判定
 */

import { dirname, join } from "node:path";

const cli = process.env.MYCLAUDE_ENGINE_CLI || "B:/~BUN/root/cli";
const modulesDir = process.env.MYCLAUDE_UPSTREAM_MODULES || dirname(cli);
const modulePath = join(modulesDir, "chunk-e0x0xb6d.js");

let Bash = null;
let loadError = null;
try {
  const m = await import(modulePath);
  Bash = m.Li || null;
  if (!Bash || typeof Bash.isReadOnly !== "function") { loadError = "upstream module does not export the Bash tool (Li)"; }
} catch (e) {
  loadError = String((e && e.message) || e).slice(0, 400);
}

// 握手：先发一行 ready/失败，让对端立刻知道能不能用，不必等第一次查询
process.stdout.write(JSON.stringify({ ready: Boolean(Bash), error: loadError }) + "\n");

if (Bash) {
  let buf = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let req;
      try { req = JSON.parse(line); } catch { continue; }
      const out = { id: req.id, ok: true };
      try {
        const input = { command: String(req.command || "") };
        const readOnly = Bash.isReadOnly(input, []);
        out.readOnly = Boolean(readOnly);
        if (!readOnly) {
          const why = Bash.notReadOnlyReason(input, []);
          out.reason = why && why.message ? String(why.message) : null;
          out.part = why && why.part ? String(why.part) : null;
        } else {
          out.reason = null;
          out.part = null;
        }
        try { out.destructive = Boolean(Bash.isDestructive(input)); } catch { out.destructive = null; }
      } catch (e) {
        out.ok = false;
        out.error = String((e && e.message) || e).slice(0, 300);
      }
      process.stdout.write(JSON.stringify(out) + "\n");
    }
  });
  process.stdin.on("end", () => process.exit(0));
}