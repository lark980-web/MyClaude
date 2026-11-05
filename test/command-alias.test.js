import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// /todo 是 /todos 的短写；两个界面都要落到同一个实现上。
test("the TUI accepts /todo as an alias of /todos", () => {
  const src = readFileSync(new URL("../src/main.js", import.meta.url), "utf8");
  assert.match(src, /case "todo":\s*\r?\n\s*case "todos":/, "/todo falls through to /todos");
});

test("the GUI accepts /todo as an alias of /todos", () => {
  const src = readFileSync(new URL("../src/ui/web/js/app.js", import.meta.url), "utf8");
  assert.match(src, /todo: function \(\) \{ return EXTRA_COMMANDS\.todos\(\); \}/, "/todo delegates to todos");
});
