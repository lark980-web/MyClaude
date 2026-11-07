import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { commandCoverage } from "./command-coverage.mjs";

/**
 * 复刻度���度量 —— 数字全部现测，不手抄。
 *
 * 用法：node scripts/parity-metrics.mjs [--json]
 *
 * 上游侧的数据从**运行时**取（bun 执行提取脚本），不是从文档抄的：
 *   - 内置斜杠命令：chunk-egafvyjd.js 的 getBuiltinCommands()
 *   - 工具对象：docs/tool-schemas-2.1.302.json（AST 抽取 + 运行时补齐）
 * 需要 bun 与 B: 虚拟根映射（见 docs/HANDOFF.md §9）；缺任一则上游侧标记为不可用，
 * 脚本不会用旧数字凑数。
 */

function findBun() {
  const env = process.env.MYCLAUDE_ENGINE_BUN;
  if (env && existsSync(env)) return env;
  for (const rel of [join(homedir(), ".bun", "bin", "bun.exe"), join(homedir(), ".bun", "bin", "bun")]) {
    if (existsSync(rel)) return rel;
  }
  return "bun";
}

function upstreamBuiltinCommands() {
  const bun = findBun();
  const script = [
    "const m = await import(\"B:/~BUN/root/chunk-egafvyjd.js\");",
    "const t = await m.getBuiltinCommands();",
    "const names = [];",
    "for (const c of t) { let n = null;",
    "  try { n = typeof c.name === \"function\" ? c.name({}) : c.name; } catch (e) {}",
    "  if (!n) { try { n = c.commandName; } catch (e) {} }",
    "  if (n) names.push(String(n)); }",
    "console.log(JSON.stringify(names));",
  ].join("\n");
  try {
    const out = execFileSync(bun, ["-e", script], { encoding: "utf8", timeout: 120000, windowsHide: true });
    return JSON.parse(out.trim().split(/\r?\n/).pop());
  } catch (e) {
    return null;
  }
}

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const read = (p) => readFileSync(join(ROOT, p), "utf8");

const main = read("src/main.js");
const app = read("src/ui/web/js/app.js");
const tuiSet = new Set([...main.matchAll(/case "([a-z][a-z0-9-]*)":/g)].map((m) => m[1]));
const guiMenu = new Set([...app.matchAll(/\{ k: "\/([a-z][a-z0-9-]*)"/g)].map((m) => m[1]));
const eStart = app.indexOf("var EXTRA_COMMANDS");
const eEnd = app.indexOf("function runServerCommand");
const guiExtra = new Set([...app.slice(eStart, eEnd).matchAll(/^\s{4}"?([a-z][a-z0-9-]*)"?\s*:\s*function/gm)].map((m) => m[1]));
const guiSet = new Set([...guiMenu, ...guiExtra]);

// 分母排除表（R4 重推后 44 项）：云侧/账号/生态 + 上游实验门控默认关闭的命令。
// restart/theme 已于 R4 回收（本地可实现，见 docs/command-denominator.md）；brief 维持排除但理由修正为实验门控。
const CLOUD = new Set(["install-github-app","install-slack-app","login","logout","setup-bedrock","setup-vertex","claim-credit","chrome","desktop","mobile","radio","stickers","powerup","passes","pro-trial-expired","usage-credits","extra-usage","limit-reset","rate-limit-options","privacy-settings","remote-control","remote-env","web-setup","cloud-plugins","design-login","design-consent","design-revoke","feedback","bug","ide","wellbeing","breaks","downtime","low-priority","brief","btw","autofix-pr","copy","teleport","ultraplan","voice","ios","android","__remote-workflow","workflow-launch-exec","workflows","loops","schedule"]);

const out = {};
out.upstream = { available: false };
const builtin = upstreamBuiltinCommands();
if (builtin && builtin.length) {
  out.upstream = commandCoverage(builtin, CLOUD, tuiSet, guiSet);
}

// 工具契约
const doc = JSON.parse(read("docs/tool-schemas-2.1.302.json"));
const list = doc.tools || doc;
const adoptedMod = await import(pathToFileURL(join(ROOT, "src/tools/upstream-schemas.js")).href);
const adopted = Object.keys(adoptedMod.UPSTREAM_TOOL_SCHEMAS.tools);
out.tools = {
  upstreamEntries: list.length,
  upstreamWithSchema: list.filter((x) => x.parameters).length,
  upstreamWithDescription: list.filter((x) => x.description).length,
  adoptedInMyClaude: adopted.length,
  adopted: adopted,
};

// 上游代码规模
const D = "E:/WorkSpaces/Test09/claude-re-2.1.302/02-modules/files";
if (existsSync(D)) {
  const fs2 = await import("node:fs");
  let jsN = 0, jsB = 0, bcN = 0, bcB = 0;
  for (const f of fs2.readdirSync(D)) {
    const st = fs2.statSync(join(D, f));
    if (f.endsWith(".bytecode")) { bcN++; bcB += st.size; }
    else if (f.endsWith(".js")) { jsN++; jsB += st.size; }
  }
  out.code = { plaintextModules: jsN, plaintextMB: Math.round(jsB / 1048576 * 10) / 10, bytecodeModules: bcN, bytecodeMB: Math.round(bcB / 1048576 * 10) / 10 };
}

if (process.argv.includes("--json")) { console.log(JSON.stringify(out, null, 2)); }
else {
  console.log("=== 复刻度量（现测）===");
  if (out.upstream.available) {
    console.log("命令面（上游内置 " + out.upstream.builtinCommands + "）");
    console.log("  口径A 全量 " + out.upstream.builtinCommands + "：TUI " + out.upstream.tuiAllCovered + "=" + out.upstream.tuiAllPct + "%  GUI " + out.upstream.guiAllCovered + "=" + out.upstream.guiAllPct + "%");
    console.log("  口径B 本地相关 " + out.upstream.localCommands + "（排除 " + out.upstream.excluded.length + " 个云侧/账号/生态命令）：TUI " + out.upstream.tuiCovered + "=" + out.upstream.tuiPct + "%  GUI " + out.upstream.guiCovered + "=" + out.upstream.guiPct + "%");
  } else console.log("命令面：上游运行时不可用（需 bun + B: 映射）");
  console.log("工具契约：已接入 " + out.tools.adoptedInMyClaude + " 个 → " + out.tools.adopted.join(", "));
  console.log("  上游工具条目 " + out.tools.upstreamEntries + "（带 schema " + out.tools.upstreamWithSchema + "，带描述词 " + out.tools.upstreamWithDescription + "）");
  if (out.code) console.log("上游代码：" + out.code.plaintextModules + " 明文模块/" + out.code.plaintextMB + "MB + " + out.code.bytecodeModules + " 字节码模块/" + out.code.bytecodeMB + "MB");
}
