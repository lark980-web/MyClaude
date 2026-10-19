import React, { useState, useEffect, useCallback } from "react";
import { Box, Text, useApp, useInput } from "ink";
import TextInput from "ink-text-input";
import Spinner from "ink-spinner";

const h = React.createElement;

const CLAUDE = "#d97757";
const VERSION = "0.18.0";

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
      h(Text, { color: CLAUDE, bold: true }, "Welcome to MyClaude "),
      h(Text, { color: "gray" }, `v${VERSION}`)
    ),
    h(Text, { color: "gray", dimColor }, `model ${config.model} · mode ${config.permissionMode} · ${process.cwd()}`),
    h(Text, { color: "gray", dimColor }, "/help for commands, ? for shortcuts")
  );
}

const TODO_ICON = { pending: "☐", in_progress: "▶", completed: "☑", cancelled: "✗" };

function TodoList({ todos }) {
  if (!todos?.length) return null;
  const done = todos.filter((t) => t.status === "completed").length;
  return h(
    Box,
    { flexDirection: "column", marginY: 1 },
    h(Text, { color: "gray", dimColor }, `Todos (${done}/${todos.length})`),
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
            h(Text, { key: i, color: "gray", dimColor }, `⎿  ${l.length > 160 ? l.slice(0, 157) + "..." : l}`)
          ),
          lines.length > shown.length
            ? h(Text, { color: "gray", dimColor }, `⎿  … +${lines.length - shown.length} lines (ctrl+o)`)
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
      return h(Text, { color: "gray", dimColor }, item.text);
    default:
      return h(Text, null, String(item.text ?? ""));
  }
}

function StatusLine({ config, busy, stats }) {
  const mode = config.permissionMode;
  const modeColor = mode === "auto" ? CLAUDE : mode === "plan" ? "yellow" : "gray";
  return h(
    Box,
    null,
    h(Text, { color: "gray", dimColor }, "  "),
    h(Text, { color: "gray" }, config.model),
    h(Text, { color: "gray", dimColor }, "  ·  "),
    h(Text, { color: modeColor }, mode),
    h(Text, { color: "gray", dimColor }, "  ·  "),
    h(Text, { color: "gray" }, config.provider),
    stats?.turns ? h(Text, { color: "gray", dimColor }, `  ·  turn ${stats.turns}`) : null,
    stats?.messages ? h(Text, { color: "gray", dimColor }, `  ·  ${stats.messages} msg`) : null,
    busy ? h(Text, { color: "yellow" }, "  ·  working…") : null,
    h(Text, { color: "gray", dimColor }, "  ·  ? for shortcuts")
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
        h(Text, { color: "gray", dimColor }, d)
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
      h(Text, { color: "gray", dimColor }, "  esc to skip")
    ),
    h(Box, { marginBottom: 1 }, h(Text, null, q.question)),
    ...opts.map((o, i) => {
      const picked = selected.includes(o.label);
      return h(
        Box,
        { key: i },
        h(Text, { color: picked ? CLAUDE : "gray" }, `${picked ? "●" : "○"} ${i + 1}. `),
        h(Text, { bold: picked }, o.label),
        h(Text, { color: "gray", dimColor }, ` — ${o.description}`)
      );
    }),
    h(
      Box,
      { marginTop: 1 },
      h(Text, { color: "gray", dimColor }, multi ? "comma-separated numbers: " : "number (or text): "),
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
    h(Text, { color: "gray", dimColor }, `Attachments (${attachments.length}) — sent with the next message, /detach to clear`),
    ...attachments.map((a, i) =>
      h(
        Box,
        { key: i, paddingLeft: 1 },
        h(Text, { color: CLAUDE }, "● "),
        h(Text, null, a.name || a.path || "file"),
        h(Text, { color: "gray", dimColor }, `  ${a.kind || "file"}${a.size ? ` · ${Math.max(1, Math.round(a.size / 1024))}KB` : ""}`)
      )
    )
  );
}

export function App({ bridge, config, onSubmit, onCommand, onExit, getStats, getTodos }) {
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
    if (ch === "?" && !input) {
      setShowHelp((v) => !v);
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
      setHistory((hh) => [...hh, text]);
      setHistIdx(-1);
      setInput("");
      setShowWelcome(false);
      setShowHelp(false);
      if (text.startsWith("/")) await onCommand(text);
      else await onSubmit(text);
    },
    [onCommand, onSubmit]
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
    h(
      Box,
      { borderStyle: "round", borderColor: state.busy ? "yellow" : "gray", paddingX: 1, marginTop: 1 },
      h(Text, { color: CLAUDE, bold: true }, "> "),
      h(TextInput, {
        value: input,
        onChange: setInput,
        onSubmit: handleSubmit,
        placeholder: state.busy ? "working…" : "Ask anything — /help for commands",
      })
    ),
    h(StatusLine, { config, busy: state.busy, stats: getStats?.() })
  );
}
