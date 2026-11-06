import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createVimSession, vimApply, vimEnabled, normalizeInsertRemaps,
  visualSelection, resetVimSession, vimPendingLabel,
  NORMAL, INSERT, VISUAL, VLINE,
} from '../src/ui/vim.js';

// 键事件构造：ink 的 (ch, key) 形状
const tap = (st, ch, key = {}, now) => vimApply(st, ch, key, now);
const ESC = (st, now) => tap(st, '', { escape: true }, now);
const RET = (st) => tap(st, '', { return: true });
const type = (st, str) => { for (const c of str) tap(st, c); };
/** NORMAL 起始会话：新建（INSERT 默认）→ esc → 恢复光标、清 esc 计时。 */
const N = (opts = {}) => {
  const st = createVimSession(opts);
  ESC(st);
  if (opts.cursor != null) st.cursor = Math.max(0, Math.min(st.text.length, opts.cursor));
  st.lastEsc = 0;
  return st;
};

// ------------------------------------------------------- 启用判定与 remaps

test('vimEnabled: editorMode("vim") 为上游真键，vimMode 为兼容键', () => {
  assert.equal(vimEnabled({ editorMode: 'vim' }), true);
  assert.equal(vimEnabled({ vimMode: true }), true);
  assert.equal(vimEnabled({ editorMode: 'normal', vimMode: true }), true);
  assert.equal(vimEnabled({ editorMode: 'normal', vimMode: false }), false);
  assert.equal(vimEnabled({}), false);
  assert.equal(vimEnabled(null), false);
});

test('normalizeInsertRemaps 照上游 pn()：仅两字符键 → <Esc>', () => {
  const rm = normalizeInsertRemaps({ jj: '<esc>', kk: '<ESC>', a: '<esc>', jjj: '<esc>', 'j\t': '<esc>', zz: '<cr>' });
  assert.equal(rm.get('jj'), '<Esc>');
  assert.equal(rm.get('kk'), '<Esc>');
  assert.equal(rm.has('a'), false, '单字符键被拒');
  assert.equal(rm.has('jjj'), false, '三字符键被拒');
  assert.equal(rm.has('j\t'), false, '控制字符键被拒');
  assert.equal(rm.has('zz'), false, '非 <Esc> 目标被拒');
});

// ------------------------------------------------------- 模式与基本输入

test('新会话从 INSERT 开始（上游默认 "INSERT"），esc 进 NORMAL', () => {
  const st = createVimSession({});
  assert.equal(st.mode, INSERT);
  type(st, 'hello');
  assert.equal(st.text, 'hello');
  assert.equal(st.cursor, 5);
  ESC(st);
  assert.equal(st.mode, NORMAL);
  assert.equal(st.cursor, 4, 'esc 光标左移一位');
  tap(st, 'l');
  assert.equal(st.cursor, 5);
  tap(st, 'h');
  assert.equal(st.cursor, 4);
  tap(st, 'i');
  assert.equal(st.mode, INSERT);
  type(st, 'X');
  assert.equal(st.text, 'hellXo', '在光标处插入');
});

test('enter 在两种模式都提交；提交后 resetVimSession 保留模式', () => {
  for (const startNormal of [false, true]) {
    const st = createVimSession({ text: 'hello', cursor: 2 });
    if (startNormal) ESC(st);
    const r = RET(st);
    assert.equal(r.submit, true);
    resetVimSession(st);
    assert.equal(st.text, '');
    assert.equal(st.cursor, 0);
    assert.equal(st.mode, startNormal ? NORMAL : INSERT);
  }
});

test('插入模式退格/删除/方向键', () => {
  const st = createVimSession({ text: 'abcd', cursor: 4 }); // 默认 INSERT
  tap(st, '', { backspace: true });
  assert.equal(st.text, 'abc');
  tap(st, '', { backspace: true });
  assert.equal(st.text, 'ab');
  tap(st, '', { leftArrow: true });
  tap(st, '', { delete: true });
  assert.equal(st.text, 'a', '光标 1 处 delete 删 b');
  type(st, 'X');
  assert.equal(st.text, 'aX');
  tap(st, '', { backspace: true });
  tap(st, '', { backspace: true });
  assert.equal(st.text, '');
  tap(st, '', { backspace: true });
  assert.equal(st.text, '', '空串退格安全');
});

test('插入模式 readline 键（上游：word-editing keys follow Bash readline）', () => {
  const st = N({ text: '  hello world', cursor: 8 });
  tap(st, 'i');
  tap(st, 'a', { ctrl: true });
  assert.equal(st.cursor, 2, 'ctrl+a 行首非空白');
  tap(st, 'e', { ctrl: true });
  assert.equal(st.cursor, 13, 'ctrl+e 行尾');
  tap(st, 'b', { ctrl: true });
  assert.equal(st.cursor, 12);
  tap(st, 'f', { ctrl: true });
  assert.equal(st.cursor, 13);
  tap(st, 'w', { ctrl: true });
  assert.equal(st.text, '  hello ', 'ctrl+w 删一词');
  assert.equal(st.cursor, 8);
  tap(st, 'k', { ctrl: true });
  assert.equal(st.text, '  hello ', '光标已在行尾，kill 无内容');
  assert.equal(st.register, 'world', '寄存器保留 ctrl+w 的内容');
  type(st, 'hx');
  assert.equal(st.text, '  hello hx');
});

// ------------------------------------------------------- NORMAL 运动

test('w/b/e 词运动与计数', () => {
  const st = N({ text: 'foo bar baz', cursor: 0 });
  tap(st, 'w');
  assert.equal(st.cursor, 4);
  tap(st, 'w');
  assert.equal(st.cursor, 8);
  tap(st, '3');
  tap(st, 'w');
  assert.equal(st.cursor, 11, '3w 到行尾止');
  tap(st, 'b');
  assert.equal(st.cursor, 8);
  tap(st, 'b');
  assert.equal(st.cursor, 4);
  tap(st, 'e');
  assert.equal(st.cursor, 6);
  tap(st, 'W');
  assert.equal(st.cursor, 8, 'W 向前到下一个 WORD 头');
});

test('h/l/0/^/$ 与 clamp（上游 l 可停在行末偏移）', () => {
  const st = N({ text: 'abc', cursor: 1 });
  tap(st, 'h'); tap(st, 'h');
  assert.equal(st.cursor, 0, 'h 到行首 clamp');
  tap(st, 'l'); tap(st, 'l'); tap(st, 'l');
  assert.equal(st.cursor, 3, 'l 可到行末偏移（=插入点模型）');
  tap(st, '$');
  assert.equal(st.cursor, 3);
  tap(st, '^');
  assert.equal(st.cursor, 0);
  tap(st, '0');
  assert.equal(st.cursor, 0);
});

test('1G 与裸 G 区分（rawCount 通路）', () => {
  const st = N({ text: 'a\nb\nc', cursor: 4 });
  tap(st, '1'); tap(st, 'G');
  assert.equal(st.cursor, 0, '1G 到第 1 行');
  tap(st, 'G');
  assert.equal(st.cursor, 4, '裸 G 到末行');
});

test('f/F/t/T 与 ;/, 重复（照上游 Fe() 反向规则）', () => {
  const st = N({ text: 'aXbXc', cursor: 0 });
  tap(st, 'f'); tap(st, 'X');
  assert.equal(st.cursor, 1);
  tap(st, ';');
  assert.equal(st.cursor, 3, '; 重复 f');
  tap(st, ',');
  assert.equal(st.cursor, 1, ', 反向');
  tap(st, 't'); tap(st, 'X');
  assert.equal(st.cursor, 2, 't 停在命中字符前');
  tap(st, 'd'); tap(st, 't'); tap(st, 'X');
  assert.equal(st.text, 'aXXc', 'dtX 删到 X 前不含 X', st.text);
  const st2 = N({ text: 'aXbXc', cursor: 0 });
  tap(st2, 'd'); tap(st2, 'f'); tap(st2, 'X');
  assert.equal(st2.text, 'bXc', 'dfX 含命中字符');
  assert.equal(st2.register, 'aX', st2.register);
  const st3 = N({ text: 'aXbXc', cursor: 4 });
  tap(st3, 'F'); tap(st3, 'X');
  assert.equal(st3.cursor, 3, 'F 反向命中');
  tap(st3, 'T'); tap(st3, 'X');
  assert.equal(st3.cursor, 2, 'T 停在命中字符后');
});

test('% 括号匹配', () => {
  const st = N({ text: '(a[b]c)', cursor: 2 });
  tap(st, '%');
  assert.equal(st.cursor, 4, '[ → ]');
  tap(st, '%');
  assert.equal(st.cursor, 2);
  tap(st, '0');
  tap(st, '%');
  assert.equal(st.cursor, 6, '( → )');
});

test('多行 j/k/G（粘贴场景），wanted 列保持', () => {
  const st = N({ text: 'first\nsecond\nthird', cursor: 2 });
  tap(st, 'j');
  assert.equal(st.cursor, 8, 'j 保持列 2');
  tap(st, 'j');
  assert.equal(st.cursor, 15);
  tap(st, 'k');
  assert.equal(st.cursor, 8);
  tap(st, 'k');
  assert.equal(st.cursor, 2);
  tap(st, 'G');
  assert.equal(st.cursor, 13, 'G 到末行行首');
});

// ------------------------------------------------------- 操作符

test('dw/db/de/d$/d0/d^', () => {
  const st = N({ text: 'foo bar baz', cursor: 0 });
  tap(st, 'd'); tap(st, 'w');
  assert.equal(st.text, 'bar baz', 'dw 含尾随空格');
  tap(st, 'd'); tap(st, '$');
  assert.equal(st.text, '', 'd$ 删到行尾（此处即整行）');
  tap(st, 'u');
  assert.equal(st.text, 'bar baz');
  tap(st, 'b'); tap(st, 'b');
  assert.equal(st.cursor, 0);
  tap(st, 'd'); tap(st, 'e');
  assert.equal(st.text, ' baz', 'de 含词尾字符', st.text);
  const st2 = N({ text: 'keep this', cursor: 5 });
  tap(st2, 'd'); tap(st2, '0');
  assert.equal(st2.text, 'this');
  const st3 = N({ text: '  indented', cursor: 5 });
  tap(st3, 'd'); tap(st3, '^');
  assert.equal(st3.text, '  ented', 'd^ 删 [首非空白, 光标)', st3.text);
});

test('计数乘法：2d3w = 6 词；d2w = 2 词', () => {
  const st = N({ text: 'a b c d e f g', cursor: 0 });
  tap(st, '2'); tap(st, 'd'); tap(st, '3'); tap(st, 'w');
  assert.equal(st.text, 'g', st.text);
  const st2 = N({ text: 'hello world', cursor: 0 });
  tap(st2, 'd'); tap(st2, '2'); tap(st2, 'w');
  assert.equal(st2.text, '', 'd2w 删两个词');
  const st3 = N({ text: 'hello world', cursor: 0 });
  tap(st3, '2'); tap(st3, 'd'); tap(st3, 'w');
  assert.equal(st3.text, '', '2dw 同义');
});

test('dw 落点等于光标时不动（上游 q() 空范围分支）', () => {
  const st = N({ text: 'word', cursor: 4 });
  tap(st, 'd'); tap(st, 'w');
  assert.equal(st.text, 'word', '行尾 dw 不删');
  tap(st, 'y'); tap(st, 'w');
  assert.equal(st.register, '', '行尾 yw 清寄存器');
  const st2 = N({ text: 'word', cursor: 4 });
  tap(st2, 'c'); tap(st2, 'w');
  assert.equal(st2.mode, INSERT, '行尾 cw 进插入');
  assert.equal(st2.text, 'word');
});

test('cw 在非空白上删到词尾（上游 cn() change+w 特判），S 清行', () => {
  const st = N({ text: 'hello world', cursor: 0 });
  tap(st, 'c'); tap(st, 'w');
  assert.equal(st.mode, INSERT);
  assert.equal(st.text, ' world', 'cw 留下空格');
  type(st, 'hey');
  assert.equal(st.text, 'hey world');
  ESC(st);
  tap(st, 'A');
  type(st, '!');
  assert.equal(st.text, 'hey world!');
  const st2 = N({ text: 'one two', cursor: 4 });
  tap(st2, 'S');
  assert.equal(st2.mode, INSERT, 'S 清行进插入');
  assert.equal(st2.text, '', st2.text);
  type(st2, '2');
  assert.equal(st2.text, '2');
});

test('dd/yy 行级 + p/P 粘贴（linewise 寄存器）', () => {
  const st = N({ text: 'abc def', cursor: 4 });
  tap(st, 'y'); tap(st, 'y');
  assert.equal(st.register, 'abc def');
  assert.equal(st.regLinewise, true);
  tap(st, 'p');
  assert.equal(st.text, 'abc def\nabc def');
  assert.equal(st.cursor, 8, '粘贴后光标到新行行首');
  tap(st, 'd'); tap(st, 'd');
  assert.equal(st.text, 'abc def');
  tap(st, 'P');
  assert.equal(st.text, 'abc def\nabc def');
});

test('charwise p 重复计数', () => {
  const st = N({ text: 'ab', cursor: 0 });
  tap(st, 'y'); tap(st, 'l');
  assert.equal(st.register, 'a');
  tap(st, '2'); tap(st, 'p');
  assert.equal(st.text, 'aaab', st.text);
});

test('x/s/D/C/X 语义（x 行尾 clamp；上游 mn 表无 X → NORMAL 不动）', () => {
  const st = N({ text: 'abc', cursor: 0 });
  tap(st, 'x');
  assert.equal(st.text, 'bc');
  tap(st, '3'); tap(st, 'x');
  assert.equal(st.text, '', '3x 行尾 clamp');
  tap(st, 'u');
  assert.equal(st.text, 'bc');
  const st2 = N({ text: 'ab', cursor: 0 });
  tap(st2, 's');
  assert.equal(st2.mode, INSERT);
  assert.equal(st2.text, 'b');
  type(st2, 'X');
  assert.equal(st2.text, 'Xb');
  const st3 = N({ text: 'hello', cursor: 1 });
  tap(st3, 'D');
  assert.equal(st3.text, 'h');
  const st4 = N({ text: 'hello', cursor: 1 });
  tap(st4, 'C');
  type(st4, 'ey!');
  assert.equal(st4.text, 'hey!');
  const st5 = N({ text: 'abc', cursor: 1 });
  tap(st5, 'X');
  assert.equal(st5.text, 'abc', '上游 NORMAL 无 X 动作');
});

test('r 替换与行尾 clamp（照上游 Re()）', () => {
  const st = N({ text: 'Hello', cursor: 0 });
  tap(st, 'r'); tap(st, 'J');
  assert.equal(st.text, 'Jello', 'r 换字符');
  tap(st, '3'); tap(st, 'r'); tap(st, 'x');
  assert.equal(st.text, 'xxxlo', '3r 从 0 替换 3 字符', st.text);
  assert.equal(st.cursor, 2, 'r 后光标在最后一个替换字符');
  const st2 = N({ text: 'ab', cursor: 0 });
  tap(st2, '3'); tap(st2, 'r'); tap(st2, 'x');
  assert.equal(st2.text, 'ab', '跨行尾整体不动');
});

test('~ 翻转大小写（照上游 ve()）', () => {
  const st = N({ text: 'hello World', cursor: 0 });
  tap(st, '~');
  assert.equal(st.text, 'Hello World');
  assert.equal(st.cursor, 0);
  tap(st, '5'); tap(st, '~');
  assert.equal(st.text, 'hELLO World', '5~ 翻转 5 字符');
  assert.equal(st.cursor, 4);
});

test('dG/dgg 行级范围', () => {
  const st = N({ text: 'one\ntwo\nthree', cursor: 4 });
  tap(st, 'd'); tap(st, 'g'); tap(st, 'g');
  assert.equal(st.text, 'three', 'dgg 删到首行（含当前行）', st.text);
  const st2 = N({ text: 'one\ntwo\nthree', cursor: 0 });
  tap(st2, 'd'); tap(st2, 'G');
  assert.equal(st2.text, '', 'dG 从第 1 行删到末行');
  const st3 = N({ text: 'one\ntwo\nthree', cursor: 0 });
  tap(st3, 'd'); tap(st3, '2'); tap(st3, 'G');
  assert.equal(st3.text, 'three', 'd2G 删到第 2 行');
});

test('J 合并行（上游 Je/Ot：剥行首空白、")" 前不加空格）', () => {
  const st = N({ text: 'a\n  b\nc', cursor: 0 });
  tap(st, 'J');
  assert.equal(st.text, 'a b\nc', st.text);
  const st2 = N({ text: 'f(x)\n g', cursor: 0 });
  tap(st2, 'J');
  assert.equal(st2.text, 'f(x) g', '下一个字符是 ) 不加空格', st2.text);
});

test('o/O 开新行（上游 le()）', () => {
  const st = N({ text: 'one\ntwo', cursor: 3 });
  tap(st, 'o');
  assert.equal(st.mode, INSERT);
  assert.equal(st.text, 'one\n\ntwo');
  assert.equal(st.cursor, 4);
  type(st, 'mid');
  assert.equal(st.text, 'one\nmid\ntwo');
  const st2 = N({ text: 'one\ntwo', cursor: 4 });
  tap(st2, 'O');
  assert.equal(st2.text, 'one\n\ntwo');
  assert.equal(st2.cursor, 5, '光标在新空行的插入点');
});

// ------------------------------------------------------- 文本对象

test('diw/daw/ciw/caw', () => {
  const st = N({ text: 'say hello world', cursor: 5 });
  tap(st, 'd'); tap(st, 'i'); tap(st, 'w');
  assert.equal(st.text, 'say  world');
  const st2 = N({ text: 'say hello world', cursor: 5 });
  tap(st2, 'd'); tap(st2, 'a'); tap(st2, 'w');
  assert.equal(st2.text, 'say world');
  const st3 = N({ text: 'say hello world', cursor: 5 });
  tap(st3, 'c'); tap(st3, 'i'); tap(st3, 'w');
  assert.equal(st3.mode, INSERT);
  assert.equal(st3.text, 'say  world');
  type(st3, 'hey');
  assert.equal(st3.text, 'say hey world');
});

test('di(/ci"/da[ 括号与引号对象', () => {
  const st = N({ text: 'call(foo)', cursor: 5 });
  tap(st, 'd'); tap(st, 'i'); tap(st, '(');
  assert.equal(st.text, 'call()');
  const st2 = N({ text: 'say "hi there" ok', cursor: 6 });
  tap(st2, 'c'); tap(st2, 'i'); tap(st2, '"');
  assert.equal(st2.mode, INSERT);
  assert.equal(st2.text, 'say "" ok');
  type(st2, 'yo');
  assert.equal(st2.text, 'say "yo" ok');
  const st3 = N({ text: 'x = arr[1]', cursor: 7 });
  tap(st3, 'd'); tap(st3, 'a'); tap(st3, '[');
  assert.equal(st3.text, 'x = arr', st3.text);
});

// ------------------------------------------------------- VISUAL / VISUAL LINE

test('v + 运动 + d/y（charwise，含光标字符）', () => {
  const st = N({ text: 'hello world', cursor: 0 });
  tap(st, 'v'); tap(st, 'l'); tap(st, 'l');
  assert.deepEqual(visualSelection(st), [[0, 3]]);
  tap(st, 'd');
  assert.equal(st.text, 'lo world');
  assert.equal(st.mode, NORMAL);
  const st2 = N({ text: 'hello world', cursor: 0 });
  tap(st2, 'v'); tap(st2, 'e');
  assert.deepEqual(visualSelection(st2), [[0, 5]], 'e 端点包含');
  tap(st2, 'y');
  assert.equal(st2.register, 'hello');
  tap(st2, '$'); tap(st2, 'p');
  assert.equal(st2.text, 'hello worldhello');
});

test('V 行选择 + y/p 行级', () => {
  const st = N({ text: 'abc def', cursor: 4 });
  tap(st, 'V');
  assert.equal(st.mode, VLINE);
  tap(st, 'y');
  assert.equal(st.register, 'abc def');
  assert.equal(st.regLinewise, true);
  tap(st, 'p');
  assert.equal(st.text, 'abc def\nabc def');
  const st2 = N({ text: 'a\nb\nc', cursor: 0 });
  tap(st2, 'V'); tap(st2, 'j'); tap(st2, 'd');
  assert.equal(st2.text, 'c', st2.text);
});

test('visual 内 u/U/~ 大小写（wn 表）', () => {
  const st = N({ text: 'hello', cursor: 0 });
  tap(st, 'v'); tap(st, 'e');
  tap(st, 'U');
  assert.equal(st.text, 'HELLO');
  tap(st, '0'); tap(st, 'v'); tap(st, 'e');
  tap(st, 'u');
  assert.equal(st.text, 'hello');
  tap(st, '0'); tap(st, 'v'); tap(st, 'e');
  tap(st, '~');
  assert.equal(st.text, 'HELLO');
});

test('o 交换两端；v/V 切换与退出', () => {
  const st = N({ text: 'abcdef', cursor: 0 });
  tap(st, 'v'); tap(st, 'l'); tap(st, 'l');
  tap(st, 'o');
  assert.equal(st.cursor, 0);
  assert.equal(st.anchor, 2);
  tap(st, 'V');
  assert.equal(st.mode, VLINE, 'v 中按 V 切行选择');
  tap(st, 'v');
  assert.equal(st.mode, VISUAL);
  tap(st, 'v');
  assert.equal(st.mode, NORMAL, '同类再按退出');
});

test('visual r 替换选区（charwise 每字符 / VLINE 整行）', () => {
  const st = N({ text: 'abc', cursor: 0 });
  tap(st, 'v'); tap(st, 'l');
  tap(st, 'r'); tap(st, 'x');
  assert.equal(st.text, 'xxc', st.text);
  const st2 = N({ text: 'abc', cursor: 0 });
  tap(st2, 'V'); tap(st2, 'r'); tap(st2, 'x');
  assert.equal(st2.text, 'xxx', st2.text);
});

test('visual c/s 进入插入；p 用寄存器替换选区', () => {
  const st = N({ text: 'abcdef', cursor: 0 });
  tap(st, 'v'); tap(st, 'l'); tap(st, 'l');
  tap(st, 'c');
  assert.equal(st.mode, INSERT);
  assert.equal(st.text, 'def');
  type(st, 'X');
  assert.equal(st.text, 'Xdef');
  const st2 = N({ text: 'abcdef', cursor: 0 });
  tap(st2, 'y'); tap(st2, 'l');
  tap(st2, 'v'); tap(st2, 'l'); tap(st2, 'l');
  tap(st2, 'p');
  assert.equal(st2.text, 'adef', '选区被寄存器 "a" 替换', st2.text);
});

test('visual enter 提交；esc 退出', () => {
  const st = N({ text: 'abc', cursor: 0 });
  tap(st, 'v'); tap(st, 'l');
  const r = RET(st);
  assert.equal(r.submit, true);
  const st2 = N({ text: 'abc', cursor: 0 });
  tap(st2, 'v');
  ESC(st2);
  assert.equal(st2.mode, NORMAL);
});

// ------------------------------------------------------- 撤销与杂项

test('u 撤销：普通操作与整段插入会话', () => {
  const st = N({ text: 'abc', cursor: 0 });
  tap(st, 'x');
  assert.equal(st.text, 'bc');
  tap(st, 'i');
  type(st, 'Z');
  ESC(st);
  assert.equal(st.text, 'Zbc');
  tap(st, 'u');
  assert.equal(st.text, 'bc', '第一次 u 撤整段插入');
  tap(st, 'u');
  assert.equal(st.text, 'abc', '第二次 u 撤 x');
  assert.equal(st.cursor, 0);
});

test('double-esc 清空（上游页脚 "double tap esc to clear input"），可撤销', () => {
  const st = N({ text: 'temp', cursor: 4 });
  ESC(st, 1000);
  assert.equal(st.text, 'temp', '第一下只武装');
  ESC(st, 1500);
  assert.equal(st.text, '', '1s 内第二下清空');
  ESC(st, 1600);
  ESC(st, 1700);
  assert.equal(st.text, '', '空输入上的双击无副作用');
  tap(st, 'u');
  assert.equal(st.text, 'temp', '撤销弹掉的是清空前快照');
  const st2 = N({ text: 'again', cursor: 5 });
  ESC(st2, 2000);
  ESC(st2, 2500);
  assert.equal(st2.text, '');
  tap(st2, 'u');
  assert.equal(st2.text, 'again', '清空可撤销');
});

test('插入模式 remap {"jj":"<Esc>"}（上游 vimInsertModeRemaps）', () => {
  const st = createVimSession({
    text: 'hello', cursor: 5,
    insertRemaps: normalizeInsertRemaps({ jj: '<Esc>' }),
  });
  tap(st, 'j');
  assert.equal(st.mode, INSERT, '首字符缓冲不插入');
  assert.equal(st.text, 'hello');
  tap(st, 'j');
  assert.equal(st.mode, NORMAL, 'jj 触发 esc');
  assert.equal(st.cursor, 4, 'esc 语义光标左移');
  tap(st, 'A');
  tap(st, 'j'); tap(st, 'x');
  assert.equal(st.text, 'hellojx', '不成对时缓冲照常插入');
  assert.equal(st.mode, INSERT);
});

test('NORMAL X、未收录键、计数上限 10000（上游 pt），计数用后清空', () => {
  const st = N({ text: 'abc', cursor: 1 });
  tap(st, 'X');
  assert.equal(st.text, 'abc');
  tap(st, 'Q');
  assert.equal(st.text, 'abc', '未收录键不动');
  const st2 = N({ text: 'abc', cursor: 0 });
  for (const c of '99999') tap(st2, c);
  tap(st2, 'x');
  assert.equal(st2.text, '', '计数 clamp 到 10000，x 删至行尾');
  assert.equal(vimPendingLabel(st2), '', '动作完成后 pending 清空');
  tap(st2, '', { backspace: true });
  tap(st2, '', { backspace: true });
  assert.equal(st2.text, '', '第二次 x 不再吃旧计数（text 已空，退格验证在插入态）');
});

test('2d3w 期间 pending 标签可见（showcmd 含 opCount）', () => {
  const st = N({ text: 'a b c', cursor: 0 });
  tap(st, '2');
  assert.equal(vimPendingLabel(st), '2');
  tap(st, 'd');
  assert.equal(vimPendingLabel(st), '2d');
  tap(st, 'w');
  assert.equal(st.text, 'c', st.text);
  assert.equal(vimPendingLabel(st), '');
});

test('resetVimSession 不清寄存器与撤销栈（跨提交保留）', () => {
  const st = N({ text: 'keep', cursor: 0 });
  tap(st, 'y'); tap(st, 'y');
  assert.equal(st.register, 'keep');
  tap(st, 'd'); tap(st, 'd'); // dd 后寄存器仍为整行
  assert.equal(st.register, 'keep');
  resetVimSession(st);
  assert.equal(st.register, 'keep', '寄存器跨提交保留');
  assert.equal(st.undo.length > 0, true, '撤销栈跨提交保留');
});
