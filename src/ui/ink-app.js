import React, { useState, useEffect, useCallback, useRef } from "react";
import { Box, Text, useApp, useInput } from "ink";
import TextInput from "ink-text-input";
import Spinner from "ink-spinner";

const h = React.createElement;

const CLAUDE = "#d97757";
// /theme：light 主题用深橙强调色（浅底终端上 #d97757 对比不足）；dark/auto 保持品牌橙。
function accentColor(config) {
  return config && config.theme === "light" ? "#9a4a2e" : CLAUDE;
}
import { VERSION } from "../version.js";
import {
  vimEnabled, createVimSession, vimApply, resetVimSession, vimClear,
  normalizeInsertRemaps, visualSelection, vimPendingLabel, MODE_LABELS,
  NORMAL, INSERT,
} from "./vim.js";

function ToolArgs({ args, max = 3, width = 72 }) {
  const parts = [];
  for (const [k, v] of Object.entries(args || {})) {
    if (v == null) continue;
    let s = typeof v === "string" ? v : JSON.stringify(v);
    s = s.replace(/\n/g, "\\n");
    if (s.length > width) s = s.slice(0, width - 3) + "...";
    parts.push(`${k}: ${s}`);
    if (parts.length >= max) break;
  }
  return h(Text, { color: "gray" }, `(${parts.join(", ")})`);
}

function Clawd() {
  return h(
    Box,
    { flexDirection: "column", marginTop: 1 },
    h(Text, { color: CLAUDE }, "   ██████████"),
    h(Text, { color: CLAUDE }, "  ██  ██  ████"),
    h(Text, { color: CLAUDE }, "  ████████████"),
    h(Text, { color: CLAUDE }, "   ██ ████ ██")
  );
}

function Welcome({ config }) {
  return h(
    Box,
    { flexDirection: "column" },
    h(Clawd),
    h(
      Box,
      { marginTop: 1 },
      h(Text, { color: accentColor(config), bold: true }, "Welcome to MyClaude "),
      h(Text, { color: "gray" }, `v${VERSION}`)
    ),
    h(Text, { color: "gray", dimColor: true }, `model ${config.model} · mode ${config.permissionMode} · ${process.cwd()}`),
    h(Text, { color: "gray", dimColor: true }, "/help for commands, ? for shortcuts")
  );
}

const TODO_ICON = { pending: "☐", in_progress: "▶", completed: "☑", cancelled: "✗" };

function TodoList({ todos }) {
  if (!todos?.length) return null;
  const done = todos.filter((t) => t.status === "completed").length;
  return h(
    Box,
    { flexDirection: "column", marginY: 1 },
    h(Text, { color: "gray", dimColor: true }, `Todos (${done}/${todos.length})`),
    ...todos.map((t, i) =>
      h(
        Box,
        { key: i, paddingLeft: 1 },
        h(
          Text,
          { color: t.status === "completed" ? "gray" : t.status === "in_progress" ? CLAUDE : "gray", dimColor: t.status === "completed" },
          `${TODO_ICON[t.status]} `
        ),
        h(
          Text,
          { dimColor: t.status === "completed", strikethrough: t.status === "cancelled" },
          t.content
        )
      )
    )
  );
}

/**
 * Tool call rendered Claude-style:
 *   ● Name(args)
 *     ⎿  output line 1
 *     ⎿  output line 2
 */
function ToolItem({ item, expanded }) {
  const running = item.status === "running";
  const ok = item.status === "ok";
  const lines = String(item.output || "").split("\n").filter((l) => l.length);
  const shown = expanded ? lines.slice(0, 40) : lines.slice(0, 3);

  return h(
    Box,
    { flexDirection: "column" },
    h(
      Box,
      null,
      running
        ? h(Box, { marginRight: 1 }, h(Spinner, { type: "dots" }))
        : h(Text, { color: ok ? CLAUDE : "red" }, ok ? "● " : "× "),
      h(Text, { bold: !running, dimColor: running }, item.name),
      h(ToolArgs, { args: item.args }),
      !running && item.elapsed != null ? h(Text, { color: "gray" }, `  ${item.elapsed}ms`) : null
    ),
    shown.length
      ? h(
          Box,
          { flexDirection: "column", paddingLeft: 2 },
          ...shown.map((l, i) =>
            h(Text, { key: i, color: "gray", dimColor: true }, `⎿  ${l.length > 160 ? l.slice(0, 157) + "..." : l}`)
          ),
          lines.length > shown.length
            ? h(Text, { color: "gray", dimColor: true }, `⎿  … +${lines.length - shown.length} lines (ctrl+o)`)
            : null
        )
      : null
  );
}

function Item({ item, expanded }) {
  switch (item.type) {
    case "user":
      return h(
        Box,
        { marginTop: 1 },
        h(Text, { color: CLAUDE, bold: true }, "> "),
        h(Text, null, item.text)
      );
    case "assistant":
      return h(Box, null, h(Text, null, item.text));
    case "tool":
      return h(ToolItem, { item, expanded });
    case "error":
      return h(Text, { color: "red" }, item.text);
    case "warn":
      return h(Text, { color: "yellow" }, item.text);
    case "success":
      return h(Text, { color: CLAUDE }, item.text);
    case "info":
      return h(Text, { color: "gray", dimColor: true }, item.text);
    default:
      return h(Text, null, String(item.text ?? ""));
  }
}

function StatusLine({ config, busy, stats }) {
  const mode = config.permissionMode;
  const modeColor = mode === "auto" ? accentColor(config) : mode === "plan" ? "yellow" : "gray";
  return h(
    Box,
    null,
    h(Text, { color: "gray", dimColor: true }, "  "),
    h(Text, { color: "gray" }, config.model),
    h(Text, { color: "gray", dimColor: true }, "  ·  "),
    h(Text, { color: modeColor }, mode),
    h(Text, { color: "gray", dimColor: true }, "  ·  "),
    h(Text, { color: "gray" }, config.provider),
    vimEnabled(config) ? h(Text, { color: "magenta", dimColor: true }, "  ·  vim") : null,
    config.theme && config.theme !== "dark" ? h(Text, { color: "gray", dimColor: true }, `  ·  ${config.theme}`) : null,
    stats?.turns ? h(Text, { color: "gray", dimColor: true }, `  ·  turn ${stats.turns}`) : null,
    stats?.messages ? h(Text, { color: "gray", dimColor: true }, `  ·  ${stats.messages} msg`) : null,
    busy ? h(Text, { color: "yellow" }, "  ·  working…") : null,
    h(Text, { color: "gray", dimColor: true }, "  ·  ? for shortcuts")
  );
}

const SHORTCUTS = [
  ["Enter", "send message"],
  ["Shift+Enter", "newline (via ctrl+j too)"],
  ["↑ / ↓", "history"],
  ["ctrl+o", "expand/collapse all tool output"],
  ["ctrl+l", "clear screen"],
  ["ctrl+c", "interrupt / exit"],
  ["ctrl+u", "clear input line"],
  ["?", "this help"],
  ["/attach <path>", "attach files to the next message"],
  ["/help", "command list"],
];

function HelpPanel() {
  return h(
    Box,
    { flexDirection: "column", borderStyle: "round", borderColor: "gray", paddingX: 1, marginTop: 1 },
    h(Text, { bold: true, color: CLAUDE }, "Keyboard shortcuts"),
    ...SHORTCUTS.map(([k, d]) =>
      h(
        Box,
        { key: k },
        h(Box, { width: 18 }, h(Text, { color: "gray" }, k)),
        h(Text, { color: "gray", dimColor: true }, d)
      )
    )
  );
}

function QuestionPanel({ pending, answer, setAnswer, onSubmit }) {
  const q = pending.questions[pending.index] || pending.questions[0];
  const opts = q.options || [];
  const multi = q.multi_select;
  const selected = answer.selections || [];

  return h(
    Box,
    { flexDirection: "column", borderStyle: "round", borderColor: CLAUDE, paddingX: 1, marginTop: 1 },
    h(
      Box,
      null,
      h(Text, { bold: true, color: CLAUDE }, `${pending.questions.length > 1 ? `Q${pending.index + 1}/${pending.questions.length} · ` : ""}${q.header}`),
      h(Text, { color: "gray", dimColor: true }, "  esc to skip")
    ),
    h(Box, { marginBottom: 1 }, h(Text, null, q.question)),
    ...opts.map((o, i) => {
      const picked = selected.includes(o.label);
      return h(
        Box,
        { key: i },
        h(Text, { color: picked ? CLAUDE : "gray" }, `${picked ? "●" : "○"} ${i + 1}. `),
        h(Text, { bold: picked }, o.label),
        h(Text, { color: "gray", dimColor: true }, ` — ${o.description}`)
      );
    }),
    h(
      Box,
      { marginTop: 1 },
      h(Text, { color: "gray", dimColor: true }, multi ? "comma-separated numbers: " : "number (or text): "),
      h(TextInput, {
        value: answer.text || "",
        onChange: (v) => setAnswer({ text: v, selections: [] }),
        onSubmit: (v) => onSubmit(v),
      })
    )
  );
}

function AttachmentBar({ attachments }) {
  if (!attachments?.length) return null;
  return h(
    Box,
    { flexDirection: "column", marginTop: 1 },
    h(Text, { color: "gray", dimColor: true }, `Attachments (${attachments.length}) — sent with the next message, /detach to clear`),
    ...attachments.map((a, i) =>
      h(
        Box,
        { key: i, paddingLeft: 1 },
        h(Text, { color: CLAUDE }, "● "),
        h(Text, null, a.name || a.path || "file"),
        h(Text, { color: "gray", dimColor: true }, `  ${a.kind || "file"}${a.size ? ` · ${Math.max(1, Math.round(a.size / 1024))}KB` : ""}`)
      )
    )
  );
}

/**
 * vim 模式下的输入缓冲渲染：NORMAL/VISUAL 反色块光标，VISUAL 反色选区，
 * 模式指示照上游（INSERT/VISUAL 显示、NORMAL 隐藏 —— statusLine.hideVimModeIndicator 描述）。
 */
function VimInputView({ text, view, busy }) {
  const { cursor, mode, pending, sel } = view;
  const marks = new Array(text.length).fill(null);
  if (sel && sel.length) {
    for (const [a, b] of sel) for (let i = a; i < b && i < text.length; i++) marks[i] = "sel";
  } else if (cursor >= 0 && cursor < text.length) {
    marks[cursor] = "cursor";
  }
  const pieces = [];
  let buf = "";
  let curMark = marks[0] || null;
  const flush = () => {
    if (!buf) return;
    pieces.push(h(Text, { key: pieces.length, inverse: curMark != null }, buf));
    buf = "";
  };
  for (let i = 0; i < text.length; i++) {
    const m = marks[i] || null;
    if (m !== curMark) { flush(); curMark = m; }
    buf += text[i];
  }
  flush();
  if (cursor >= text.length) pieces.push(h(Text, { key: "eol", inverse: true }, " "));

  return h(
    Box,
    { flexDirection: "column" },
    h(
      Box,
      null,
      h(Text, { color: CLAUDE, bold: true }, "> "),
      text || pieces.length > 1
        ? h(Text, { wrap: "truncate" }, ...pieces)
        : h(Text, { color: "gray", dimColor: true }, busy ? "working…" : "Ask anything — /help for commands"),
      text ? null : h(Text, { inverse: true }, " ")
    ),
    mode !== NORMAL || pending
      ? h(
          Box,
          null,
          mode !== NORMAL ? h(Text, { color: "magenta", bold: true }, ` ${MODE_LABELS[mode]}`) : null,
          pending ? h(Text, { color: "gray", dimColor: true }, ` ${pending}`) : null
        )
      : null
  );
}

export function App({ bridge, config, onSubmit, onCommand, onExit, getStats, getTodos, onEditMessage, onConfigOpen, onConfigApply }) {
  const { exit } = useApp();
  const [, forceRender] = useState(0);
  const [input, setInput] = useState("");
  const [history, setHistory] = useState([]);
  const [histIdx, setHistIdx] = useState(-1);
  const [expandAll, setExpandAll] = useState(false);
  const [showWelcome, setShowWelcome] = useState(true);
  const [showHelp, setShowHelp] = useState(false);
  const [question, setQuestion] = useState(null);
  const [qAnswer, setQAnswer] = useState({ text: "", selections: [] });
  // vim 编辑模式（上游 editorMode==="vim" / 本项目 vimMode 布尔，见 src/ui/vim.js）
  const vimOn = vimEnabled(config);
  const vimRef = useRef(null);
  const [vimView, setVimView] = useState({ cursor: 0, mode: "INSERT", pending: "", sel: [] });
  // Esc+Esc 编辑上一条消息（上游 parity-targets #1）：双 esc 唤起选择器，
  // 选中后进入编辑模式，Enter 重发（截断其后回合并重跑），Esc 取消。
  const [picker, setPicker] = useState(null); // { list: [{text, itemIdx, depth}], idx }
  const [editing, setEditing] = useState(null); // { depth }
  const escArmRef = useRef(0);

  const openPicker = useCallback(() => {
    if (bridge.state.busy) return;
    const users = [];
    bridge.state.items.forEach((it, i) => {
      if (it.type === "user" && (it.text || "").trim()) { users.push({ text: it.text, itemIdx: i }); }
    });
    if (!users.length) { bridge.info("还没有可编辑的提问"); return; }
    const list = users.slice(-8).reverse().map((u, k) => ({ ...u, depth: k + 1 }));
    setEditing(null);
    setPicker({ list, idx: 0 });
  }, [bridge]);

  // /config 交互面板（上游 /config 的 enum 面板形态）：↑↓ 选行、←→ 循环取值、Esc 关闭。
  // 行数据由 main.js 的 onConfigOpen() 现读现给；应用经 onConfigApply(key, value)。
  const [cfgPanel, setCfgPanel] = useState(null); // { rows: [{key,label,values,valueIdx}], idx }
  const openConfigPanel = useCallback(() => {
    if (bridge.state.busy) return;
    if (typeof onConfigOpen !== "function") return;
    const rows = onConfigOpen();
    if (!rows || !rows.length) return;
    setCfgPanel({ rows, idx: 0 });
  }, [bridge, onConfigOpen]);
  const cfgCycle = useCallback((dir) => {
    setCfgPanel((p) => {
      if (!p) return p;
      const rows = p.rows.map((r, i) => {
        if (i !== p.idx || !r.values || r.values.length < 2) return r;
        const valueIdx = (r.valueIdx + (dir > 0 ? 1 : r.values.length - 1)) % r.values.length;
        const value = r.values[valueIdx];
        if (typeof onConfigApply === "function") { onConfigApply(r.key, value); }
        return { ...r, valueIdx };
      });
      return { ...p, rows };
    });
  }, [onConfigApply]);

  useEffect(() => {
    const unsub = bridge.subscribe(() => forceRender((n) => n + 1));
    return unsub;
  }, [bridge]);

  const state = bridge.state;
  const pending = state.pendingConfirm;
  const todos = getTodos?.() || [];

  const submitQuestion = useCallback(
    (value) => {
      if (!question) return;
      const q = question.questions[question.index];
      const opts = q.options || [];
      const raw = String(value || "").trim();
      let picked = [];
      if (/^\d+(\s*,\s*\d+)*$/.test(raw)) {
        picked = raw
          .split(",")
          .map((s) => Number(s.trim()) - 1)
          .filter((i) => i >= 0 && i < opts.length)
          .map((i) => opts[i].label);
      } else if (/^\d+$/.test(raw)) {
        const i = Number(raw) - 1;
        if (i >= 0 && i < opts.length) picked = [opts[i].label];
      }
      const answerValue = picked.length ? (q.multi_select ? picked : picked[0]) : raw;
      const next = { ...question, answers: [...question.answers, answerValue] };
      if (next.index + 1 < next.questions.length) {
        setQuestion({ ...next, index: next.index + 1 });
        setQAnswer({ text: "", selections: [] });
      } else {
        bridge.resolveQuestions?.(next.answers);
        setQuestion(null);
      }
    },
    [bridge, question]
  );

  useInput((ch, key) => {
    if (pending) {
      if (key.escape) {
        bridge.resolveConfirm(false);
      }
      return;
    }
    if (question) {
      if (key.escape) {
        bridge.resolveQuestions?.(null);
        setQuestion(null);
      }
      return;
    }
    if (picker) {
      if (key.escape) { setPicker(null); return; }
      if (key.upArrow) { setPicker((p) => ({ ...p, idx: Math.max(0, p.idx - 1) })); return; }
      if (key.downArrow) { setPicker((p) => ({ ...p, idx: Math.min(p.list.length - 1, p.idx + 1) })); return; }
      if (key.return) {
        const sel = picker.list[picker.idx];
        setPicker(null);
        setEditing({ depth: sel.depth });
        // 展示区截断：被选提问之后的内容随重发由新回合重建
        bridge.state.items = bridge.state.items.slice(0, sel.itemIdx);
        bridge.emit();
        if (vimRef.current) {
          const st = vimRef.current;
          st.text = sel.text;
          st.cursor = st.text.length;
          st.mode = INSERT;
          st.count = ""; st.op = null; st.pending = null; st.kind = "v"; st.anchor = st.cursor; st.remapBuf = "";
          setVimView({ cursor: st.cursor, mode: st.mode, pending: "", sel: [] });
        }
        setInput(sel.text);
        return;
      }
      return;
    }
    if (cfgPanel) {
      if (key.escape) { setCfgPanel(null); return; }
      if (key.upArrow) { setCfgPanel((p) => ({ ...p, idx: Math.max(0, p.idx - 1) })); return; }
      if (key.downArrow) { setCfgPanel((p) => ({ ...p, idx: Math.min(p.rows.length - 1, p.idx + 1) })); return; }
      if (key.leftArrow) { cfgCycle(-1); return; }
      if (key.rightArrow || key.return) { cfgCycle(1); return; }
      return;
    }
    if (key.ctrl && ch === "c") {
      if (state.busy) bridge.abort?.();
      else {
        onExit?.();
        exit();
      }
      return;
    }
    if (key.ctrl && ch === "l") {
      bridge.state.items = [];
      setShowWelcome(false);
      bridge.emit();
      return;
    }
    if (key.ctrl && ch === "o") {
      setExpandAll((v) => !v);
      return;
    }
    if (editing && key.escape) {
      // 编辑模式 Esc = 取消：恢复空输入，回到原模式
      setEditing(null);
      if (vimRef.current) { vimRef.current.text = ""; vimRef.current.cursor = 0; }
      setInput("");
      return;
    }
    if (vimOn) {
      if (!vimRef.current) {
        vimRef.current = createVimSession({
          text: input,
          cursor: input.length,
          insertRemaps: normalizeInsertRemaps(config.vimInsertModeRemaps),
        });
      }
      const st = vimRef.current;
      // 引擎是唯一事实源；input 状态只是它的渲染镜像。
      const paint = () => {
        setInput(st.text);
        setVimView({ cursor: st.cursor, mode: st.mode, pending: vimPendingLabel(st), sel: visualSelection(st) });
      };
      if (key.upArrow && history.length) {
        const next = histIdx < 0 ? history.length - 1 : Math.max(0, histIdx - 1);
        setHistIdx(next);
        st.text = history[next];
        st.cursor = st.text.length;
        paint();
        return;
      }
      if (key.downArrow && histIdx >= 0) {
        const next = histIdx + 1;
        setHistIdx(next >= history.length ? -1 : next);
        st.text = next >= history.length ? "" : history[next];
        st.cursor = st.text.length;
        paint();
        return;
      }
      if (key.ctrl && ch === "u") {
        vimClear(st);
        paint();
        return;
      }
      if (ch === "?" && !st.text && st.mode === NORMAL) {
        setShowHelp((v) => !v);
        return;
      }
      const r = vimApply(st, ch, key);
      paint();
      // vim NORMAL 且输入为空时，双 esc 打开「编辑上一条消息」选择器；
      // 输入非空时双 esc 仍是上游语义的清空输入。
      if (key.escape) {
        const now = Date.now();
        if (now - escArmRef.current < 1000 && !st.text) {
          escArmRef.current = 0;
          openPicker();
          return;
        }
        escArmRef.current = now;
      }
      if (r.submit) {
        const value = st.text;
        resetVimSession(st, { text: "", cursor: 0 });
        setVimView({ cursor: 0, mode: st.mode, pending: "", sel: [] });
        setInput("");
        handleSubmit(value);
      }
      return;
    }
    if (key.escape) {
      const now = Date.now();
      if (now - escArmRef.current < 1000) {
        escArmRef.current = 0;
        openPicker();
      } else {
        escArmRef.current = now;
      }
      return;
    }
    if (ch === "?" && !input) {
      setShowHelp((v) => !v);
      return;
    }
    if (key.ctrl && ch === "u") {
      setInput("");
      return;
    }
    if (key.upArrow && history.length) {
      const next = histIdx < 0 ? history.length - 1 : Math.max(0, histIdx - 1);
      setHistIdx(next);
      setInput(history[next]);
    } else if (key.downArrow && histIdx >= 0) {
      const next = histIdx + 1;
      if (next >= history.length) {
        setHistIdx(-1);
        setInput("");
      } else {
        setHistIdx(next);
        setInput(history[next]);
      }
    }
  });

  const handleSubmit = useCallback(
    async (value) => {
      const text = value.trim();
      if (!text) return;
      if (editing) {
        // Esc+Esc 编辑重发：截断后的历史由 onEditMessage 回退，文本重跑
        const e = editing;
        setEditing(null);
        setInput("");
        setShowWelcome(false);
        setShowHelp(false);
        await onEditMessage?.(e.depth, text);
        return;
      }
      setHistory((hh) => [...hh, text]);
      setHistIdx(-1);
      setInput("");
      setShowWelcome(false);
      setShowHelp(false);
      if (text === "/config" && typeof onConfigOpen === "function") {
        // 上游 /config 是交互面板（enum 循环），JSON dump 移到 /config raw
        openConfigPanel();
        return;
      }
      if (text.startsWith("/")) await onCommand(text);
      else await onSubmit(text);
    },
    [onCommand, onSubmit, editing, onEditMessage, onConfigOpen, openConfigPanel]
  );

  const visible = state.items.slice(-80);
  const lastToolId = [...state.items].reverse().find((i) => i.type === "tool")?.id;
  const empty = !visible.length && !state.streaming;

  return h(
    Box,
    { flexDirection: "column" },
    h(
      Box,
      { flexDirection: "column", paddingX: 1 },
      showWelcome && empty ? h(Welcome, { config }) : null,
      ...visible.map((it) =>
        h(Item, {
          key: it.id,
          item: it,
          expanded: expandAll || it.id === lastToolId,
        })
      ),
      state.streaming
        ? h(
            Box,
            null,
            h(Text, null, state.streaming),
            h(Box, { marginLeft: 1 }, h(Spinner, { type: "dots" }))
          )
        : null,
      h(TodoList, { todos })
    ),
    h(AttachmentBar, { attachments: state.attachments }),
    pending
      ? h(
          Box,
          { borderStyle: "round", borderColor: "yellow", paddingX: 1, marginTop: 1, flexDirection: "column" },
          h(Text, { color: "yellow", bold: true }, `Allow ${pending.name}?`),
          h(ToolArgs, { args: pending.args }),
          h(
            Box,
            null,
            h(Text, { color: "gray" }, "[y/N/a] "),
            h(TextInput, {
              value: state.confirmText || "",
              onChange: (v) => bridge.setConfirmText?.(v),
              onSubmit: (v) => {
                const a = v.trim().toLowerCase();
                bridge.resolveConfirm(a === "y" || a === "yes" || a === "a" || a === "always");
              },
            })
          )
        )
      : null,
    question ? h(QuestionPanel, { pending: question, answer: qAnswer, setAnswer: setQAnswer, onSubmit: submitQuestion }) : null,
    showHelp ? h(HelpPanel) : null,
    picker
      ? h(
          Box,
          { borderStyle: "round", borderColor: CLAUDE, paddingX: 1, marginTop: 1, flexDirection: "column" },
          h(Text, { bold: true, color: CLAUDE }, "编辑上一条消息（↑/↓ 选择 · Enter 编辑 · Esc 取消）"),
          ...picker.list.map((it, i) =>
            h(
              Box,
              { key: it.itemIdx },
              h(Text, { color: i === picker.idx ? CLAUDE : "gray" }, `${i === picker.idx ? "❯ " : "  "}${String(picker.list.length - i).padStart(2, "0")} `),
              h(Text, { dimColor: i !== picker.idx }, it.text.length > 70 ? it.text.slice(0, 67) + "..." : it.text)
            )
          )
        )
      : null,
    editing
      ? h(Box, null, h(Text, { color: "magenta" }, `  正在编辑倒数第 ${editing.depth} 条提问 — Enter 重发 · Esc 取消`))
      : null,
    cfgPanel
      ? h(
          Box,
          { borderStyle: "round", borderColor: CLAUDE, paddingX: 1, marginTop: 1, flexDirection: "column" },
          h(Text, { bold: true, color: CLAUDE }, "配置（↑/↓ 选择 · ←/→ 或 Enter 循环取值 · Esc 关闭）"),
          ...cfgPanel.rows.map((r, i) =>
            h(
              Box,
              { key: r.key },
              h(Text, { color: i === cfgPanel.idx ? CLAUDE : "gray" }, `${i === cfgPanel.idx ? "❯ " : "  "}${r.label}：`),
              h(Text, { bold: i === cfgPanel.idx }, String(r.values[r.valueIdx]))
            )
          )
        )
      : null,
    h(
      Box,
      { borderStyle: "round", borderColor: state.busy ? "yellow" : "gray", paddingX: 1, marginTop: 1 },
      vimOn
        ? h(VimInputView, { text: input, view: vimView, busy: state.busy })
        : h(
            Box,
            null,
            h(Text, { color: CLAUDE, bold: true }, "> "),
            h(TextInput, {
              value: input,
              onChange: setInput,
              onSubmit: handleSubmit,
              placeholder: state.busy ? "working…" : "Ask anything — /help for commands",
            })
          )
    ),
    h(StatusLine, { config, busy: state.busy, stats: getStats?.() })
  );
}
