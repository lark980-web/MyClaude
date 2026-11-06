/**
 * vim 编辑引擎（纯状态机，无 React/Ink 依赖；键事件用 ink 的 (ch, key) 形状）。
 *
 * 上游依据（claude-re-2.1.302/02-modules/files/）：
 * - chunk-2n177qz0.js    状态机 idle/count/operator/.../replace 与两张动作表
 *                        （mn = NORMAL 即时动作，wn = VISUAL 动作）、
 *                        操作符 ge={d,c,y}、运动集 dt/xe、find 集 Oe={f,F,t,T}、
 *                        文本对象 be={i,a}、计数上限 pt=10000、
 *                        单一寄存器 + registerIsLinewise、插入进入位置 Qe()、
 *                        remaps 规范化 pn()（两字符 → <Esc>）、撤销 onUndo
 * - chunk-xsh3yvk4.js    editorMode 枚举 yBo=["normal","vim"]
 * - chunk-ngbt62mk.js    启用判定 editorMode==="vim"
 * - chunk-e0x0xb6d.js    statusline stdin 契约 vim.mode ∈ INSERT|NORMAL|VISUAL|VISUAL LINE
 * - chunk-a8gj4nyv.js    vimInsertModeRemaps schema：{"jj":"<Esc>"}，仅 <Esc> 目标
 * - chunk-9fg8a8zw.js    页脚 "double tap esc to clear input"
 *
 * 已知与上游的差异（如实记录）：
 * - 上游 NORMAL 的 X 无动作（mn 表未收录，落回 idle）——本实现同样不动作；
 * - `>`/`<` 缩进是行级排版语义，对提示词输入无对应概念，不实现；
 * - 寄存器只有上游提取到的单一匿名寄存器（gt(): register + registerIsLinewise）；
 * - 无宏（上游动作表中未见 q）、无搜索、无 redo（上游提取只见 onUndo）。
 */

export const NORMAL = "NORMAL";
export const INSERT = "INSERT";
export const VISUAL = "VISUAL";
export const VLINE = "VISUAL LINE";

const COUNT_MAX = 10000; // 上游 pt=1e4
const UNDO_MAX = 1000; // 上游 Pt=1000

const TOKENS = new Set(["esc", "enter", "backspace", "delete", "left", "right", "up", "down", "tab"]);

/** editorMode 为上游真键（yBo 枚举）；vimMode 为本项目既有布尔键，两者任一即可。 */
export function vimEnabled(config) {
  if (!config) return false;
  return config.editorMode === "vim" || config.vimMode === true;
}

/**
 * 插入模式 remaps 规范化 —— 照上游 pn()：值必须（大小写不敏感）为 "<esc>"，
 * 键 NFC 归一后必须恰好两个「非控制/非分隔」字符；产出 Map<键, "<Esc>">。
 */
export function normalizeInsertRemaps(raw) {
  const out = new Map();
  if (!raw || typeof raw !== "object") return out;
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v !== "string" || v.toLowerCase() !== "<esc>") continue;
    const key = k.normalize("NFC");
    if (!/^[^\p{C}\p{Z}]{2}$/u.test(key)) continue;
    out.set(key, "<Esc>");
  }
  return out;
}

export function createVimSession({ text = "", cursor = 0, insertRemaps = null } = {}) {
  return {
    // 新会话从 INSERT 开始（上游 vimMode 状态默认 "INSERT"：e0x0xb6d.js `vimMode:_e??"INSERT"`），
    // 否则开 vim 后第一件事是按 i 才能打字，不成立即用。
    mode: INSERT,
    text: String(text),
    cursor: clamp(String(text).length, 0, cursor),
    kind: "v", // VISUAL/VLINE 的 kind
    anchor: 0,
    count: "", // 数字缓冲
    opCount: 0, // 操作符键按下时的计数（2d3w = 6）
    op: null, // "d" | "c" | "y"
    pending: null, // {type:"find",data:"f"|...} | {type:"replace"} | {type:"g"} | {type:"obj",data:"i"|"a"} | {type:"vreplace"}
    register: "",
    regLinewise: false,
    lastFind: null, // {type:"f"|"F"|"t"|"T", char}
    insertRemap: insertRemaps instanceof Map ? insertRemaps : normalizeInsertRemaps(insertRemaps),
    remapBuf: "", // 插入模式 remap 的单字符缓冲（上游键恰好 2 字符）
    undo: [], // [{text, cursor}]
    wanted: -1, // j/k 的期望列（$ 后为 Infinity）
    lastEsc: 0, // double-tap-esc 清空的时间戳
  };
}

/** 提交后重置缓冲（模式保留，与上游编辑器一致：提交不清编辑模式）。 */
export function resetVimSession(st, { text = "", cursor = 0 } = {}) {
  st.text = String(text);
  st.cursor = clamp(st.text.length, 0, cursor);
  st.kind = "v";
  st.anchor = st.cursor;
  st.count = "";
  st.opCount = 0;
  st.op = null;
  st.pending = null;
  st.remapBuf = "";
  st.wanted = -1;
}

/** 清空输入（ctrl+u 等全局键），走撤销栈可恢复。 */
export function vimClear(st) {
  pushUndo(st);
  st.text = "";
  st.cursor = 0;
  st.kind = "v";
  st.anchor = 0;
  st.count = "";
  st.opCount = 0;
  st.op = null;
  st.pending = null;
  st.remapBuf = "";
  st.wanted = -1;
}

// ---------------------------------------------------------------- 基础工具

function clamp(hi, lo, v) {
  return Math.max(lo, Math.min(hi, v));
}

const isSpace = (c) => c === " " || c === "\t" || c === "\n" || c === "\r";
const isWordChar = (c) => /[A-Za-z0-9_]/.test(c);
// vim 词类：空白 / word / 标点；WORD 视角下非空白同类
const clsOf = (c, big) => (isSpace(c) ? 0 : big ? 1 : isWordChar(c) ? 1 : 2);

const lineStart = (s, i) => s.lastIndexOf("\n", i - 1) + 1;
const lineEnd = (s, i) => {
  const n = s.indexOf("\n", i);
  return n === -1 ? s.length : n;
};
const firstNonBlank = (s, i) => {
  let j = lineStart(s, i);
  while (j < s.length && (s[j] === " " || s[j] === "\t")) j++;
  return j;
};
const lineIndexAt = (s, i) => s.slice(0, i).split("\n").length - 1;
const lineStartOf = (lines, idx) => {
  let off = 0;
  for (let i = 0; i < idx; i++) off += lines[i].length + 1;
  return off;
};

function pushUndo(st) {
  st.undo.push({ text: st.text, cursor: st.cursor });
  if (st.undo.length > UNDO_MAX) st.undo.shift();
}

function setCursor(st, i) {
  st.cursor = clamp(st.text.length, 0, i);
}

// ---------------------------------------------------------------- 运动

function nextHead(s, i, big) {
  const n = s.length;
  let j = i;
  if (j < n && !isSpace(s[j])) {
    const cls = clsOf(s[j], big);
    while (j < n && clsOf(s[j], big) === cls) j++;
  }
  while (j < n && isSpace(s[j])) j++;
  return Math.min(j, n);
}

function prevHead(s, i, big) {
  if (i <= 0) return 0;
  let j = i - 1;
  while (j > 0 && isSpace(s[j])) j--;
  if (j === 0) return 0;
  const cls = clsOf(s[j], big);
  while (j > 0 && !isSpace(s[j - 1]) && clsOf(s[j - 1], big) === cls) j--;
  return j;
}

function wordEnd(s, i, big) {
  const n = s.length;
  if (n === 0) return 0;
  let j = Math.min(i, n - 1);
  const endOfRunFrom = (k) => {
    const cls = clsOf(s[k], big);
    let m = k;
    while (m + 1 < n && !isSpace(s[m + 1]) && clsOf(s[m + 1], big) === cls) m++;
    return m;
  };
  if (isSpace(s[j])) {
    while (j < n && isSpace(s[j])) j++;
    if (j >= n) return n - 1;
    return endOfRunFrom(j);
  }
  const end = endOfRunFrom(j);
  if (end > j) return end; // 在 run 中段 → run 尾
  // 已在 run 尾 → 下一个 run 的尾
  let k = end + 1;
  while (k < n && isSpace(s[k])) k++;
  if (k >= n) return end;
  return endOfRunFrom(k);
}

/** 当前行内的第 count 个字符查找（f/F/t/T）。返回 -1 表示找不到。 */
function findInLine(s, i, type, ch, count) {
  const a = lineStart(s, i);
  const b = lineEnd(s, i);
  let pos = i;
  const forward = type === "f" || type === "t";
  for (let n = 0; n < count; n++) {
    let hit = -1;
    if (forward) {
      for (let k = pos + 1; k < b; k++) {
        if (s[k] === ch) { hit = k; break; }
      }
    } else {
      for (let k = pos - 1; k >= a; k--) {
        if (s[k] === ch) { hit = k; break; }
      }
    }
    if (hit === -1) return -1;
    pos = hit;
  }
  if (type === "t") return pos > a ? pos - 1 : -1;
  if (type === "T") return pos < b - 1 ? pos + 1 : -1;
  return pos;
}

/** % 括号匹配（同对括号深度计数）。找不到返回 -1。 */
function matchBracket(s, i) {
  const pairs = { "(": ")", "[": "]", "{": "}" };
  const c = s[i];
  let open, close, dir;
  if (pairs[c]) { open = c; close = pairs[c]; dir = 1; }
  else {
    open = Object.keys(pairs).find((k) => pairs[k] === c);
    if (!open) return -1;
    close = c;
    dir = -1;
  }
  let depth = 0;
  for (let k = i; k >= 0 && k < s.length; k += dir) {
    if (s[k] === close) depth += dir === 1 ? -1 : 1;
    else if (s[k] === open) depth += dir === 1 ? 1 : -1;
    if (depth === 0) return k;
  }
  return -1;
}

function goLineStart(st) { setCursor(st, lineStart(st.text, st.cursor)); st.wanted = -1; }
function goLineEnd(st) {
  setCursor(st, lineEnd(st.text, st.cursor));
  st.wanted = Infinity;
}
function goFirstNonBlank(st) { setCursor(st, firstNonBlank(st.text, st.cursor)); st.wanted = -1; }

function goLine(st, lineNo) {
  const lines = st.text.split("\n");
  const idx = clamp(lines.length - 1, 0, lineNo - 1);
  setCursor(st, lineStartOf(lines, idx));
  st.wanted = -1;
}

/** 垂直移动（j/k）。wanted 列为 -1 时用当前列。返回是否移动。 */
function goVert(st, down, count) {
  const lines = st.text.split("\n");
  let li = 0;
  let off = st.cursor;
  while (li < lines.length - 1 && off > lines[li].length) { off -= lines[li].length + 1; li++; }
  const curCol = st.cursor - lineStart(st.text, st.cursor);
  const wantCol = st.wanted === -1 ? curCol : st.wanted === Infinity ? lines[li].length : st.wanted;
  const to = clamp(lines.length - 1, 0, li + (down ? count : -count));
  if (to === li) return false;
  setCursor(st, lineStartOf(lines, to) + clamp(lines[to].length, 0, wantCol));
  st.wanted = wantCol;
  return true;
}

// ---------------------------------------------------------------- 文本对象

/** iw/aw（含 W 变体）。返回 [start, end)；无词返回 null。 */
function wordObject(s, i, inner, big) {
  const n = s.length;
  if (n === 0) return null;
  if (isSpace(s[i])) {
    let a = i;
    let b = i;
    while (a > 0 && isSpace(s[a - 1])) a--;
    while (b + 1 < n && isSpace(s[b + 1])) b++;
    if (!inner) {
      // 外含：空白 + 后随词（无后随词则含前词）
      if (b + 1 < n) {
        const cls = clsOf(s[b + 1], big);
        let k = b + 1;
        while (k + 1 < n && !isSpace(s[k + 1]) && clsOf(s[k + 1], big) === cls) k++;
        b = k;
      } else if (a > 0) {
        const cls = clsOf(s[a - 1], big);
        let k = a - 1;
        while (k > 0 && !isSpace(s[k - 1]) && clsOf(s[k - 1], big) === cls) k--;
        a = k;
      }
    }
    return [a, b + 1];
  }
  const cls = clsOf(s[i], big);
  let a = i;
  let b = i;
  while (a > 0 && !isSpace(s[a - 1]) && clsOf(s[a - 1], big) === cls) a--;
  while (b + 1 < n && !isSpace(s[b + 1]) && clsOf(s[b + 1], big) === cls) b++;
  if (!inner) {
    // 外含：词 + 后随空白；无后随空白则含前导空白
    let k = b + 1;
    while (k < n && isSpace(s[k]) && s[k] !== "\n") k++;
    if (k > b + 1) b = k - 1;
    else {
      let m = a;
      while (m > 0 && isSpace(s[m - 1])) m--;
      a = m;
    }
  }
  return [a, b + 1];
}

/** 引号/括号对象（i"/a(、di{、ciw 等）。返回 [start, end)；找不到返回 null。 */
function aroundObject(s, i, q, inner) {
  const openFor = { "(": "(", "[": "[", "{": "{", "<": "<", b: "(", B: "{" };
  const closeFor = { "(": ")", "[": "]", "{": "}", "<": ">", b: ")", B: "}" };
  const revOpenFor = { ")": "(", "]": "[", "}": "{", ">": "<" };
  let open;
  let close;
  if (openFor[q]) { open = openFor[q]; close = closeFor[q]; }
  else if (revOpenFor[q]) { open = revOpenFor[q]; close = q; }
  else {
    // 引号对象：找包含光标的成对引号（光标前的引号数为偶 → 开引号）
    let a = -1;
    for (let k = Math.min(i, s.length - 1); k >= 0; k--) {
      if (s[k] !== q) continue;
      let cnt = 0;
      for (let m = 0; m < k; m++) if (s[m] === q) cnt++;
      if (cnt % 2 === 0) { a = k; break; }
    }
    if (a < 0) return null;
    const b = s.indexOf(q, a + 1);
    if (b === -1 || b < i) return null;
    return inner ? [a + 1, b] : [a, b + 1];
  }
  // 括号对象：光标在括号上 → 以它为一端；在括号内 → 由近及远找包含它的最外候选
  let a = -1;
  let b = -1;
  for (let start = s[i] === open ? i : s.lastIndexOf(open, i); start >= 0; start = s.lastIndexOf(open, start - 1)) {
    let depth = 0;
    let bFound = -1;
    for (let k = start; k < s.length; k++) {
      if (s[k] === open) depth++;
      else if (s[k] === close) { depth--; if (depth === 0) { bFound = k; break; } }
    }
    if (bFound >= i && (bFound > i || s[i] === close)) { a = start; b = bFound; break; }
  }
  if (a < 0 || b < 0 || b <= a) return null;
  return inner ? [a + 1, b] : [a, b + 1];
}

// ---------------------------------------------------------------- 编辑操作

function deleteRange(st, a, b) {
  if (b <= a) return false;
  pushUndo(st);
  st.register = st.text.slice(a, b);
  st.regLinewise = false;
  st.text = st.text.slice(0, a) + st.text.slice(b);
  setCursor(st, a);
  return true;
}

function deleteLines(st, fromLine, count) {
  const lines = st.text.split("\n");
  const a = clamp(lines.length - 1, 0, fromLine);
  const b = clamp(lines.length, a + 1, fromLine + count);
  if (b <= a) return false;
  pushUndo(st);
  st.register = lines.slice(a, b).join("\n");
  st.regLinewise = true;
  const keep = [...lines.slice(0, a), ...lines.slice(b)];
  st.text = keep.join("\n");
  setCursor(st, lineStartOf(keep, Math.min(a, Math.max(0, keep.length - 1))));
  return true;
}

function yankRange(st, a, b) {
  if (b <= a) return false;
  st.register = st.text.slice(a, b);
  st.regLinewise = false;
  return true;
}

function yankLines(st, fromLine, count) {
  const lines = st.text.split("\n");
  const a = clamp(lines.length - 1, 0, fromLine);
  const b = clamp(lines.length, a + 1, fromLine + count);
  if (b <= a) return false;
  st.register = lines.slice(a, b).join("\n");
  st.regLinewise = true;
  return true;
}

function enterInsertAt(st, at) {
  // 内部版：不推撤销快照（调用方已在动作前推过）
  setCursor(st, at);
  st.mode = INSERT;
  st.remapBuf = "";
}

function enterInsertSession(st, at) {
  // i/I/a/A 进入插入：整段插入算一次撤销
  pushUndo(st);
  enterInsertAt(st, at);
}

/** p/P 粘贴（照上游 ue()：linewise 按行拼入，charwise 重复 count 次）。 */
function paste(st, after, count) {
  if (!st.register) return false;
  pushUndo(st);
  const rep = Math.max(1, count);
  if (st.regLinewise) {
    const ins = [];
    const seg = st.register.split("\n");
    for (let i = 0; i < rep; i++) ins.push(...seg);
    const lines = st.text.split("\n");
    const at = clamp(lines.length, 0, lineIndexAt(st.text, st.cursor) + (after ? 1 : 0));
    lines.splice(at, 0, ...ins);
    st.text = lines.join("\n");
    setCursor(st, lineStartOf(lines, at));
  } else {
    const seg = st.register.repeat(rep);
    const at = after ? Math.min(st.text.length, st.cursor + (st.text.length ? 1 : 0)) : st.cursor;
    st.text = st.text.slice(0, at) + seg + st.text.slice(at);
    setCursor(st, at);
  }
  return true;
}

/** ~/大小写（照上游 ve()：逐字形，遇行尾停止；VISUAL 内作用于选区）。 */
function toggleCase(st, a, b) {
  if (b <= a) return false;
  pushUndo(st);
  let out = st.text.slice(0, a);
  for (const ch of st.text.slice(a, b)) {
    out += ch === ch.toUpperCase() ? ch.toLowerCase() : ch.toUpperCase();
  }
  out += st.text.slice(b);
  st.text = out;
  return true;
}

function changeCase(st, a, b, toUpper) {
  if (b <= a) return false;
  pushUndo(st);
  const seg = st.text.slice(a, b);
  st.text = st.text.slice(0, a) + (toUpper ? seg.toUpperCase() : seg.toLowerCase()) + st.text.slice(b);
  return true;
}

/** r 替换（照上游 Re()：跨行尾即整体不动）。 */
function replaceChars(st, ch, count) {
  const e = lineEnd(st.text, st.cursor);
  if (st.cursor + count > e) return false;
  pushUndo(st);
  st.text = st.text.slice(0, st.cursor) + ch.repeat(count) + st.text.slice(st.cursor + count);
  setCursor(st, st.cursor + count - 1);
  return true;
}

// ---------------------------------------------------------------- 键名

function keyName(ch, key = {}) {
  if (key.escape) return "esc";
  if (key.return || key.enter) return "enter";
  if (key.backspace) return "backspace";
  if (key.delete) return "delete";
  if (key.leftArrow) return "left";
  if (key.rightArrow) return "right";
  if (key.upArrow) return "up";
  if (key.downArrow) return "down";
  if (key.tab) return "tab";
  if (key.ctrl) return ch ? `ctrl+${ch}` : "ctrl";
  if (typeof ch === "string" && ch.length) return ch;
  return null;
}

const isToken = (k) => TOKENS.has(k) || k.startsWith("ctrl+");
const countOf = (st) => {
  if (!st.count) return 1;
  const n = parseInt(st.count, 10);
  return Number.isFinite(n) && n > 0 ? Math.min(n, COUNT_MAX) : 1;
};
const clearPending = (st) => {
  st.count = "";
  st.opCount = 0;
  st.op = null;
  st.pending = null;
};

// ---------------------------------------------------------------- 运动分派

/** 无操作符的纯运动（NORMAL/VISUAL 共用）。返回是否识别该键。rawCount 为原始数字缓冲（可区分 1G 与 G）。 */
function applyMotion(st, k, count, rawCount = null) {
  const s = st.text;
  switch (k) {
    case "h": case "\b": case "left": {
      setCursor(st, clamp(lineEnd(s, st.cursor), lineStart(s, st.cursor), st.cursor - count));
      st.wanted = -1;
      return true;
    }
    case "l": case " ": case "right": {
      setCursor(st, clamp(lineEnd(s, st.cursor), st.cursor, st.cursor + count));
      st.wanted = -1;
      return true;
    }
    case "0": goLineStart(st); return true;
    case "^": goFirstNonBlank(st); return true;
    case "$": goLineEnd(st); return true;
    case "w": case "W": {
      let j = st.cursor;
      for (let n = 0; n < count; n++) j = nextHead(s, j, k === "W");
      setCursor(st, j);
      st.wanted = -1;
      return true;
    }
    case "b": case "B": {
      let j = st.cursor;
      for (let n = 0; n < count; n++) j = prevHead(s, j, k === "B");
      setCursor(st, j);
      st.wanted = -1;
      return true;
    }
    case "e": case "E": {
      let j = st.cursor;
      for (let n = 0; n < count; n++) j = wordEnd(s, j, k === "E");
      setCursor(st, j);
      st.wanted = -1;
      return true;
    }
    case "%": {
      if (count === 1) {
        const m = matchBracket(s, st.cursor);
        if (m >= 0) setCursor(st, m);
      }
      return true;
    }
    case "j": case "down": goVert(st, true, count); return true;
    case "k": case "up": goVert(st, false, count); return true;
    case "G": {
      const lines = s.split("\n");
      goLine(st, rawCount != null && rawCount !== "" ? parseInt(rawCount, 10) : lines.length);
      return true;
    }
    default: return false;
  }
}

const MOTION_KEYS = new Set(["h", "l", " ", "\b", "left", "right", "0", "^", "$", "w", "W", "b", "B", "e", "E", "%", "j", "k", "up", "down", "G"]);

/**
 * operator 上下文把运动键解析为 [a,b) 范围。
 * 返回 "find" | "lines" | "linesTo" | [a,b] | null。
 * 端点语义照上游 He="eE$%" 集：e/E/% 包含端点；$ 的落点本就是行尾后一位。
 */
function motionRange(st, k, count) {
  const s = st.text;
  const cur = st.cursor;
  const ls = lineStart(s, cur);
  const le = lineEnd(s, cur);
  switch (k) {
    case "h": case "\b": return [clamp(le, ls, cur - count), cur];
    case "l": case " ": return [cur, clamp(le, cur, cur + count)];
    case "0": return [ls, cur];
    case "^": return [firstNonBlank(s, cur), cur];
    case "$": return [cur, le];
    case "w": case "W": {
      let j = cur;
      for (let n = 0; n < count; n++) j = nextHead(s, j, k === "W");
      return [cur, j];
    }
    case "b": case "B": {
      let j = cur;
      for (let n = 0; n < count; n++) j = prevHead(s, j, k === "B");
      return [j, cur];
    }
    case "e": case "E": {
      let j = cur;
      for (let n = 0; n < count; n++) j = wordEnd(s, j, k === "E");
      return [cur, Math.min(le, j + 1)];
    }
    case "%": {
      const m = count === 1 ? matchBracket(s, cur) : -1;
      return m === -1 ? null : [Math.min(cur, m), Math.max(cur, m) + 1];
    }
    case "f": case "F": case "t": case "T": return "find";
    case "j": case "k": return "lines";
    case "G": return "linesTo";
    default: return null;
  }
}

/** 插入进入位置 —— 照上游 Qe()。 */
function insertEntry(st, key) {
  const s = st.text;
  const cur = st.cursor;
  switch (key) {
    case "i": return cur;
    case "I": return firstNonBlank(s, cur);
    // 上游：a 在文末或落在空格上 → 原位；否则右移一位
    case "a": return cur >= s.length || s[cur] === " " || s[cur] === "\t" ? cur : cur + 1;
    case "A": return lineEnd(s, cur);
    default: return cur;
  }
}

function runOpLinewise(st, op, fromLine, count) {
  if (op === "d") return deleteLines(st, fromLine, count);
  if (op === "y") return yankLines(st, fromLine, count);
  if (op === "c") {
    const lines = st.text.split("\n");
    const a = clamp(lines.length - 1, 0, fromLine);
    const b = clamp(lines.length, a + 1, fromLine + count);
    pushUndo(st);
    st.register = lines.slice(a, b).join("\n");
    st.regLinewise = true;
    const keep = [...lines.slice(0, a), "", ...lines.slice(b)];
    st.text = keep.join("\n");
    setCursor(st, lineStartOf(keep, a));
    enterInsertAt(st, st.cursor);
    return true;
  }
  return false;
}

/** 执行操作符于 [a,b) 或行区间。范围相等时照上游 q()：y 清寄存器 / c 进插入 / d 不动。 */
function runOpRange(st, op, a, b) {
  if (b <= a) {
    if (op === "y") st.register = "";
    else if (op === "c") enterInsertAt(st, st.cursor);
    return op === "c";
  }
  if (op === "d") return deleteRange(st, a, b);
  if (op === "y") {
    const ok = yankRange(st, a, b);
    if (ok) setCursor(st, a);
    return ok;
  }
  if (op === "c") {
    pushUndo(st);
    st.register = st.text.slice(a, b);
    st.regLinewise = false;
    st.text = st.text.slice(0, a) + st.text.slice(b);
    enterInsertAt(st, a);
    return true;
  }
  return false;
}

// ---------------------------------------------------------------- NORMAL

const MOTION_SET = new Set(["h", "l", " ", "\b", "left", "right", "0", "^", "$", "w", "W", "b", "B", "e", "E", "%", "j", "k", "up", "down", "G"]);

function normalKey(st, k, now) {
  const s = st.text;

  // ---- pending：find / replace / 文本对象 / g（计数可继续累积，取用后清）
  if (st.pending) {
    const p = st.pending;
    if (p.type !== "replace" && (/^[1-9]$/.test(k) || (k === "0" && st.count))) {
      st.count += k;
      return true;
    }
    if (p.type === "find") {
      const cnt = (st.opCount || 1) * countOf(st);
      const op = st.op;
      clearPending(st);
      if (k.length === 1 && !isToken(k)) {
        st.lastFind = { type: p.data, char: k };
        const pos = findInLine(s, st.cursor, p.data, k, cnt);
        if (pos >= 0) {
          if (op) {
            // df 含找到的字符；dt 不含（findInLine 已对 t/T 偏移，两式同形）
            const cur = st.cursor;
            const a = p.data === "f" || p.data === "t" ? cur : pos;
            const b = p.data === "f" || p.data === "t" ? pos + 1 : cur;
            runOpRange(st, op, Math.min(a, b), Math.max(a, b));
          } else {
            setCursor(st, pos);
          }
        }
      }
      return true;
    }
    if (p.type === "replace") {
      const cnt = (st.opCount || 1) * countOf(st);
      clearPending(st);
      if (k.length === 1 && !isToken(k)) replaceChars(st, k, cnt);
      return true;
    }
    if (p.type === "g") {
      const cnt = (st.opCount || 1) * countOf(st);
      const op = st.op; // 先取再清（clearPending 会置空）
      clearPending(st);
      if (k === "g") {
        if (op) runOpLinewise(st, op, 0, lineIndexAt(st.text, st.cursor) + 1); // dgg：删到首行（含当前行）
        else goLine(st, cnt);
      } else if ((k === "j" || k === "k") && !op) {
        goVert(st, k === "j", cnt);
      }
      return true;
    }
    if (p.type === "obj") {
      const op = st.op || "d";
      clearPending(st);
      if (k.length === 1 && !isToken(k)) {
        const inner = p.data === "i";
        const obj = (k === "w" || k === "W")
          ? wordObject(s, st.cursor, inner, k === "W")
          : aroundObject(s, st.cursor, k, inner);
        if (obj) runOpRange(st, op, obj[0], obj[1]);
        else if (op === "c") enterInsertAt(st, st.cursor);
      }
      return true;
    }
    clearPending(st);
    return true;
  }

  // ---- 操作符已按：等运动 / dd / 文本对象 scope
  if (st.op) {
    if (/^[1-9]$/.test(k) || (k === "0" && st.count)) { st.count += k; return true; }
    const cnt = Math.max(1, (st.opCount || 1)) * countOf(st);
    if (k === st.op) { // dd / cc / yy
      const li = lineIndexAt(s, st.cursor);
      const op = st.op;
      clearPending(st);
      runOpLinewise(st, op, li, cnt);
      return true;
    }
    if (k === "i" || k === "a") { // 文本对象 scope（op 已按，"a" 不是插入）
      st.pending = { type: "obj", data: k };
      return true;
    }
    if (k === "f" || k === "F" || k === "t" || k === "T") {
      st.pending = { type: "find", data: k };
      return true;
    }
    if (k === "g") { // dgg / dcc? 上游 operatorG 状态
      st.pending = { type: "g" };
      return true;
    }
    if (MOTION_SET.has(k)) {
      const op = st.op;
      const li = lineIndexAt(s, st.cursor);
      const r = motionRange(st, k, cnt);
      clearPending(st);
      if (Array.isArray(r)) {
        // cw/cW 特例：change + w 在非空白上删到词尾（照上游 cn() 的 change+w 特判）
        if (op === "c" && (k === "w" || k === "W") && !isSpace(s[st.cursor])) {
          const end = wordEnd(s, st.cursor, k === "W");
          runOpRange(st, "c", st.cursor, Math.min(lineEnd(s, st.cursor), end + 1));
        } else {
          runOpRange(st, op, Math.min(r[0], r[1]), Math.max(r[0], r[1]));
        }
      } else if (r === "lines") { // dj / dk —— 行级
        const from = k === "k" ? Math.max(0, li - cnt) : li;
        runOpLinewise(st, op, from, cnt + 1);
      } else if (r === "linesTo") { // dG / dgg / d3G
        const lines = s.split("\n");
        const to = k === "G" ? (cnt > 1 ? Math.min(lines.length - 1, cnt - 1) : lines.length - 1) : 0;
        runOpLinewise(st, op, Math.min(li, to), Math.abs(to - li) + 1);
      }
      // r === null → 清空待定，不动
      return true;
    }
    clearPending(st);
    return true;
  }

  // ---- 计数缓冲
  if (/^[1-9]$/.test(k)) { st.count += k; return true; }
  if (k === "0" && st.count) { st.count += "0"; return true; }

  // ---- 纯运动（无操作符）
  if (MOTION_KEYS.has(k)) {
    const cnt = countOf(st);
    const raw = st.count;
    st.count = "";
    applyMotion(st, k, cnt, raw);
    return true;
  }
  if (k === "f" || k === "F" || k === "t" || k === "T") {
    st.pending = { type: "find", data: k };
    return true;
  }

  // ---- 即时动作（照上游 mn 表；消费计数的动作取用后清空）
  switch (k) {
    case "d": case "c": case "y":
      st.opCount = countOf(st);
      st.count = "";
      st.op = k;
      return true;
    case "x": {
      const cnt = countOf(st);
      st.count = "";
      const le = lineEnd(s, st.cursor);
      const end = Math.min(le, st.cursor + cnt);
      if (end > st.cursor) {
        pushUndo(st);
        st.register = s.slice(st.cursor, end);
        st.regLinewise = false;
        st.text = s.slice(0, st.cursor) + s.slice(end);
        setCursor(st, st.cursor);
      }
      return true;
    }
    case "s": {
      const cnt = countOf(st);
      st.count = "";
      const le = lineEnd(s, st.cursor);
      const end = Math.min(le, st.cursor + cnt);
      pushUndo(st);
      if (end > st.cursor) {
        st.register = s.slice(st.cursor, end);
        st.regLinewise = false;
        st.text = s.slice(0, st.cursor) + s.slice(end);
      }
      enterInsertAt(st, st.cursor);
      return true;
    }
    case "S": {
      const cnt = countOf(st);
      st.count = "";
      runOpLinewise(st, "c", lineIndexAt(s, st.cursor), cnt);
      return true;
    }
    case "D": {
      st.count = "";
      const le = lineEnd(s, st.cursor);
      if (le > st.cursor) deleteRange(st, st.cursor, le);
      return true;
    }
    case "C": {
      st.count = "";
      const le = lineEnd(s, st.cursor);
      pushUndo(st);
      if (le > st.cursor) {
        st.register = s.slice(st.cursor, le);
        st.regLinewise = false;
        st.text = s.slice(0, st.cursor) + s.slice(le);
      }
      enterInsertAt(st, st.cursor);
      return true;
    }
    case "Y": {
      st.count = "";
      yankLines(st, lineIndexAt(s, st.cursor), 1);
      return true;
    }
    case "p": { const c = countOf(st); st.count = ""; paste(st, true, c); return true; }
    case "P": { const c = countOf(st); st.count = ""; paste(st, false, c); return true; }
    case "r": st.pending = { type: "replace" }; return true;
    case "~": {
      const cnt = countOf(st);
      st.count = "";
      const le = lineEnd(s, st.cursor);
      const end = Math.min(le, st.cursor + cnt);
      toggleCase(st, st.cursor, end);
      setCursor(st, clamp(le, st.cursor, st.cursor + Math.max(1, cnt) - 1));
      return true;
    }
    case "u": {
      const snap = st.undo.pop();
      if (snap) {
        st.text = snap.text;
        st.cursor = clamp(snap.text.length, 0, snap.cursor);
      }
      return true;
    }
    case "i": case "I": case "a": case "A":
      enterInsertSession(st, insertEntry(st, k));
      return true;
    case "o": case "O": { // 上游 le()：下方/上方开新行
      const ls = lineStart(s, st.cursor);
      const le = lineEnd(s, st.cursor);
      pushUndo(st);
      const at = k === "o" ? le : ls;
      st.text = s.slice(0, at) + "\n" + s.slice(at);
      setCursor(st, at + 1);
      enterInsertAt(st, st.cursor);
      return true;
    }
    case "J": { // 上游 Je()/Ot()：合并行，行首空白剥离、")" 前不加空格
      const lines = s.split("\n");
      const li = lineIndexAt(s, st.cursor);
      const cnt = countOf(st);
      st.count = "";
      const n = Math.min(Math.max(cnt, 2) - 1, lines.length - li - 1);
      if (n <= 0) {
        if (cnt >= 3) setCursor(st, lineEnd(s, st.cursor)); // 上游：末行 J 仅光标到行尾
        return true;
      }
      pushUndo(st);
      let acc = lines[li];
      for (let i = 1; i <= n; i++) {
        const stripped = lines[li + i].replace(/^[ \t\r]+/, "");
        if (stripped.length > 0 && acc.length > 0 && !stripped.startsWith(")") && !/[ \t]$/.test(acc)) acc += " ";
        acc += stripped;
      }
      lines.splice(li, n + 1, acc);
      st.text = lines.join("\n");
      setCursor(st, lineStartOf(lines, li) + acc.length);
      return true;
    }
    case "v": case "V":
      st.mode = k === "v" ? VISUAL : VLINE;
      st.kind = k;
      st.anchor = st.cursor;
      return true;
    case ";": case ",": { // 上游 Fe()：重复上次 find（, 反向）
      const cnt = countOf(st);
      st.count = "";
      if (!st.lastFind) return true;
      let type = st.lastFind.type;
      if (k === ",") type = { f: "F", F: "f", t: "T", T: "t" }[type];
      const pos = findInLine(s, st.cursor, type, st.lastFind.char, cnt);
      if (pos >= 0) setCursor(st, pos);
      return true;
    }
    case "g": st.pending = { type: "g" }; return true;
    case "esc": {
      // 上游页脚 "double tap esc to clear input"
      if (now - st.lastEsc < 1000) {
        if (st.text) {
          pushUndo(st);
          st.text = "";
          setCursor(st, 0);
        }
        st.lastEsc = 0;
      } else {
        st.lastEsc = now;
      }
      return true;
    }
    default:
      // 未收录的键（含上游 mn 表也没有的 X）→ 落回 idle，不动
      clearPending(st);
      return true;
  }
}

// ---------------------------------------------------------------- INSERT

function insertChars(st, chars) {
  st.text = st.text.slice(0, st.cursor) + chars + st.text.slice(st.cursor);
  setCursor(st, st.cursor + chars.length);
}

/**
 * 插入模式 remap：上游键恰好 2 字符 → 缓 1 字符等下一键。
 * 返回 ""（已缓冲，本键不插入）、"<Esc>"（触发退出）、否则原样键。
 */
function remapConsume(st, k) {
  const map = st.insertRemap;
  if (!map || !map.size) return k;
  if (k.length !== 1 || isToken(k)) {
    if (st.remapBuf) {
      const buf = st.remapBuf;
      st.remapBuf = "";
      insertChars(st, buf);
    }
    return k;
  }
  const pair = st.remapBuf + k;
  if (st.remapBuf && map.has(pair)) {
    st.remapBuf = "";
    return "<Esc>";
  }
  const startsNew = [...map.keys()].some((key) => key[0] === k);
  if (st.remapBuf) {
    const buf = st.remapBuf;
    st.remapBuf = "";
    insertChars(st, buf);
  }
  if (startsNew) {
    st.remapBuf = k;
    return "";
  }
  return k;
}

function insertKey(st, k) {
  const mk = remapConsume(st, k);
  if (mk === "") return true;
  if (mk === "<Esc>") {
    st.mode = NORMAL;
    setCursor(st, Math.max(0, st.cursor - 1)); // esc 语义：光标左移一位
    return true;
  }
  const key = mk;

  switch (key) {
    case "esc": {
      if (st.remapBuf) {
        const buf = st.remapBuf;
        st.remapBuf = "";
        insertChars(st, buf);
      }
      st.mode = NORMAL;
      setCursor(st, Math.max(0, st.cursor - 1));
      return true;
    }
    case "enter": return true; // submit
    case "backspace": {
      if (st.cursor > 0) {
        st.text = st.text.slice(0, st.cursor - 1) + st.text.slice(st.cursor);
        setCursor(st, st.cursor - 1);
      }
      return true;
    }
    case "delete": {
      if (st.cursor < st.text.length) st.text = st.text.slice(0, st.cursor) + st.text.slice(st.cursor + 1);
      return true;
    }
    case "left": setCursor(st, st.cursor - 1); return true;
    case "right": setCursor(st, st.cursor + 1); return true;
    case "up": goVert(st, false, 1); return true;
    case "down": goVert(st, true, 1); return true;
    case "ctrl+a": setCursor(st, firstNonBlank(st.text, st.cursor)); return true;
    case "ctrl+e": setCursor(st, lineEnd(st.text, st.cursor)); return true;
    case "ctrl+b": setCursor(st, Math.max(lineStart(st.text, st.cursor), st.cursor - 1)); return true;
    case "ctrl+f": setCursor(st, Math.min(lineEnd(st.text, st.cursor), st.cursor + 1)); return true;
    case "ctrl+k": { // readline kill-to-end → 寄存器
      const le = lineEnd(st.text, st.cursor);
      if (le > st.cursor) {
        st.register = st.text.slice(st.cursor, le);
        st.regLinewise = false;
        st.text = st.text.slice(0, st.cursor) + st.text.slice(le);
      }
      return true;
    }
    case "ctrl+w": { // readline 删词（空白分隔）
      const ls = lineStart(st.text, st.cursor);
      let j = st.cursor;
      while (j > ls && isSpace(st.text[j - 1])) j--;
      while (j > ls && !isSpace(st.text[j - 1])) j--;
      if (j < st.cursor) {
        st.register = st.text.slice(j, st.cursor);
        st.regLinewise = false;
        st.text = st.text.slice(0, j) + st.text.slice(st.cursor);
        setCursor(st, j);
      }
      return true;
    }
    case "tab": return true; // 忽略
    default: {
      if (!isToken(key)) insertChars(st, key);
      return true;
    }
  }
}

// ---------------------------------------------------------------- VISUAL

/** 渲染用：选中段列表 [start,end)。 */
export function visualSelection(st) {
  if (st.mode !== VISUAL && st.mode !== VLINE) return [];
  if (st.kind === "V") {
    const la = lineIndexAt(st.text, st.anchor);
    const lb = lineIndexAt(st.text, st.cursor);
    const from = Math.min(la, lb);
    const to = Math.max(la, lb);
    const lines = st.text.split("\n");
    const segs = [];
    for (let li = from; li <= Math.min(to, lines.length - 1); li++) {
      const a = lineStartOf(lines, li);
      segs.push([a, a + lines[li].length]);
    }
    return segs;
  }
  const a = Math.min(st.anchor, st.cursor);
  const b = Math.min(st.text.length, Math.max(st.anchor, st.cursor) + 1); // 含光标字符
  return a < b ? [[a, b]] : [];
}

function visualKey(st, k) {
  const s = st.text;
  // 动作表 wn（上游 VISUAL 动作）
  switch (k) {
    case "esc": st.mode = NORMAL; return true;
    case "v": case "V": {
      if (st.kind === k) st.mode = NORMAL;
      else { st.kind = k; st.mode = k === "v" ? VISUAL : VLINE; }
      return true;
    }
    case "o": { // 交换两端
      const t = st.anchor;
      st.anchor = st.cursor;
      st.cursor = t;
      return true;
    }
    case "u": case "U": case "~": {
      if (st.kind === "V") {
        const la = lineIndexAt(s, st.anchor);
        const lb = lineIndexAt(s, st.cursor);
        const lines = s.split("\n");
        for (let li = Math.min(la, lb); li <= Math.max(la, lb); li++) {
          const a = lineStartOf(lines, li);
          const b = a + lines[li].length;
          if (k === "u") changeCase(st, a, b, false);
          else if (k === "U") changeCase(st, a, b, true);
          else toggleCase(st, a, b);
        }
      } else {
        const a = Math.min(st.anchor, st.cursor);
        const b = Math.max(st.anchor, st.cursor) + 1;
        if (k === "u") changeCase(st, a, b, false);
        else if (k === "U") changeCase(st, a, b, true);
        else toggleCase(st, a, b);
      }
      st.mode = NORMAL;
      return true;
    }
    case "d": case "x": {
      if (st.kind === "V") {
        const la = lineIndexAt(s, st.anchor);
        const lb = lineIndexAt(s, st.cursor);
        deleteLines(st, Math.min(la, lb), Math.abs(la - lb) + 1);
      } else {
        const a = Math.min(st.anchor, st.cursor);
        const b = Math.max(st.anchor, st.cursor) + 1;
        deleteRange(st, a, b);
      }
      st.mode = NORMAL;
      return true;
    }
    case "y": case "Y": {
      if (st.kind === "V") {
        const la = lineIndexAt(s, st.anchor);
        const lb = lineIndexAt(s, st.cursor);
        yankLines(st, Math.min(la, lb), Math.abs(la - lb) + 1);
      } else {
        const a = Math.min(st.anchor, st.cursor);
        const b = Math.max(st.anchor, st.cursor) + 1;
        yankRange(st, a, b);
        setCursor(st, a);
      }
      st.mode = NORMAL;
      return true;
    }
    case "c": case "s": {
      pushUndo(st);
      if (st.kind === "V") {
        const la = lineIndexAt(s, st.anchor);
        const lb = lineIndexAt(s, st.cursor);
        const lines = s.split("\n");
        const a = Math.min(la, lb);
        const b = Math.max(la, lb);
        st.register = lines.slice(a, b + 1).join("\n");
        st.regLinewise = true;
        const keep = [...lines.slice(0, a), "", ...lines.slice(b + 1)];
        st.text = keep.join("\n");
        setCursor(st, lineStartOf(keep, a));
      } else {
        const a = Math.min(st.anchor, st.cursor);
        const b = Math.max(st.anchor, st.cursor) + 1;
        st.register = s.slice(a, b);
        st.regLinewise = false;
        st.text = s.slice(0, a) + s.slice(b);
        setCursor(st, a);
      }
      enterInsertAt(st, st.cursor);
      return true;
    }
    case "r": st.pending = { type: "vreplace" }; return true;
    case "p": case "P": { // 用寄存器替换选区
      if (!st.register) { st.mode = NORMAL; return true; }
      pushUndo(st);
      if (st.kind === "V") {
        const la = lineIndexAt(s, st.anchor);
        const lb = lineIndexAt(s, st.cursor);
        const lines = s.split("\n");
        const a = Math.min(la, lb);
        const b = Math.max(la, lb);
        const ins = [];
        for (let i = 0; i < Math.max(1, countOf(st)); i++) ins.push(...st.register.split("\n"));
        lines.splice(a, b - a + 1, ...ins);
        st.text = lines.join("\n");
        setCursor(st, lineStartOf(lines, a));
      } else {
        const a = Math.min(st.anchor, st.cursor);
        const b = Math.max(st.anchor, st.cursor) + 1;
        st.text = s.slice(0, a) + st.register + s.slice(b);
        setCursor(st, a);
      }
      st.mode = NORMAL;
      return true;
    }
    default: {
      if (/^[1-9]$/.test(k) || (k === "0" && st.count)) { st.count += k; return true; }
      if (MOTION_KEYS.has(k)) {
        const cnt = countOf(st);
        const raw = st.count;
        st.count = "";
        applyMotion(st, k, cnt, raw);
        return true;
      }
      if (k === "f" || k === "F" || k === "t" || k === "T") { st.pending = { type: "find", data: k }; return true; }
      if (k === "g") { st.pending = { type: "g" }; return true; }
      return true;
    }
  }
}

// ---------------------------------------------------------------- 顶层

/**
 * 处理一个按键。返回 { submit, changed }。
 * @param now 可注入的时钟（毫秒），用于 double-esc 测试；默认 Date.now()。
 */
export function vimApply(st, ch, key, now = Date.now()) {
  const before = st.text;
  const r = { submit: false, changed: false };
  const k = keyName(ch, key);

  if (!k) return r;

  if (st.mode === INSERT) {
    if (k === "enter") { r.submit = true; return r; }
    insertKey(st, k);
  } else if (st.mode === VISUAL || st.mode === VLINE) {
    if (st.pending && st.pending.type === "vreplace") {
      st.pending = null;
      st.count = "";
      if (k.length === 1 && !isToken(k)) {
        if (st.kind === "V") {
          const la = lineIndexAt(st.text, st.anchor);
          const lb = lineIndexAt(st.text, st.cursor);
          const lines = st.text.split("\n");
          pushUndo(st);
          for (let li = Math.min(la, lb); li <= Math.max(la, lb); li++) {
            lines[li] = k.repeat(lines[li].length); // Vr：整行每个字符替换
          }
          st.text = lines.join("\n");
        } else {
          const a = Math.min(st.anchor, st.cursor);
          const b = Math.max(st.anchor, st.cursor) + 1;
          pushUndo(st);
          st.text = st.text.slice(0, a) + k.repeat(b - a) + st.text.slice(b);
          setCursor(st, a);
        }
      }
      st.mode = NORMAL;
    } else if (st.pending && st.pending.type === "find") {
      const p = st.pending;
      st.pending = null;
      if (k.length === 1 && !isToken(k)) {
        st.lastFind = { type: p.data, char: k };
        const pos = findInLine(st.text, st.cursor, p.data, k, countOf(st));
        st.count = "";
        if (pos >= 0) setCursor(st, pos);
      }
    } else if (st.pending && st.pending.type === "g") {
      st.pending = null;
      if (k === "g") goLine(st, countOf(st));
      st.count = "";
    } else if (k === "enter") {
      r.submit = true;
      return r;
    } else {
      visualKey(st, k);
    }
  } else {
    if (k === "enter") { r.submit = true; return r; }
    normalKey(st, k, now);
  }

  r.changed = st.text !== before;
  return r;
}

/** pending 状态的显示标签（showcmd）。 */
export function vimPendingLabel(st) {
  const parts = [];
  if (st.opCount > 1) parts.push(String(st.opCount));
  if (st.count) parts.push(st.count);
  if (st.op) parts.push(st.op);
  if (st.pending?.type === "find") parts.push(st.pending.data || "f");
  if (st.pending?.type === "replace") parts.push("r");
  if (st.pending?.type === "g") parts.push("g");
  if (st.pending?.type === "obj") parts.push(st.pending.data);
  if (st.pending?.type === "vreplace") parts.push("r");
  return parts.join("");
}

export const MODE_LABELS = { [INSERT]: "-- INSERT --", [VISUAL]: "-- VISUAL --", [VLINE]: "-- VISUAL LINE --" };
