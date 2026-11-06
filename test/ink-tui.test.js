/**
 * ink TUI 真渲染测试座架。
 *
 * 此前用管道驱动 exe：stdin 无 raw mode 时 ink 直接拒绝，TUI 实际回落到
 * plain TerminalUI —— 管道 e2e 从未测过 ink 组件本身（顺带暴露了 StatusLine
 * 的裸 dimColor ReferenceError，真 TTY 下 TUI 一渲染就崩）。ink 支持注入
 * mock stdin/stdout，这里真渲染 App：按键 → 组件状态 → 渲染帧，全部真实。
 *
 * 帧捕获用 stdout.write 包装（无损）；read() 轮询会因 Buffer/分块丢帧。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import React from "react";
import { render } from "ink";
import { App } from "../src/ui/ink-app.js";
import { TuiBridge } from "../src/ui/tui-bridge.js";

const h = React.createElement;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function mockStdin() {
  const s = new PassThrough();
  s.isTTY = true;
  s.setRawMode = () => s;
  // ink 的 useInput 挂载会调用 stdin.ref()/unref() —— PassThrough 没有这两个
  // 方法，缺桩会让输入监听静默挂掉（React 错误边界吞掉 TypeError）。
  s.ref = () => s;
  s.unref = () => s;
  s.resume();
  return s;
}

function mockStdout(capture) {
  const s = new PassThrough();
  s.isTTY = true;
  s.columns = 100;
  s.rows = 40;
  const orig = s.write.bind(s);
  s.write = (d) => {
    try { capture.push(String(d)); } catch {}
    return orig(d);
  };
  return s;
}

function startTuiHarness({ vim = false, busy = false, users = ["q1", "q2"] } = {}) {
  const bridge = new TuiBridge({ config: {} });
  bridge.state.busy = busy;
  for (const u of users) { bridge.user(u); }
  // StatusLine 渲染 config.model/permissionMode/provider —— 缺字段会让 Text
  // 收到 undefined 子节点炸树，React 错误边界吞掉输入监听。
  const baseConfig = { model: "test-model", permissionMode: "ask", provider: "test" };
  const config = vim ? { ...baseConfig, vimMode: true } : baseConfig;
  const stdin = mockStdin();
  const capture = [];
  const stdout = mockStdout(capture);
  const calls = { onEditMessage: [], onSubmit: [], onCommand: [] };
  const instance = render(
    h(App, {
      bridge,
      config,
      onSubmit: async (t) => { calls.onSubmit.push(t); },
      onCommand: async (t) => { calls.onCommand.push(t); },
      onEditMessage: async (depth, text) => { calls.onEditMessage.push({ depth, text }); },
      getTodos: () => [],
    }),
    { stdin, stdout, exitOnCtrlC: false, patchConsole: false }
  );
  const frames = () => capture.join("").replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
  const key = (data) => stdin.write(data);
  // 逐字符输入：ink 按 chunk 解析，含回车 同块会被当作非回车事件吞掉
  const type = async (str) => { for (const c of str) { stdin.write(c); await sleep(25); } };
  const waitFrame = async (cond, ms = 4000, what = "frame") => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      if (cond(frames())) return true;
      await sleep(60);
    }
    throw new Error("timeout: " + what + " | tail=" + frames().slice(-160).replace(/\s+/g, " "));
  };
  return { bridge, stdin, stdout, instance, calls, key, type, waitFrame, frames };
}

test("双 esc 唤起「编辑上一条消息」选择器，↑/↓ 选择，Enter 进入编辑模式", async () => {
  const t = startTuiHarness({});
  try {
    await sleep(300);
    t.key("\x1b");
    await sleep(120);
    t.key("\x1b");
    await t.waitFrame((f) => f.includes("编辑上一条消息"), 4000, "picker opens");
    await sleep(150); // 等 passive effect 落定
    t.key("\x1b[B"); // ↓ → 第 2 条（q1，depth=2）
    await sleep(120);
    t.key("\r"); // Enter → 编辑模式
    await t.waitFrame((f) => f.includes("正在编辑倒数第 2 条"), 4000, "editing hint");
    t.key("\r"); // 直接重发预填文本（ink-text-input 的游标状态不归本测试管，重发路由才是重点）
    await t.waitFrame(() => t.calls.onEditMessage.length > 0, 4000, "resubmit");
    assert.deepEqual(t.calls.onEditMessage, [{ depth: 2, text: "q1" }]);
  } finally { t.instance.unmount(); }
});

test("esc 取消选择器；编辑模式 esc 取消不触发重发", async () => {
  const t = startTuiHarness({});
  try {
    await sleep(300);
    t.key("\x1b"); await sleep(120);
    t.key("\x1b");
    await t.waitFrame((f) => f.includes("编辑上一条消息"), 4000, "picker opens");
    t.key("\x1b"); // 取消选择器
    await sleep(400);
    const afterCancel = t.frames().slice(-600);
    assert.equal(afterCancel.includes("编辑上一条消息"), false, "选择器已关闭");
    t.key("\x1b"); await sleep(120);
    t.key("\x1b");
    await t.waitFrame((f) => f.includes("编辑上一条消息"), 4000, "picker reopens");
    await sleep(150); // 等 React passive effect（useInput 重订阅）落定
    t.key("\r");
    await t.waitFrame((f) => f.includes("正在编辑倒数第 1 条"), 4000, "editing");
    t.key("\x1b"); // 编辑模式取消
    await sleep(400);
    assert.equal(t.calls.onEditMessage.length, 0, "取消后不重发");
  } finally { t.instance.unmount(); }
});

test("busy 时不唤起选择器", async () => {
  const t = startTuiHarness({ busy: true });
  try {
    await sleep(300);
    t.key("\x1b"); await sleep(120);
    t.key("\x1b");
    await sleep(600);
    assert.equal(t.frames().includes("编辑上一条消息"), false, "busy 时选择器不开");
  } finally { t.instance.unmount(); }
});

test("vim 模式：空输入双 esc 同样唤起选择器，编辑回填进 INSERT", async () => {
  const t = startTuiHarness({ vim: true });
  try {
    await sleep(300);
    t.key("\x1b"); // INSERT → NORMAL
    await sleep(120);
    t.key("\x1b"); // NORMAL 空 → 选择器
    await t.waitFrame((f) => f.includes("编辑上一条消息"), 4000, "picker opens in vim");
    t.key("\r");
    await t.waitFrame((f) => f.includes("正在编辑倒数第 1 条") && f.includes("-- INSERT --"), 4000, "editing in INSERT");
    t.key("\r"); // 重发预填文本
    await t.waitFrame(() => t.calls.onEditMessage.length > 0, 4000, "resubmit");
    assert.deepEqual(t.calls.onEditMessage, [{ depth: 1, text: "q2" }]);
  } finally { t.instance.unmount(); }
});
