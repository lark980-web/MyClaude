/**
 * 分享快照：把一个会话冻结成只读 HTML，凭 token 访问。
 *
 * 与 claude.ai 的「分享对话」对齐：分享出去的是创建那一刻的快照，
 * 之后的对话不会出现在已分享的页面里（claude.ai 也是快照语义，
 * 「update shared link」是另一次显式操作）。token 是 16 位随机
 * 十六进制——不可枚举，但要像密码一样对待：分享即授权阅读。
 *
 * 存储布局（沿用 config 目录约定，随 MYCLAUDE_HOME 可整体迁移）：
 *   ~/.myclaude/shares/<token>.json   { token, sessionId, title, savedAt, messages, meta }
 */
import { readdirSync, readFileSync, writeFileSync, rmSync, existsSync, mkdirSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { CONFIG_DIR } from "./config.js";

export const SHARES_DIR = join(CONFIG_DIR, "shares");

/** 单个快照允许的最大正文：超过它的会话先截断再分享，而不是直接失败。 */
export const MAX_SHARE_BYTES = 4 * 1024 * 1024;

export function ensureSharesDir() {
  if (!existsSync(SHARES_DIR)) mkdirSync(SHARES_DIR, { recursive: true });
  return SHARES_DIR;
}

/**
 * 创建（或更新一个会话的）分享快照。
 *
 * 同一会话重复分享时**复用同一个 token**：claude.ai 的语义是「一个会话
 * 一个链接，更新共享即覆盖快照」，这样旧链接不会失效成 404，也不会在
 * shares 目录里堆积同一会话的多份拷贝。
 *
 * @param {string} sessionId
 * @param {{title?: string, cwd?: string, model?: string, messages: Array<object>}} snapshot
 * @returns {{token: string, file: string, updated: boolean}}
 */
export function createShare(sessionId, snapshot) {
  if (!sessionId) throw new Error("sessionId required");
  if (!snapshot || !Array.isArray(snapshot.messages)) throw new Error("messages required");
  ensureSharesDir();
  const existing = findShareToken(sessionId);
  const token = existing || randomBytes(8).toString("hex");
  let messages = snapshot.messages;
  let body = JSON.stringify({ token, sessionId, ...snapshot, messages }, null, 2);
  if (body.length > MAX_SHARE_BYTES) {
    // 从头保留（开头的用户需求最有阅读价值），并留一条截断说明。
    const kept = [];
    let size = 512;
    for (const m of messages) {
      size += JSON.stringify(m).length + 1;
      if (size > MAX_SHARE_BYTES - 256) break;
      kept.push(m);
    }
    messages = [...kept, { role: "assistant", content: "［快照已达大小上限，其余消息被截断］" }];
    body = JSON.stringify({ token, sessionId, ...snapshot, messages, truncated: true }, null, 2);
  }
  const file = join(SHARES_DIR, `${token}.json`);
  writeFileSync(file, body, "utf8");
  return { token, file, updated: Boolean(existing) };
}

/** 读取快照；token 不存在或文件损坏返回 null。 */
export function getShare(token) {
  if (!token || !/^[0-9a-f]{8,32}$/i.test(String(token))) return null;
  const file = join(SHARES_DIR, `${token}.json`);
  if (!existsSync(file)) return null;
  try {
    const data = JSON.parse(readFileSync(file, "utf8"));
    if (!data || data.token !== token) return null;
    return data;
  } catch {
    return null;
  }
}

/** 列出全部快照（侧栏「已分享」标记与撤销分享用）。 */
export function listShares() {
  if (!existsSync(SHARES_DIR)) return [];
  const rows = [];
  for (const f of readdirSync(SHARES_DIR)) {
    if (!f.endsWith(".json")) continue;
    try {
      const data = JSON.parse(readFileSync(join(SHARES_DIR, f), "utf8"));
      if (data && data.token && data.sessionId) {
        rows.push({ token: data.token, sessionId: data.sessionId, title: data.title || "", savedAt: data.savedAt || null });
      }
    } catch {}
  }
  return rows;
}

/** 找到某会话已存在的分享 token；没有返回 null。 */
export function findShareToken(sessionId) {
  const hit = listShares().find((s) => s.sessionId === sessionId);
  return hit ? hit.token : null;
}

/** 删除某会话的全部分享（撤销分享）。返回删除数。 */
export function deleteSharesForSession(sessionId) {
  if (!existsSync(SHARES_DIR)) return 0;
  let n = 0;
  for (const f of readdirSync(SHARES_DIR)) {
    if (!f.endsWith(".json")) continue;
    const full = join(SHARES_DIR, f);
    try {
      const data = JSON.parse(readFileSync(full, "utf8"));
      if (data && data.sessionId === sessionId) {
        rmSync(full);
        n++;
      }
    } catch {}
  }
  return n;
}

/* -------------------------------------------------------------- 渲染层 --- */

/** 引入浏览器同款 markdown 渲染器（UMD 文件；包是 "type": "module"，
 * require 只会拿到空命名空间，所以用 vm 提供一个 CJS 壳来执行它）。
 * 源码运行时从磁盘读；编译成单文件 exe 后磁盘没有这个文件，改用
 * assets.js 的嵌入副本（build:embed 在编译前写入 EMBEDDED 块）。 */
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { dirname as _dirname, join as _join } from "node:path";
import { loadGuiAssets } from "./ui/assets.js";

const MD = (function loadMarkdown() {
  const file = _join(_dirname(fileURLToPath(import.meta.url)), "ui", "web", "js", "markdown.js");
  let source = null;
  try { source = readFileSync(file, "utf8"); } catch {}
  if (!source) {
    try { source = loadGuiAssets().markdown; } catch {}
  }
  if (!source) { return { render: (s) => String(s == null ? "" : s) }; }
  const sandboxModule = { exports: {} };
  vm.runInNewContext(source, {
    module: sandboxModule,
    window: undefined,
    require: undefined,
  }, { filename: file });
  return sandboxModule.exports;
})();

function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

/**
 * 把消息数组转成只读 HTML 片段（用户右对齐气泡 + AI 富文本）。
 * 分享页与「导出 HTML」共用这一份渲染，保证两处观感一致。
 */
export function renderTranscriptHtml(messages) {
  const out = [];
  let turn = 0;
  for (const m of messages || []) {
    if (!m || typeof m !== "object") continue;
    if (m.role === "tool" || m.role === "system") continue; // 工具明细不进只读页
    const text = typeof m.content === "string"
      ? m.content
      : Array.isArray(m.content)
        ? m.content.map((c) => (c && typeof c.text === "string" ? c.text : "")).join("\n\n")
        : "";
    if (!String(text).trim()) continue;
    turn++;
    if (m.role === "user") {
      out.push(
        `<div class="row user"><div class="who">你</div><div class="bubble">${esc(text).replace(/\n/g, "<br>")}</div></div>`
      );
    } else {
      let html = "";
      try { html = MD.render(String(text)); } catch { html = `<p>${esc(text)}</p>`; }
      out.push(
        `<div class="row asst"><div class="who">Claude</div><div class="body">${html}</div></div>`
      );
    }
  }
  if (!turn) {
    out.push('<div class="empty">此快照没有可阅读的对话内容。</div>');
  }
  return out.join("\n");
}

/**
 * 生成自包含只读页（内联 CSS，无外部请求，离线可读）。
 * 用于 GET /share/:token 与「导出 HTML」下载。
 */
export function renderSharePage({ title, savedAt, cwd, model, messages, token }) {
  const when = savedAt ? new Date(savedAt) : new Date();
  const stamp = `${when.getFullYear()}-${String(when.getMonth() + 1).padStart(2, "0")}-${String(when.getDate()).padStart(2, "0")} ${String(when.getHours()).padStart(2, "0")}:${String(when.getMinutes()).padStart(2, "0")}`;
  const metaBits = [stamp];
  if (cwd) metaBits.push(esc(cwd));
  if (model) metaBits.push(esc(model));
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${esc(title || "MyClaude 对话分享")}</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: "Segoe UI", "Microsoft YaHei", -apple-system, sans-serif;
         background: #f7f5f1; color: #1f1e1d; line-height: 1.65; }
  header { border-bottom: 1px solid #e5e1da; padding: 22px 20px 16px; }
  .wrap { max-width: 820px; margin: 0 auto; }
  h1 { margin: 0 0 6px; font-size: 19px; font-weight: 650; }
  .meta { font-size: 12.5px; color: #8a857c; display: flex; gap: 14px; flex-wrap: wrap; }
  .badge { display: inline-block; font-size: 11.5px; color: #8a6d3b; background: #f3e8d3;
           border: 1px solid #e5d5b3; border-radius: 999px; padding: 1px 10px; }
  main { padding: 8px 20px 60px; }
  .row { display: grid; grid-template-columns: 52px 1fr; gap: 14px; padding: 18px 0; border-bottom: 1px solid #eceae4; }
  .row:last-child { border-bottom: 0; }
  .who { font-size: 12px; color: #8a857c; padding-top: 3px; }
  .user .bubble { background: #fff; border: 1px solid #e5e1da; border-radius: 12px; padding: 10px 14px; white-space: normal; }
  .asst .body { min-width: 0; overflow-wrap: break-word; }
  .asst .body pre { background: #262624; color: #f5f4f2; border-radius: 10px; padding: 12px 14px; overflow: auto; font-size: 13px; }
  .asst .body code { font-family: Consolas, "JetBrains Mono", monospace; }
  .asst .body :not(pre) > code { background: #ece9e2; border-radius: 5px; padding: 1px 6px; font-size: 0.92em; }
  .asst .body table { border-collapse: collapse; margin: 10px 0; width: 100%; }
  .asst .body th, .asst .body td { border: 1px solid #ddd8ce; padding: 6px 10px; font-size: 13.5px; }
  .asst .body blockquote { margin: 10px 0; padding: 2px 14px; border-left: 3px solid #d97757; color: #57534e; }
  .asst .body h1, .asst .body h2, .asst .body h3 { font-size: 1.05em; margin: 16px 0 6px; }
  .empty { color: #8a857c; padding: 40px 0; text-align: center; }
  footer { border-top: 1px solid #e5e1da; padding: 14px 20px; font-size: 12px; color: #8a857c; text-align: center; }
  @media (prefers-color-scheme: dark) {
    body { background: #262624; color: #f5f4f2; }
    header, footer { border-color: #3a3936; }
    .meta { color: #a8a29a; }
    .user .bubble { background: #30302d; border-color: #3a3936; }
    .row { border-color: #33322f; }
    .asst .body :not(pre) > code { background: #3a3936; }
    .asst .body th, .asst .body td { border-color: #454440; }
    .badge { color: #d8b877; background: #3a3325; border-color: #57492c; }
  }
</style>
</head>
<body>
<header><div class="wrap">
  <h1>${esc(title || "MyClaude 对话分享")}</h1>
  <div class="meta"><span class="badge">只读快照</span><span>${metaBits.join("</span><span>")}</span></div>
</div></header>
<main><div class="wrap">
${renderTranscriptHtml(messages)}
</div></main>
<footer>由 MyClaude 生成的只读对话快照${token ? " · token " + esc(String(token).slice(0, 6)) + "…" : ""}</footer>
</body>
</html>`;
}
