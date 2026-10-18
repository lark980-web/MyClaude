let nextId = 1;
const uid = () => `i${nextId++}`;

export class TuiBridge {
  constructor({ config } = {}) {
    this.config = config;
    this.state = {
      items: [],
      streaming: "",
      busy: false,
      pendingConfirm: null,
      confirmText: "",
      pendingQuestions: null,
      status: "",
      turn: 0,
      attachments: [],
    };
    this.listeners = new Set();
    this.confirmResolver = null;
    this.questionResolver = null;
  }

  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit() {
    for (const fn of this.listeners) fn();
  }

  setState(patch) {
    this.state = { ...this.state, ...patch };
    this.emit();
  }

  push(item) {
    this.state.items = [...this.state.items, { id: uid(), ...item }];
    this.emit();
    return this.state.items[this.state.items.length - 1];
  }

  patchItem(id, patch) {
    this.state.items = this.state.items.map((it) => (it.id === id ? { ...it, ...patch } : it));
    this.emit();
  }

  user(text) {
    this.push({ type: "user", text });
  }

  /** Show pending attachments above the composer (CLI /attach command). */
  setAttachments(list) {
    this.setState({ attachments: [...list] });
  }

  setMode(mode) {
    if (this.config) this.config.permissionMode = mode;
    this.emit();
  }

  streamText(chunk) {
    this.state.streaming += chunk;
    this.emit();
  }

  endStream() {
    const text = this.state.streaming;
    if (text.trim()) {
      this.push({ type: "assistant", text });
    }
    this.state.streaming = "";
    this.emit();
  }

  info(text) {
    this.endStream();
    this.push({ type: "info", text });
  }

  warn(text) {
    this.endStream();
    this.push({ type: "warn", text });
  }

  error(text) {
    this.endStream();
    this.push({ type: "error", text });
  }

  success(text) {
    this.endStream();
    this.push({ type: "success", text });
  }

  toolStart(name, args) {
    this.endStream();
    const item = this.push({ type: "tool", name, args, status: "running", elapsed: 0, output: "" });
    return item.id;
  }

  toolEnd(name, ok, elapsed, content) {
    const items = this.state.items;
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i];
      if (it.type === "tool" && it.name === name && it.status === "running") {
        this.patchItem(it.id, { status: ok ? "ok" : "fail", elapsed, output: String(content || "") });
        return;
      }
    }
  }

  confirmTool(name, args) {
    this.endStream();
    return new Promise((resolve) => {
      this.confirmResolver = resolve;
      this.setState({ pendingConfirm: { name, args, id: uid() }, confirmText: "" });
    });
  }

  resolveConfirm(answer) {
    const r = this.confirmResolver;
    this.confirmResolver = null;
    this.setState({ pendingConfirm: null, confirmText: "" });
    r?.(answer);
  }

  setConfirmText(text) {
    this.state.confirmText = text;
    this.emit();
  }

  /** AskUserQuestion support: returns answers array or null when dismissed. */
  askQuestions(questions) {
    this.endStream();
    return new Promise((resolve) => {
      this.questionResolver = resolve;
      this.setState({
        pendingQuestions: { questions, index: 0, answers: [] },
      });
    });
  }

  resolveQuestions(answers) {
    const r = this.questionResolver;
    this.questionResolver = null;
    this.setState({ pendingQuestions: null });
    r?.(answers);
  }

  setBusy(busy) {
    this.setState({ busy });
  }

  setStatus(status) {
    this.setState({ status });
  }
}
