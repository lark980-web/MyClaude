#!/usr/bin/env node
/**
 * 给「断言已过但进程不退出」的 GUI 测试文件补 after() 显式收尾。
 *
 * 背景：测试进程里 global fetch（undici 池）的空闲 keep-alive socket 在应用层
 * 够不到（拿不到 dispatcher），server 端 closeAllConnections 也管不到客户端侧，
 * 于是 node:test 跑完所有断言后进程被两个 idle socket 拖住直到外部 timeout。
 * 标准解法：after() 钩子里延迟 process.exit(0)（disconnect-abort 同款）。
 *
 * 用法：node scripts/add-test-after-exit.mjs test/gui-busy.test.js [more files...]
 * 幂等：已含 after( 显式收尾的文件跳过。
 */
import { readFileSync, writeFileSync } from "node:fs";

const files = process.argv.slice(2);
let patched = 0;
for (const file of files) {
  let s = readFileSync(file, "utf8");
  if (/after\(\s*\(\)\s*=>\s*\{/.test(s)) {
    console.log("skip (has after):", file);
    continue;
  }
  if (/from "node:test"/.test(s) === false) {
    console.log("skip (not node:test):", file);
    continue;
  }
  if (/import \{ after \} from "node:test"/.test(s) === false) {
    s = s.replace(/import test from "node:test";/, 'import test from "node:test";\nimport { after } from "node:test";');
  }
  const marker = s.includes("startGui") || s.includes("startGui(");
  const comment = marker
    ? "// fetch 客户端（undici 池）的空闲 socket 在应用层够不到，会拖住进程自然退出；\n// 断言完成后显式收尾（disconnect-abort 同款）。\nafter(() => {\n  setTimeout(() => process.exit(0), 100).unref?.();\n});\n"
    : "// 测试进程偶发被池化 socket 拖住不退出；断言完成后显式收尾。\nafter(() => {\n  setTimeout(() => process.exit(0), 100).unref?.();\n});\n";
  // 插在最后一个顶层 import/const 环境准备之后：直接放在第一个 test( 之前
  const idx = s.indexOf("\ntest(");
  if (idx < 0) {
    console.log("skip (no test():", file);
    continue;
  }
  s = s.slice(0, idx + 1) + comment + "\n" + s.slice(idx + 1);
  writeFileSync(file, s);
  patched++;
  console.log("patched:", file);
}
console.log("done,", patched, "file(s) patched");
