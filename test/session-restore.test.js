import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const app = readFileSync(new URL("../src/ui/web/js/app.js", import.meta.url), "utf8");

// 会话文件被删掉后，启动时的自动恢复必然 404。对用户而言那只是「没有上次」，
// 不该甩一条红色 HTTP 404 让人以为程序坏了。
test("a missing session is not reported as a red error on silent restore", () => {
  const i = app.indexOf("function resumeSession");
  const block = app.slice(i, i + 4200);
  assert.ok(/if \(quiet && \/HTTP 404\//.test(block), "quiet + 404 is special-cased");
  assert.ok(block.includes("localStorage.removeItem(LS_SESSION)"), "stale id is cleared");
});

test("an explicit resume of a vanished session says so in plain words", () => {
  assert.ok(app.includes("该会话已不存在，已开始新对话"), "friendly message for the click path");
});

test("other restore failures are still loud", () => {
  assert.ok(app.includes("上次的会话没能恢复："), "quiet failures other than 404 speak up");
  assert.ok(app.includes("恢复会话失败："), "explicit failures keep the original wording");
});
