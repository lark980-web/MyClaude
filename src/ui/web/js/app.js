/* =============================================================================
   app.js — MyClaude Web GUI（中文界面）
   原生 ES，无构建步骤。结构：状态 → 工具 → 传输 → 渲染 → 输入区 → 面板。
   ========================================================================== */
(function () {
  "use strict";

  var MD = window.MyClaudeMarkdown || {
    render: function (s) { return String(s == null ? "" : s); },
    toText: function (s) { return String(s == null ? "" : s); },
    parseUnifiedDiff: function () { return []; }
  };
  /** Diff parser shared with the markdown bundle. */
  var parseUnifiedDiff = MD.parseUnifiedDiff;

  /* ================================================================ 状态 === */

  var S = {
    sessionKey: null,
    config: null,
    sessions: [],
    attachments: [],
    busy: false,
    vision: true,
    theme: "dark",
    motion: true,
    todos: [],
    stats: { messages: 0, turns: 0, tokens: 0, inputTokens: 0, outputTokens: 0, contextLimit: 0, contextUsed: 0 },
    routing: null,
    toolsExpanded: false,
    lastUserText: "",
    autoScroll: true,
    history: [],
    histIdx: -1
  };

  var LS_THEME = "myclaude.theme";
  var LS_MOTION = "myclaude.motion";
  var LS_SESSION = "myclaude.session";
  var LS_NAME = "myclaude.name";
  var LS_RAIL = "myclaude.rail";
  var LS_INSP = "myclaude.inspector";

  /* ================================================================ 工具 === */

  function $(id) { return document.getElementById(id); }

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) { n.className = cls; }
    if (text != null) { n.textContent = text; }
    return n;
  }
  function clear(node) {
    while (node && node.firstChild) { node.removeChild(node.firstChild); }
  }

  function bytes(n) {
    if (!n) { return "0 B"; }
    if (n < 1024) { return n + " B"; }
    if (n < 1048576) { return (n / 1024).toFixed(1) + " KB"; }
    return (n / 1048576).toFixed(1) + " MB";
  }

  function timeAgo(iso) {
    if (!iso) { return ""; }
    var t = Date.parse(iso);
    if (isNaN(t)) { return ""; }
    var d = Math.max(0, Date.now() - t) / 1000;
    if (d < 60) { return "刚刚"; }
    if (d < 3600) { return Math.floor(d / 60) + " 分钟前"; }
    if (d < 86400) { return Math.floor(d / 3600) + " 小时前"; }
    if (d < 604800) { return Math.floor(d / 86400) + " 天前"; }
    var dt = new Date(t);
    return dt.getFullYear() + "-" + String(dt.getMonth() + 1).padStart(2, "0") + "-" + String(dt.getDate()).padStart(2, "0");
  }

  function timeOf(iso) {
    if (!iso) { return ""; }
    var d = new Date(iso);
    return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
  }


  function toast(text, kind) {
    var wrap = $("toasts");
    if (!wrap) { return; }
    var t = el("div", "toast " + (kind || ""), text);
    wrap.appendChild(t);
    setTimeout(function () {
      t.style.opacity = "0";
      t.style.transition = "opacity .2s";
      setTimeout(function () { if (t.parentNode) { t.parentNode.removeChild(t); } }, 220);
    }, 3200);
  }

  function copyText(text) {
    var s = String(text || "");
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(s).then(function () { toast("已复制", "ok"); });
      return;
    }
    var ta = document.createElement("textarea");
    ta.value = s;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand("copy"); toast("已复制", "ok"); } catch (e) { }
    document.body.removeChild(ta);
  }

  /* ================================================================ 传输 === */

  function getJSON(url, opts) {
    return fetch(url, Object.assign({ headers: { Accept: "application/json" } }, opts || {})).then(function (r) {
      if (!r.ok) { throw new Error("HTTP " + r.status); }
      return r.json();
    });
  }

  function postJSON(url, body) {
    return fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {})
    }).then(function (r) {
      if (!r.ok) { throw new Error("HTTP " + r.status); }
      return r.json();
    });
  }

  function patchJSON(url, body) {
    return fetch(url, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {})
    }).then(function (r) {
      if (!r.ok) { throw new Error("HTTP " + r.status); }
      return r.json();
    });
  }

  function delJSON(url) {
    return fetch(url, { method: "DELETE" }).then(function (r) {
      if (!r.ok) { throw new Error("HTTP " + r.status); }
      return r.json().catch(function () { return {}; });
    });
  }

  function streamChat(payload, handlers) {
    return fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    }).then(function (res) {
      if (!res.ok || !res.body) {
        return res.text().then(function (t) {
          throw new Error("HTTP " + res.status + ": " + String(t).slice(0, 300));
        });
      }
      var reader = res.body.getReader();
      var dec = new TextDecoder();
      var buf = "";
      function pump() {
        return reader.read().then(function (r) {
          if (r.done) { if (handlers.onEnd) { handlers.onEnd(); } return; }
          buf += dec.decode(r.value, { stream: true });
          var idx;
          while ((idx = buf.indexOf("\n")) >= 0) {
            var line = buf.slice(0, idx).trim();
            buf = buf.slice(idx + 1);
            if (line.indexOf("data:") !== 0) { continue; }
            var raw = line.slice(5).trim();
            if (!raw || raw === "[DONE]") { continue; }
            var ev;
            try { ev = JSON.parse(raw); } catch (e) { continue; }
            try { handlers.onEvent(ev); } catch (e) { console.error("事件处理失败", e); }
          }
          return pump();
        });
      }
      return pump();
    });
  }

  /* ================================================================ 渲染 === */

  var TOOL_VERB = {
    Read: "读取", Write: "写入", Edit: "编辑", MultiEdit: "编辑",
    Bash: "执行", BashOutput: "读取输出", KillShell: "停止",
    Glob: "搜索", Grep: "搜索", LS: "列出",
    WebFetch: "抓取", WebSearch: "联网搜索",
    Task: "派发子任务", TodoWrite: "更新计划",
    NotebookRead: "读取笔记本", NotebookEdit: "编辑笔记本",
    AskUserQuestion: "询问", ExitPlanMode: "提交方案"
  };

  function toolSummary(name, args) {
    var a = args || {};
    var target = a.file_path || a.notebook_path || a.path || a.pattern || a.url || a.query;
    if (name === "Bash") { target = a.command; }
    if (name === "LS") { target = a.path || "."; }
    if (name === "Grep") { target = (a.pattern || "") + (a.path ? "  在 " + a.path : ""); }
    if (name === "Glob") { target = a.pattern; }
    if (name === "WebSearch") { target = a.query; }
    if (name === "Task") { target = a.description || a.subagent_type || ""; }
    if (name === "TodoWrite") { target = (a.todos || []).length + " 项"; }
    if (name === "GitStatus" || name === "GitDiff" || name === "GitLog" || name === "GitCommit") {
      target = a.paths && a.paths.length ? a.paths.join(", ") : (a.range || "");
    }
    var s = String(target == null ? "" : target).replace(/\s+/g, " ").trim();
    if (s.length > 88) { s = s.slice(0, 85) + "..."; }
    // 名字已经单独显示，这里只给摘要目标；git 工具只有参数时才显示
    return s;
  }

  function argsText(args) {
    try { return JSON.stringify(args || {}, null, 2); } catch (e) { return String(args); }
  }

  function scrollStream(force) {
    var st = $("stream");
    if (!st) { return; }
    if (force) { S.autoScroll = true; }
    if (S.autoScroll) {
      requestAnimationFrame(function () { st.scrollTop = st.scrollHeight; });
    }
    var b = $("btn-to-bottom");
    if (b) { b.hidden = !(st.scrollHeight - st.scrollTop - st.clientHeight > 240); }
  }

  function hideWelcome() {
    var w = $("welcome");
    if (w && w.parentNode) { w.parentNode.removeChild(w); }
    var app = $("app");
    if (app && app.classList.contains("is-empty")) { app.classList.remove("is-empty"); }
  }

  function greetingText() {
    var h = new Date().getHours();
    var g = h < 5 ? "夜深了" : h < 11 ? "早上好" : h < 13 ? "中午好" : h < 18 ? "下午好" : "晚上好";
    var name = userName();
    return name ? g + "，" + name : g;
  }

  function userName() {
    try { var n = localStorage.getItem(LS_NAME); if (n != null) { return n; } } catch (e) { }
    return "Danny";
  }

  function renderProfile() {
    var name = userName();
    var a = $("profile-avatar");
    var n = $("profile-name");
    if (a) { a.textContent = (name || "我").charAt(0).toUpperCase(); }
    if (n) { n.textContent = name || "本地用户"; }
    var sub = $("profile-sub");
    var c = S.config || {};
    if (sub) { sub.textContent = c.cwd ? c.cwd.split(/[\\/]/).filter(Boolean).slice(-1)[0] || c.cwd : "本地工作区"; }
    var g = $("greeting");
    if (g) { g.textContent = greetingText(); }
  }

  function logRoot() { return $("log"); }

  function addUserMessage(text, files) {
    hideWelcome();
    var root = logRoot();
    var wrap = el("div", "msg msg-user");
    if (files && files.length) {
      var row = el("div", "msg-files");
      files.forEach(function (f) {
        var chip = el("div", "chip");
        if (f.preview) {
          var img = document.createElement("img");
          img.src = f.preview;
        } else {
          chip.appendChild(el("span", "chip-ico", "txt"));
        }
        chip.appendChild(el("span", "chip-name", f.name));
        row.appendChild(chip);
      });
      wrap.appendChild(row);
    }
    var bubble = el("div", "bubble");
    bubble.textContent = text;
    wrap.appendChild(bubble);
    var actions = el("div", "msg-actions");
    actions.appendChild(mkMini("编辑重发", function () {
      var ta = $("in");
      if (!ta) { return; }
      ta.value = text;
      autoGrow(ta);
      ta.focus();
    }));
    actions.appendChild(mkMini("复制", function () { copyText(text); }));
    wrap.appendChild(actions);
    root.appendChild(wrap);
    scrollStream(true);
    return wrap;
  }

  function addAssistantMessage() {
    hideWelcome();
    var root = logRoot();
    var wrap = el("div", "msg msg-asst");
    var av = el("div", "avatar");
    av.appendChild(icon("i-spark", 18));
    var content = el("div", "content");
    var body = el("div", "md cursor");
    var actions = el("div", "msg-actions");
    content.appendChild(body);
    content.appendChild(actions);
    wrap.appendChild(av);
    wrap.appendChild(content);
    root.appendChild(wrap);
    scrollStream(true);
    return { wrap: wrap, body: body, actions: actions, raw: "" };
  }

  function renderAssistant(handle, text, streaming) {
    handle.raw = text;
    handle.body.innerHTML = MD.render(text);
    handle.body.className = "md" + (streaming ? " cursor" : " ");
    scrollStream();
  }

  /** 3x3 像素点阵，运行中闪烁。 */
  function makePix() {
    var box = el("span", "pix");
    for (var i = 0; i < 9; i++) { box.appendChild(el("i")); }
    return box;
  }

  /**
   * Render a parsed diff (from GitDiff / Edit) as coloured lines.
   * Each file gets a header with its +/- counts, then hunk-by-hunk lines.
   */
  function renderDiff(host, files) {
    if (!host) { return; }
    clear(host);
    files.forEach(function (f) {
      var head = el("div", "diff-file");
      head.appendChild(el("span", "diff-file-name", f.name || "(unknown)"));
      head.appendChild(el("span", "diff-file-count",
        "+" + (f.added || 0) + " / -" + (f.removed || 0)));
      host.appendChild(head);

      (f.hunks || []).forEach(function (h) {
        var rows = el("div", "diff-hunk");
        if (h.header) { rows.appendChild(el("div", "diff-hunk-head", h.header)); }
        (h.lines || []).forEach(function (line) {
          rows.appendChild(el("div", "diff-line " + (line.type || "ctx"), line.text || " "));
        });
        host.appendChild(rows);
      });
    });
  }

  function addToolCard(name, args) {
    hideWelcome();
    var root = logRoot();
    var box = el("div", "tool running");

    var head = el("button", "tool-head");
    head.type = "button";
    head.appendChild(makePix());
    head.appendChild(el("span", "tool-name", TOOL_VERB[name] || name));
    head.appendChild(el("span", "tool-summary", toolSummary(name, args)));
    var time = el("span", "tool-time", "运行中");
    head.appendChild(time);
    var chev = el("span", "tool-chev");
    chev.appendChild(icon("i-chev", 14));
    head.appendChild(chev);

    var bodyDiv = el("div", "tool-body");
    var secArgs = el("div", "tool-sec");
    secArgs.appendChild(el("div", "tool-sec-label", "参数"));
    var preArgs = el("pre", "code wrap");
    preArgs.textContent = argsText(args);
    secArgs.appendChild(preArgs);
    bodyDiv.appendChild(secArgs);

    var secOut = el("div", "tool-sec");
    secOut.style.display = "none";
    secOut.appendChild(el("div", "tool-sec-label", "输出"));
    var preOut = el("pre", "code wrap");
    var secOutLabel = secOut.firstChild;
    secOut.appendChild(preOut);
    var diffHost = el("div", "diff");
    secOut.appendChild(diffHost);
    bodyDiv.appendChild(secOut);

    head.addEventListener("click", function () { box.classList.toggle("open"); });
    box.appendChild(head);
    box.appendChild(bodyDiv);
    root.appendChild(box);
    scrollStream();
    return { box: box, time: time, secOut: secOut, preOut: preOut, diffHost: diffHost, name: name, args: args };
  }

  function finishToolCard(card, ok, elapsed, output, data) {
      if (!card) { return; }
      card.box.classList.remove("running");
      if (!ok) { card.box.classList.add("failed"); }
      // 运行中的点阵换回状态点
      var pix = card.box.querySelector(".pix");
      if (pix) {
        var dot = el("span", "tool-dot");
        pix.parentNode.replaceChild(dot, pix);
      }
      card.time.textContent = (ok ? "" : "失败 ") + elapsed + "ms";
      var text = String(output == null ? "" : output);
      card.preOut.textContent = text;
      card.secOut.style.display = "";
      // 有结构化 diff 时用着色视图替换纯文本
      if (card.diffHost && data && Array.isArray(data.diff) && data.diff.length) {
        renderDiff(card.diffHost, data.diff);
        card.preOut.style.display = "none";
      }
  }

  var pendingConfirm = null;
  var pendingQuestion = null;

  function showConfirm(ev) {
    pendingConfirm = ev.id;
    hideWelcome();
    var root = logRoot();
    var card = el("div", "ask");
    card.appendChild(el("div", "ask-head", "需要授权"));
    var title = el("div", "ask-title");
    title.appendChild(document.createTextNode("允许执行 "));
    title.appendChild(el("b", null, ev.name));
    title.appendChild(document.createTextNode(" 吗？"));
    card.appendChild(title);
    var pre = el("pre", "ask-args");
    pre.textContent = argsText(ev.args);
    card.appendChild(pre);
    var row = el("div", "ask-row");

    var yes = el("button", "btn primary", "允许");
    var no = el("button", "btn ghost", "拒绝");
    var all = el("button", "btn", "总是允许");

    function settle() {
      clear(row);
      row.appendChild(el("span", "empty-note", "已处理"));
    }

    yes.addEventListener("click", function () { settle(); answerConfirm(true); });
    no.addEventListener("click", function () { settle(); answerConfirm(false); });
    all.addEventListener("click", function () {
      settle();
      postJSON("/api/permissions", { add: { allow: [ev.name] } }).catch(function () {});
      answerConfirm(true);
    });
    row.appendChild(yes);
    row.appendChild(no);
    row.appendChild(all);
    card.appendChild(row);
    root.appendChild(card);
    scrollStream(true);
  }

  function answerConfirm(allow) {
    var id = pendingConfirm;
    pendingConfirm = null;
    postJSON("/api/confirm", { id: id, allow: !!allow }).catch(function () {});
  }

  function showQuestion(ev) {
    pendingQuestion = ev;
    hideWelcome();
    var root = logRoot();
    var card = el("div", "ask");
    var idx = 0;
    var answers = [];

    function draw() {
      clear(card);
      var q = ev.questions[idx];
      var head = ev.questions.length > 1
        ? "问题 " + (idx + 1) + "/" + ev.questions.length + " · " + (q.header || "提问")
        : (q.header || "提问");
      card.appendChild(el("div", "ask-head", head));
      card.appendChild(el("div", "ask-title", q.question));

      var picked = [];
      var opts = el("div", "options");
      (q.options || []).forEach(function (o) {
        var b = el("button", "opt");
        b.type = "button";
        b.appendChild(el("span", "opt-mark", "\u2713"));
        var txt = el("span");
        txt.appendChild(el("div", "opt-label", o.label));
        if (o.description) { txt.appendChild(el("div", "opt-desc", o.description)); }
        b.appendChild(txt);
        b.addEventListener("click", function () {
          if (q.multi_select) {
            var at = picked.indexOf(o.label);
            if (at >= 0) { picked.splice(at, 1); b.classList.remove("picked"); }
          else { picked.push(o.label); b.classList.add("picked"); }
        } else {
          picked = [o.label];
          Array.prototype.forEach.call(opts.children, function (c) { c.classList.remove("picked"); });
          b.classList.add("picked");
        }
      });
        opts.appendChild(b);
      });
      card.appendChild(opts);

      var row = el("div", "ask-row");
      var free = document.createElement("input");
      free.type = "text";
      free.className = "ask-free";
      free.placeholder = "或直接输入回答";
      var ok = el("button", "btn primary", idx + 1 < ev.questions.length ? "下一个" : "提交");
      ok.type = "button";

      function commit() {
        var value = free.value.trim();
        var ans = value || (q.multi_select ? picked : picked[0]);
        answers.push(ans == null ? "" : ans);
        if (idx + 1 < ev.questions.length) { idx = idx + 1; draw(); }
        else { answerQuestion(card, answers); }
      }

      ok.addEventListener("click", commit);
      free.addEventListener("keydown", function (e) {
        if (e.key === "Enter") { e.preventDefault(); commit(); }
      });
      row.appendChild(free);
      row.appendChild(ok);
      card.appendChild(row);
      setTimeout(function () { free.focus(); }, 30);
    }

    root.appendChild(card);
    draw();
    scrollStream(true);
  }

  function answerQuestion(card, answers) {
    var id = pendingQuestion && pendingQuestion.id;
    pendingQuestion = null;
    if (card) {
      clear(card);
      card.appendChild(el("div", "empty-note", answers.join(" · ")));
    }
    postJSON("/api/answer", { id: id, answers: answers }).catch(function () {});
  }

  function addNotice(text, kind) {
    hideWelcome();
    var root = logRoot();
    var box = el("div", "notice " + (kind || "info"));
    box.appendChild(el("span", "notice-ico", kind === "ok" ? "\u2713" : kind === "err" ? "\u00D7" : kind === "warn" ? "!" : "i"));
    box.appendChild(el("span", "notice-text", text));
    root.appendChild(box);
    scrollStream();
    return box;
  }

  /* ============================================================ 输入区 === */

  function icon(id, size) {
    var NS = "http://www.w3.org/2000/svg";
    var svg = document.createElementNS(NS, "svg");
    svg.setAttribute("width", size || 16);
    svg.setAttribute("height", size || 16);
    svg.setAttribute("aria-hidden", "true");
    var use = document.createElementNS(NS, "use");
    use.setAttribute("href", "#" + id);
    svg.appendChild(use);
    return svg;
  }

  var MINI_ICON = { "复制": "i-copy", "重试": "i-retry", "编辑": "i-edit" };

  function mkMini(label, fn) {
    var b = el("button", "mini-btn");
    b.type = "button";
    b.title = label;
    b.setAttribute("aria-label", label);
    if (MINI_ICON[label]) { b.appendChild(icon(MINI_ICON[label], 15)); }
    else { b.textContent = label; }
    b.addEventListener("click", fn);
    return b;
  }

  function addCopyActions(handle) {
    handle.actions.appendChild(mkMini("复制", function () { copyText(handle.raw); }));
    handle.actions.appendChild(mkMini("重试", function () { retryLast(handle); }));
  }

  function flushAssistant(handle, text, streaming) {
    handle.raw = text == null ? handle.raw : text;
    handle.pending = false;
    handle.body.className = "md" + (streaming ? " cursor" : " ");
    handle.body.innerHTML = MD.render(handle.raw);
    scrollStream();
  }

  function addThought(text) {
    hideWelcome();
    var root = logRoot();
    var box = el("div", "thought");
    var head = el("button", "thought-head");
    head.type = "button";
    var tico = el("span", "thought-ico");
    tico.appendChild(icon("i-spark", 14));
    head.appendChild(tico);
    var label = el("span", "thought-label", "思考中");
    head.appendChild(label);
    var tchev = el("span", "thought-chev");
    tchev.appendChild(icon("i-chev", 14));
    head.appendChild(tchev);
    var body = el("div", "thought-body");
    body.textContent = text || "";
    head.addEventListener("click", function () { box.classList.toggle("open"); });
    box.appendChild(head);
    box.appendChild(body);
    root.appendChild(box);
    scrollStream();
    return { box: box, label: label, body: body };
  }

  function renderAttachments() {
    var tray = $("attach-list");
    if (!tray) { return; }
    clear(tray);
    if (!S.attachments.length) { tray.hidden = true; return; }
    tray.hidden = false;
    S.attachments.forEach(function (f, i) {
      var chip = el("div", "chip");
      if (f.preview) {
        var img = document.createElement("img");
        img.src = f.preview;
        chip.appendChild(img);
      } else {
        chip.appendChild(el("span", "chip-ico", "txt"));
      }
      chip.appendChild(el("span", "chip-name", f.name));
      chip.appendChild(el("span", "chip-size", bytes(f.size)));
      var x = el("button", "chip-x", "\u00D7");
      x.type = "button";
      x.title = "移除";
      x.addEventListener("click", function () {
        S.attachments.splice(i, 1);
        renderAttachments();
      });
      chip.appendChild(x);
      tray.appendChild(chip);
    });
  }

  function setBusy(v) {
    S.busy = v;
    var send = $("send");
    var stop = $("btn-stop");
    var stat = $("stat");
    if (send) { send.disabled = v; }
    if (stop) { stop.hidden = !v; }
    if (stat) { stat.textContent = ""; }
    var live = $("live");
    if (!live) {
      live = el("div", "live");
      live.id = "live";
      live.appendChild(icon("i-spark", 22));
      var st = $("stream");
      var log = logRoot();
      if (st && log) { log.parentNode.insertBefore(live, log.nextSibling); }
    }
    live.hidden = !v;
    var app = $("app");
    if (app) { app.classList.toggle("busy", !!v); }
  }

  function autoGrow(ta) {
    ta.style.height = "auto";
    ta.style.height = Math.min(ta.scrollHeight, 200) + "px";
  }

  function stripPreview(f) {
    return { kind: f.kind, name: f.name, mime: f.mime, size: f.size, data: f.data, text: f.text };
  }

  function runTurn(payload) {
    var state = {
      asst: null,
      buffer: "",
      pendingTools: [],
      startedAt: Date.now(),
      thought: null,
      thoughtTimer: null
    }

    setBusy(true);
    state.thought = addThought("");
    state.thoughtTimer = setTimeout(function () {
      if (!state.asst && state.thought) {
        state.thought.label.textContent = "正在思考…";
      }
    }, 600);

    return streamChat(payload, {
      onEvent: function (ev) { handleStreamEvent(ev, state); },
      onEnd: function () { endTurn(state); }
    }).catch(function (e) {
      addNotice("请求失败：" + e.message, "err");
      endTurn(state);
    });
  }

  function endTurn(state) {
    clearTimeout(state.thoughtTimer);
    if (state.thought) {
      state.thought.label.textContent = "已思考 " +
        Math.max(1, Math.round((Date.now() - state.startedAt) / 1000)) + " 秒";
      state.thought = null;
    }
    if (state.asst) {
      flushAssistant(state.asst, state.buffer, false);
      addCopyActions(state.asst);
    }
    setBusy(false);
    refreshStats();
  }

  function handleStreamEvent(ev, state) {
    if (ev.type === "delta") {
      if (!state.asst) {
        if (state.thought) {
          clearTimeout(state.thoughtTimer);
          var secs = Math.max(1, Math.round((Date.now() - state.startedAt) / 1000));
          state.thought.label.textContent = "已思考 " + secs + " 秒";
        }
        state.asst = addAssistantMessage();
      }
      state.buffer += ev.text;
      renderAssistant(state.asst, state.buffer, true);
      return;
    }
    if (ev.type === "assistant_end") {
      if (state.asst) {
        flushAssistant(state.asst, state.buffer, false);
        addCopyActions(state.asst);
      }
      state.asst = null;
      state.buffer = "";
      return;
    }
    if (ev.type === "tool_start") {
      if (state.asst) {
        flushAssistant(state.asst, state.buffer, false);
        addCopyActions(state.asst);
        state.asst = null;
        state.buffer = "";
      }
      state.pendingTools.push(addToolCard(ev.call.name, ev.call.args));
      return;
    }
    if (ev.type === "tool_end") {
      finishToolCard(state.pendingTools.shift(), ev.ok, ev.elapsed, ev.output, ev.data);
      return;
    }
    if (ev.type === "confirm") { showConfirm(ev); return; }
    if (ev.type === "question") { showQuestion(ev); return; }
    if (ev.type === "mode") { setMode(ev.permissionMode); return; }
    if (ev.type === "todos") {
      S.todos = ev.todos || [];
      renderInspector();
      return;
    }
    if (ev.type === "stats") {
      S.stats = {
        messages: ev.messages != null ? ev.messages : S.stats.messages,
        turns: ev.turns != null ? ev.turns : S.stats.turns,
        tokens: ev.tokens || 0,
        inputTokens: ev.inputTokens || 0,
        outputTokens: ev.outputTokens || 0,
        contextLimit: ev.contextLimit || 0,
        contextUsed: ev.contextUsed || 0
      };
      renderTopMeta();
      renderUsage();
      return;
    }
    if (ev.type === "routing") {
      S.routing = ev;
      if (ev.model && S.config) { S.config.model = ev.model; }
      renderTopMeta();
      renderInspector();
      toast("已切换到 " + ev.model, "warn");
      return;
    }
    if (ev.type === "info") { addNotice(ev.text, "info"); return; }
    if (ev.type === "warn") { addNotice(ev.text, "warn"); return; }
    if (ev.type === "error") { addNotice(ev.text, "err"); return; }
    if (ev.type === "success") { addNotice(ev.text, "ok"); return; }
    if (ev.type === "session") {
      if (ev.id) {
        S.sessionKey = ev.id;
        try { localStorage.setItem(LS_SESSION, ev.id); } catch (e) { }
      }
      refreshSessions();
      return;
    }
    if (ev.type === "done") { setBusy(false); }
  }

  function sendMessage() {
    var ta = $("in");
    if (!ta) { return; }
    if (S.busy) { return; }
    var text = (ta.value || "").trim();
    var files = S.attachments.slice();
    if (!text && !files.length) { return; }

    if (text.charAt(0) === "/" && !files.length) {
      ta.value = ""; autoGrow(ta);
      runCommand(text);
      return;
    }

    ta.value = ""; autoGrow(ta);
    S.attachments = []; renderAttachments();
    S.lastUserText = text;
    if (S.history[S.history.length - 1] !== text) { S.history.push(text); }
    S.histIdx = -1;
    addUserMessage(text, files);
    runTurn({ message: text, attachments: files.map(stripPreview), sessionKey: S.sessionKey });
  }

  /** 把一条用户消息放回输入框，用户改完直接发送。 */
  function editAndResend(text) {
    if (S.busy) { toast("请等待当前回复结束", "warn"); return; }
    var ta = $("in");
    if (!ta) { return; }
    ta.value = text;
    autoGrow(ta);
    ta.focus();
    // 光标移到末尾，方便继续输入
    var len = ta.value.length;
    ta.setSelectionRange(len, len);
    toast("已填入输入框，修改后按 Enter 发送", "info");
  }

  function retryLast(handle) {
    if (S.busy) { toast("请等待当前回复结束", "warn"); return; }
    if (!S.lastUserText) { toast("没有可重试的内容", "warn"); return; }
    var root = logRoot();
    var node = handle && handle.wrap;
    while (node && node.classList && !node.classList.contains("msg-user")) {
      var prev = node.previousElementSibling;
      if (node.parentNode === root) { root.removeChild(node); }
      node = prev;
    }
    runTurn({ message: S.lastUserText, retry: true, sessionKey: S.sessionKey });
  }

  function stopGeneration() {
    if (!S.busy) { return; }
    postJSON("/api/abort", { sessionKey: S.sessionKey }).catch(function () {});
  }

  /* ================================================================ 面板 === */

  function setMode(mode) {
    if (S.config) { S.config.permissionMode = mode; }
    renderTopMeta();
    moveModeThumb();
  }

  function moveModeThumb() {
    var seg = $("mode-seg");
    var thumb = $("mode-thumb");
    if (!seg || !thumb) { return; }
    var items = seg.querySelectorAll(".segmented-item");
    var mode = (S.config && S.config.permissionMode) || $("mode-seg").dataset.mode || "ask";
    var idx = 0;
    Array.prototype.forEach.call(items, function (it, i) {
      it.classList.toggle("active", it.getAttribute("data-mode") === mode);
      if (it.getAttribute("data-mode") === mode) { idx = i; }
    });
    var item = items[idx];
    if (!item) { return; }
    // The segmented control only carries the three everyday modes. When the
    // session is in one of the others (set from Settings), hide the thumb
    // instead of parking it under the wrong label.
    var matched = Array.prototype.some.call(items, function (it) {
      return it.getAttribute("data-mode") === mode;
    });
    if (!matched) {
      thumb.style.width = "0px";
      thumb.style.opacity = "0";
      return;
    }
    thumb.style.opacity = "";
    thumb.style.width = item.offsetWidth + "px";
    thumb.style.transform = "translateX(" + (item.offsetLeft - 2) + "px)";
  }

  function renderTopMeta() {
    var c = S.config || {};
    var sub = $("top-sub");
    var bits = [];
    if (c.model) { bits.push(c.model); }
    if (c.permissionMode) { bits.push(modeName(c.permissionMode)); }
    if (sub) { sub.textContent = bits.join(" · "); }
    var title = $("top-title");
    var first = logRoot() && logRoot().querySelector(".msg-user .bubble");
    if (title) {
      var txt = first ? (first.textContent || "").trim().replace(/\s+/g, " ") : "新对话";
      title.textContent = txt.length > 40 ? txt.slice(0, 37) + "…" : txt;
    }
    var wm = $("w-meta");
    if (wm && c.model) { wm.textContent = c.cwd || ""; }
    var ml = $("model-label");
    if (ml) { ml.textContent = c.model || "选择模型"; }

    var tc = $("tool-count");
    if (tc) { tc.textContent = String((c.tools || []).length); }

    renderProfile();
  }

  /** 短标签用于分段器与顶栏；完整说明见设置页。 */
  function modeName(mode) {
    var names = { ask: "询问", acceptEdits: "接受编辑", auto: "自动", dontAsk: "不再提问", plan: "计划", bypassPermissions: "全部放行" };
    return names[mode] || "询问";
  }

  function renderUsage() {
    var host = $("usage");
    if (!host) { return; }
    var used = S.stats.contextUsed || 0;
    var ring = host.querySelector(".usage-ring");
    if (ring) {
      var deg = Math.round(used * 360);
      var tone = used >= 0.9 ? "var(--crit)" : used >= 0.7 ? "var(--warn)" : "var(--accent)";
      ring.style.background = "conic-gradient(" + tone + " " + deg + "deg, var(--line-strong) " + deg + "deg)";
      host.classList.toggle("hot", used >= 0.7);
    }
    var label = host.querySelector(".usage-pct");
    if (label) { label.textContent = Math.round(used * 100) + "%"; }
    host.title = "上下文：" + (S.stats.tokens || 0) + " / " + (S.stats.contextLimit || 0) +
      " tokens" + (S.stats.inputTokens ? "（输入 " + S.stats.inputTokens + " / 输出 " + S.stats.outputTokens + "）" : "");
  }

  function renderVision() {
    var label = $("vision-label");
    var note = $("vision-note");
    if (label) { label.textContent = S.vision ? "视觉开启" : "视觉关闭"; }
    if (note) { note.textContent = S.vision ? "" : "视觉已关闭，图片不会发给模型"; }
    var btn = $("btn-vision");
    if (btn) {
      btn.classList.toggle("off", !S.vision);
      btn.title = S.vision ? "视觉已开启：图片会发送给模型（点击关闭）" : "视觉已关闭：图片不会发送给模型（点击开启）";
    }
  }

  /* ============================================================ 检查器 === */

  function section(title) {
    var sec = el("div", "insp-sec");
    sec.appendChild(el("div", "insp-sec-head", title));
    var body = el("div", "insp-sec-body");
    sec.appendChild(body);
    return { sec: sec, body: body };
  }

  function renderInspector() {
    var body = $("insp-body");
    if (!body) { return; }
    clear(body);
    renderSessionSection(body);
    renderRoutingSection(body);
    renderTodoSection(body);
    renderMcpSection(body);
  }

  function renderSessionSection(root) {
    var c = S.config || {};
    var s = section("会话");
    var dl = el("dl", "kv");
    kv(dl, "模型", c.model || "-", true);
    kv(dl, "模式", modeName(c.permissionMode || "ask"));
    kv(dl, "轮次", String(S.stats.turns || 0));
    kv(dl, "消息", String(S.stats.messages || 0));
    var tok = S.stats.inputTokens || S.stats.outputTokens
      ? (S.stats.inputTokens + " / " + S.stats.outputTokens)
      : (S.stats.tokens ? "≈" + S.stats.tokens : "0");
    kv(dl, "Token", tok, true);
    kv(dl, "目录", c.cwd ? c.cwd.split(/[\\/]/).slice(-1)[0] : "-", true);
    s.body.appendChild(dl);
    root.appendChild(s.sec);
  }

  function renderRoutingSection(root) {
    var c = S.config || {};
    var pool = c.fallbacks || [];
    if (!pool.length && !S.routing) { return; }
    var s = section("备用模型");
    s.body.appendChild(el("div", "empty-note", "限流、超时或 5xx 时自动切换"));
    var active = S.routing && S.routing.model;
    pool.forEach(function (f, i) {
      var row = el("div", "tool-row" + (f.model === active ? " active" : ""));
      row.appendChild(el("b", null, f.model));
      row.appendChild(el("span", null, f.model === active ? "当前" : "待命 " + (i + 1)));
      s.body.appendChild(row);
    });
    if (S.routing && S.routing.switches) {
      s.body.appendChild(el("div", "empty-note", "本会话已切换 " + S.routing.switches + " 次"));
    }
    root.appendChild(s.sec);
  }

  function renderTodoSection(root) {
    var s = section("任务");
    if (!S.todos.length) {
      s.body.appendChild(el("div", "empty-note", "暂无任务列表"));
    } else {
      var done = S.todos.filter(function (t) { return t.status === "completed"; }).length;
      var bar = el("div", "progress");
      var fill = el("i");
      fill.style.width = Math.round((done / S.todos.length) * 100) + "%";
      bar.appendChild(fill);
      s.body.appendChild(bar);
      s.body.appendChild(el("div", "empty-note", done + " / " + S.todos.length + " 已完成"));
      S.todos.forEach(function (t) {
        var row = el("div", "todo" +
          (t.status === "completed" ? " done" : t.status === "in_progress" ? " active" : ""));
        row.appendChild(el("span", "todo-box", "\u2713"));
        row.appendChild(el("span", "todo-text", t.content));
        s.body.appendChild(row);
      });
    }
    root.appendChild(s.sec);
  }

  /** 工具的中文说明；工具名本身是 API 标识符，保持英文。 */
  var TOOL_ZH = {
    Read: "读取文件（带行号，支持偏移与行数限制；图片返回可视附件）",
    Write: "写入文件，自动创建父目录",
    Edit: "精确字符串替换（唯一性校验）",
    MultiEdit: "同一文件多次编辑，全部校验后原子落盘",
    LS: "列出目录内容",
    Glob: "按通配符查找文件（支持 ** 与 *）",
    Grep: "按正则搜索文件内容",
    Bash: "执行 shell 命令（可后台运行）",
    BashOutput: "增量读取后台任务的输出",
    KillShell: "终止后台任务",
    TodoWrite: "创建或更新任务清单",
    WebFetch: "抓取网页并转为可读文本",
    WebSearch: "联网搜索",
    NotebookRead: "读取 Jupyter 笔记本",
    NotebookEdit: "编辑笔记本单元格",
    AskUserQuestion: "向用户提出澄清问题",
    ExitPlanMode: "提交方案等待批准",
    Task: "委派子任务给独立上下文的子代理",
    GitStatus: "查看分支与工作区改动",
    GitDiff: "查看改动差异",
    GitLog: "查看提交历史",
    GitCommit: "暂存并提交改动"
  };

  function toolZh(name, description) {
    if (TOOL_ZH[name]) { return TOOL_ZH[name]; }
    return String(description || "").split(".")[0];
  }



  /** MCP 服务器状态：连接情况与各自暴露的工具数。 */
  function renderMcpSection(root) {
    var s = section("MCP 服务器");
    var host = el("div", "mcp-list");
    s.body.appendChild(host);
    root.appendChild(s.sec);
    getJSON("/api/mcp").then(function (j) {
      var list = j.servers || [];
      clear(host);
      if (!list.length) {
        host.appendChild(el("div", "empty-note", "未配置 MCP 服务器。可在 ~/.myclaude/config.json 的 mcpServers 中添加 command（stdio）或 url（HTTP/SSE）。"));
        return;
      }
      list.forEach(function (sv) {
        var row = el("div", "mcp-row");
        row.appendChild(el("b", null, sv.name));
        var right = el("span", "mcp-right");
        if (sv.error) {
          right.appendChild(el("span", "pill fail", "失败"));
          right.appendChild(el("span", null, String(sv.error).slice(0, 60)));
        } else if (sv.pending) {
          right.appendChild(el("span", "pill run", "待连接"));
          right.appendChild(el("span", null, sv.transport === "stdio" ? "本地进程" : "HTTP"));
        } else {
          var bits = [sv.tools + " 工具"];
          if (sv.prompts) { bits.push(sv.prompts + " 提示词"); }
          if (sv.resources) { bits.push(sv.resources + " 资源"); }
          right.appendChild(el("span", "pill ok", bits.join(" · ")));
        }
        row.appendChild(right);
        host.appendChild(row);
      });
    }).catch(function () {
      clear(host);
      host.appendChild(el("div", "empty-note", "无法读取 MCP 状态"));
    });
  }

  function kv(dl, k, v, mono) {
    var row = el("div", "kv-row");
    row.appendChild(el("dt", null, k));
    row.appendChild(el("dd", mono ? "mono" : null, v));
    dl.appendChild(row);
  }

  /* ============================================================ 会话列表 === */

  function renderChatSkeleton() {
    var list = $("chat-list");
    if (!list) { return; }
    clear(list);
    ["w80", "w60", "w80", "w40"].forEach(function (w) {
      list.appendChild(el("div", "skeleton skeleton-row " + w));
    });
  }

  function renderChatList() {
    var list = $("chat-list");
    if (!list) { return; }
    clear(list);
    var count = $("chat-count");
    if (count) { count.textContent = String(S.sessions.length); }
    if (!S.sessions.length) {
      list.appendChild(el("div", "rail-empty", "暂无历史对话"));
      return;
    }
    S.sessions.slice(0, 30).forEach(function (s) {
      var b = el("button", "chat-row" + (s.id === S.sessionKey ? " active" : ""));
      b.type = "button";
      if (s.pinned) { b.appendChild(el("span", "chat-pin", "\u2605")); }
      b.appendChild(el("span", "chat-title", s.title || s.id));
      b.appendChild(el("span", "chat-meta", timeAgo(s.updatedAt || s.savedAt)));
      var x = el("button", "chat-del", "\u00D7");
      x.type = "button";
      x.title = "删除";
      x.addEventListener("click", function (e) {
        e.stopPropagation();
        deleteSession(s.id);
      });
      b.appendChild(x);
      b.addEventListener("contextmenu", function (e) {
        e.preventDefault();
        openSessionMenu(s, e.clientX, e.clientY);
      });
      b.addEventListener("click", function () { resumeSession(s.id); });
      list.appendChild(b);
    });
  }

  function refreshSessions() {
    return getJSON("/api/sessions").then(function (j) {
      S.sessions = j.sessions || [];
      renderChatList();
    }).catch(function () {});
  }

  function resumeSession(id) {
    if (S.busy) { toast("请等待当前回复结束", "warn"); return; }
    postJSON("/api/session", { action: "resume", id: id }).then(function (j) {
      S.sessionKey = j.id;
      try { localStorage.setItem(LS_SESSION, j.id); } catch (e) { }
      replayTranscript(j.transcript || []);
      refreshSessions();
      refreshStats();
      toast("已恢复 " + j.messages + " 条消息", "ok");
    }).catch(function (e) { toast("恢复失败：" + e.message, "err"); });
  }

  function deleteSession(id) {
    if (!window.confirm("删除这个对话？此操作无法撤销。")) { return; }
    delJSON("/api/sessions/" + encodeURIComponent(id)).then(function () {
      toast("已删除", "ok");
      if (id === S.sessionKey) { newChat(); }
      refreshSessions();
    }).catch(function (e) { toast("删除失败：" + e.message, "err"); });
  }

    /**
   * Rebuild the transcript after resuming a session.
   *
   * Stored messages keep the tool call names and arguments, so tool cards can
   * be restored with their real identity instead of a generic label. Diffs are
   * re-parsed from the raw text so Edit/GitDiff cards render as diffs again.
   */
  function replayTranscript(messages) {
    var root = logRoot();
    Array.prototype.slice.call(root.querySelectorAll(".msg, .tool, .notice, .ask, .thought")).forEach(function (n) {
      if (n.parentNode === root) { root.removeChild(n); }
    });

    var had = false;
    // tool_call_id -> { name, arguments } from the assistant turn that made it.
    var callIndex = {};
    (messages || []).forEach(function (m) {
      if (m.role === "assistant" && Array.isArray(m.tool_calls)) {
        m.tool_calls.forEach(function (tc) {
          var fn = tc.function || {};
          var args = {};
          try { args = JSON.parse(fn.arguments || "{}"); } catch (e) { args = {}; }
          callIndex[tc.id] = { name: fn.name || "Tool", args: args };
        });
      }
    });

    (messages || []).forEach(function (m) {
      if (m.role === "user") {
        var text = typeof m.content === "string" ? m.content : "";
        var imgs = 0;
        if (Array.isArray(m.content)) {
          m.content.forEach(function (p) {
            if (p && p.type === "text") { text += (text ? "\n" : "") + p.text; }
            if (p && p.type === "image_url") { imgs = imgs + 1; }
          });
        }
        if (text.trim() || imgs) {
          addUserMessage(text + (imgs ? "  [" + imgs + " 张图片]" : ""), []);
          had = true;
        }
      } else if (m.role === "assistant" && m.content) {
        var h = addAssistantMessage();
        renderAssistant(h, String(m.content), false);
        addCopyActions(h);
        had = true;
      } else if (m.role === "tool") {
        restoredToolCard(callIndex[m.tool_call_id], String(m.content || ""));
        had = true;
      }
    });

    if (!had) { restoreWelcome(); }
    renderTopMeta();
    scrollStream(true);
  }

  /** Rebuild one tool card from stored text, re-parsing diffs where possible. */
  function restoredToolCard(call, text) {
    var name = call && call.name ? call.name : "工具结果";
    var card = addToolCard(name, call ? call.args : {});
    var diff = /^(diff --git|index [0-9a-f]+\.\.|--- |\+\+\+ )/m.test(text);
    if (diff) {
      var files = parseUnifiedDiff(text);
      if (files.length) {
        finishToolCard(card, true, 0, text, { diff: files });
        return;
      }
    }
    finishToolCard(card, true, 0, text);
  }

  function restoreWelcome() {
    if ($("welcome")) { return; }
    var root = logRoot();
    var sec = el("section", "welcome");
    sec.id = "welcome";
    var h1 = el("h1", "welcome-title");
    var mark = icon("i-spark", 34);
    mark.setAttribute("class", "welcome-mark");
    h1.appendChild(mark);
    var g = el("span", null, greetingText());
    g.id = "greeting";
    h1.appendChild(g);
    sec.appendChild(h1);
    var sub = el("p", "welcome-sub");
    sub.id = "w-meta";
    sec.appendChild(sub);
    root.insertBefore(sec, root.firstChild);
    var app = $("app");
    if (app) { app.classList.add("is-empty"); }
    renderWelcomeCards();
    renderTopMeta();
  }

  function renderWelcomeCards() {
    var host = $("welcome-cards");
    if (!host) { return; }
    clear(host);
    var cards = [
      { i: "i-folder", t: "解释这个项目", d: "梳理架构、入口与主模块关系", p: "给我一个项目总览：架构、关键入口，以及各模块如何协作。" },
      { i: "i-search", t: "定位某段逻辑", d: "找到功能背后的代码并讲解", p: "找出 GUI 服务端路由在哪里定义，并说明一次聊天请求如何流转。" },
      { i: "i-edit", t: "审查我的改动", d: "查找缺陷、边界与缺失测试", p: "审查最近修改的文件，找出缺陷、边界情况和缺失的测试，给出具体行号。" },
      { i: "i-task", t: "补一个测试", d: "为描述的行为增加覆盖", p: "为会话持久化模块补充单元测试，覆盖轮换、裁剪与损坏文件。" }
    ];
    cards.forEach(function (c) {
      var b = el("button", "card");
      b.type = "button";
      b.title = c.d;
      b.appendChild(icon(c.i, 16));
      b.appendChild(el("span", "card-title", c.t));
      b.addEventListener("click", function () {
        var ta = $("in");
        ta.value = c.p;
        autoGrow(ta);
        ta.focus();
      });
      host.appendChild(b);
    });
  }

  function newChat() {
    if (S.busy) { return; }
    postJSON("/api/reset", {}).then(function () {
      S.sessionKey = null;
      S.todos = [];
      S.stats = { messages: 0, turns: 0, tokens: 0, inputTokens: 0, outputTokens: 0, contextLimit: 0, contextUsed: 0 };
      try { localStorage.removeItem(LS_SESSION); } catch (e) { }
      var root = logRoot();
      Array.prototype.slice.call(root.querySelectorAll(".msg, .tool, .notice, .ask, .thought")).forEach(function (n) {
        if (n.parentNode === root) { root.removeChild(n); }
      });
      restoreWelcome();
      renderInspector();
      refreshSessions();
      var ta = $("in");
      if (ta) { ta.focus(); }
    }).catch(function (e) { toast("新建失败：" + e.message, "err"); });
  }

  function refreshStats() {
    getJSON("/api/config").then(function (j) {
      S.config = j;
      S.vision = j.vision !== false;
      S.stats = {
        messages: j.messages != null ? j.messages : S.stats.messages,
        turns: j.turns != null ? j.turns : S.stats.turns,
        tokens: j.tokens || 0,
        inputTokens: j.inputTokens || 0,
        outputTokens: j.outputTokens || 0,
        contextLimit: j.contextLimit || 0,
        contextUsed: j.contextUsed || 0
      };
      if (j.routing) { S.routing = j.routing; }
      renderTopMeta();
      renderVision();
      renderUsage();
      renderInspector();
    }).catch(function () {});
  }

  /* ================================================================ 模态 === */

  function openModal(title, buildBody, footButtons) {
    var m = $("modal");
    var mt = $("modal-title");
    if (mt) { mt.textContent = title; }
    var body = $("modal-body");
    clear(body);
    buildBody(body);
    var foot = $("modal-foot");
    clear(foot);
    foot.hidden = !(footButtons && footButtons.length);
    (footButtons || []).forEach(function (b) {
      var btn = el("button", "btn " + (b.cls || ""), b.label);
      btn.type = "button";
      btn.addEventListener("click", function () { if (b.fn) { b.fn(); } });
      foot.appendChild(btn);
    });
    m.hidden = false;
  }

  function closeModal() {
    var m = $("modal");
    if (m) { m.hidden = true; }
  }

  function field(labelText, input) {
    var f = el("div", "field");
    f.appendChild(el("label", null, labelText));
    f.appendChild(input);
    return f;
  }

  /** 设置页：模型可切换，并附带 provider / 视觉 / 模式。 */
  function openSettings() {
    var c = S.config || {};
    openModal("设置", function (body) {
      var models = [];
      var modelInput = document.createElement("input");
      modelInput.value = c.model || "";
      modelInput.placeholder = "模型名称";
      body.appendChild(field("模型", modelInput));

      var modelHint = el("div", "hint", "输入模型名，或在下方选择已发现的模型。");
      var modelList = el("div", "options");
      body.appendChild(modelHint);
      body.appendChild(modelList);

      getJSON("/api/models").then(function (j) {
        models = j.models || [];
        renderModelList();
      }).catch(function () {
        modelHint.textContent = "未能从服务端获取模型列表，可直接手动输入。";
      });

      function renderModelList() {
        clear(modelList);
        models.slice(0, 12).forEach(function (name) {
          var b = el("button", "opt");
          b.type = "button";
          b.appendChild(el("span", "opt-mark", "\u2713"));
          b.appendChild(el("span", "opt-label", name));
          if (name === c.model) { b.classList.add("picked"); }
          b.addEventListener("click", function () {
            modelInput.value = name;
            Array.prototype.forEach.call(modelList.children, function (x) { x.classList.remove("picked"); });
            b.classList.add("picked");
          });
          modelList.appendChild(b);
        });
      }

      var baseInput = document.createElement("input");
      baseInput.value = c.baseUrl || "";
      baseInput.placeholder = "http://127.0.0.1:8000/v1";
      body.appendChild(field("接口地址", baseInput));

      var keyInput = document.createElement("input");
      keyInput.type = "password";
      keyInput.autocomplete = "off";
      keyInput.value = c.apiKey || "";
      keyInput.placeholder = "API Key";
      body.appendChild(field("密钥", keyInput));

      var nameInput = document.createElement("input");
      nameInput.value = userName();
      nameInput.placeholder = "留空则只显示问候语";
      body.appendChild(field("称呼（用于欢迎语）", nameInput));

      var grid = el("div", "field-row");
      var modeSel = document.createElement("select");
      ((c.modes && c.modes.length ? c.modes : [
        { id: "ask", zh: "询问", desc: "每次写入前确认" },
        { id: "acceptEdits", zh: "接受编辑", desc: "自动批准编辑与常规构建" },
        { id: "auto", zh: "自动", desc: "不再询问任何工具" },
        { id: "dontAsk", zh: "不再提问", desc: "需要确认的一律拒绝" },
        { id: "plan", zh: "计划", desc: "只读，先给方案" },
        { id: "bypassPermissions", zh: "全部放行", desc: "跳过确认，慎用" }
      ]).map(function (o) { return [o.id, o.zh + "：" + o.desc]; })).forEach(function (o) {
        var opt = document.createElement("option");
        opt.value = o[0];
        opt.textContent = o[1];
        if ((c.permissionMode || "ask") === o[0]) { opt.selected = true; }
        modeSel.appendChild(opt);
      });
      grid.appendChild(field("权限模式", modeSel));

      var visWrap = el("label", "switch");
      var vis = document.createElement("input");
      vis.type = "checkbox";
      vis.checked = S.vision;
      visWrap.appendChild(vis);
      visWrap.appendChild(el("span", "switch-label", "视觉（发送图片）"));
      grid.appendChild(field("视觉", visWrap));
      body.appendChild(grid);

      body._save = function () {
        try { localStorage.setItem(LS_NAME, nameInput.value.trim()); } catch (e) { }
        renderProfile();
        var patch = { model: modelInput.value.trim(), permissionMode: modeSel.value, vision: vis.checked };
        if (baseInput.value.trim()) { patch.baseUrl = baseInput.value.trim(); }
        if (keyInput.value.trim()) { patch.apiKey = keyInput.value.trim(); }
        return postJSON("/api/config", patch).then(function (j) {
          S.vision = vis.checked;
          if (S.config) {
            S.config.model = j.model || patch.model;
            S.config.baseUrl = patch.baseUrl || S.config.baseUrl;
            S.config.permissionMode = j.permissionMode || patch.permissionMode;
          }
          renderVision();
          renderTopMeta();
          moveModeThumb();
          renderInspector();
          toast("设置已保存", "ok");
          closeModal();
        }).catch(function (e) { toast("保存失败：" + e.message, "err"); });
      };
    }, [
      { label: "取消", cls: "ghost", fn: closeModal },
      { label: "保存", cls: "primary", fn: function () {
        var b = $("modal-body");
        if (b && b._save) { b._save(); }
      } }
    ]);
  }

  function openTools() {
    var tools = (S.config && S.config.tools) || [];
    openModal("工具（" + tools.length + "）", function (body) {
      if (!tools.length) { body.appendChild(el("div", "empty-note", "暂无工具")); return; }
      tools.forEach(function (t) {
        var row = el("div", "tool-row");
        row.appendChild(el("b", null, t.name));
        row.appendChild(el("span", null, toolZh(t.name, t.description)));
        body.appendChild(row);
      });
    }, [{ label: "关闭", fn: closeModal }]);
  }

  function openSessions() {
    openModal("会话", function (body) {
      if (!S.sessions.length) { body.appendChild(el("div", "empty-note", "暂无历史会话")); return; }
      S.sessions.forEach(function (s) {
        var row = el("button", "fs-row");
        row.type = "button";
        row.appendChild(el("span", "fs-ico", "#"));
        row.appendChild(el("span", "fs-name", (s.title || s.id) + " · " + s.messages + " 条"));
        row.appendChild(el("span", "fs-size", timeAgo(s.updatedAt || s.savedAt)));
        row.addEventListener("click", function () { closeModal(); resumeSession(s.id); });
        body.appendChild(row);
      });
    }, [{ label: "关闭", fn: closeModal }]);
  }

  function openTasks() {
    getJSON("/api/tasks").then(function (j) {
      openModal("后台任务", function (body) {
        var list = j.tasks || [];
        if (!list.length) { body.appendChild(el("div", "empty-note", "暂无后台任务")); return; }
        list.forEach(function (t) {
          var row = el("div", "task-row");
          row.appendChild(el("div", "task-cmd", t.command));
          var meta = el("div", "task-meta");
          meta.appendChild(el("span", "pill " + (t.status === "running" ? "run" : t.exitCode === 0 ? "ok" : "fail"), t.status));
          meta.appendChild(el("span", null, t.id));
          if (t.exitCode != null) { meta.appendChild(el("span", null, "退出码 " + t.exitCode)); }
          row.appendChild(meta);
          body.appendChild(row);
        });
      }, [{ label: "关闭", fn: closeModal }]);
    }).catch(function (e) { toast("加载失败：" + e.message, "err"); });
  }

  function openFiles(dir) {
    var path = dir || ((S.config && S.config.cwd) || ".");
    getJSON("/api/fs?path=" + encodeURIComponent(path)).then(function (j) {
      openModal("文件", function (body) {
        body.appendChild(el("div", "fs-path", j.path));
        if (j.parent) {
          var up = el("button", "fs-row");
          up.type = "button";
          up.appendChild(el("span", "fs-ico", "\u2191"));
          up.appendChild(el("span", "fs-name", ".."));
          up.addEventListener("click", function () { openFiles(j.parent); });
          body.appendChild(up);
        }
        (j.entries || []).forEach(function (e) {
          var row = el("button", "fs-row");
          row.type = "button";
          row.appendChild(el("span", "fs-ico", e.dir ? "\u25B8" : "\u00B7"));
          row.appendChild(el("span", "fs-name", e.name));
          if (!e.dir) { row.appendChild(el("span", "fs-size", bytes(e.size))); }
          row.addEventListener("click", function () {
            if (e.dir) { openFiles(e.path); } else { openFile(e.path); }
          });
          body.appendChild(row);
        });
      });
    }).catch(function (e) { toast("读取失败：" + e.message, "err"); });
  }

  function openFile(path) {
    getJSON("/api/fs/file?path=" + encodeURIComponent(path)).then(function (j) {
      openModal(j.name || "文件", function (body) {
        body.appendChild(el("div", "fs-path", j.path + (j.truncated ? "（已截断）" : "")));
        var view = el("div", "file-view");
        if (j.binary) {
          view.appendChild(el("div", "empty-note", "二进制文件 · " + bytes(j.size)));
        } else if (j.utf8 === false) {
          view.appendChild(el("div", "empty-note", "非 UTF-8 文本 · " + bytes(j.size)));
        } else {
          var wrap = el("div", "codeblock");
          var head = el("div", "cb-head");
          head.appendChild(el("span", "cb-lang", (j.name || "").split(".").pop() || "text"));
          var cp = el("button", "cb-copy", "复制");
          cp.type = "button";
          cp.addEventListener("click", function () { copyText(j.content); });
          head.appendChild(cp);
          wrap.appendChild(head);
          var pre = document.createElement("pre");
          pre.className = "code";
          pre.innerHTML = MD.highlight(j.content, (j.name || "").split(".").pop() || "");
          wrap.appendChild(pre);
          view.appendChild(wrap);
        }
        body.appendChild(view);
      }, [{ label: "关闭", fn: closeModal }]);
    }).catch(function (e) { toast("打开失败：" + e.message, "err"); });
  }

  function openSessionMenu(s, x, y) {
    var old = $("session-menu");
    if (old && old.parentNode) { old.parentNode.removeChild(old); }
    var menu = el("div", "ctx");
    menu.id = "session-menu";
    menu.appendChild(ctxItem(s.pinned ? "取消置顶" : "置顶", function () {
      patchJSON("/api/sessions/" + encodeURIComponent(s.id), { pinned: !s.pinned }).then(refreshSessions);
    }));
    menu.appendChild(ctxItem("重命名", function () {
      var name = window.prompt("对话名称", s.title || s.id);
      if (name && name.trim()) {
        patchJSON("/api/sessions/" + encodeURIComponent(s.id), { title: name.trim() }).then(refreshSessions);
      }
    }));
    menu.appendChild(ctxItem("导出 Markdown", function () { exportSession(s.id, s.title); }));
    menu.appendChild(ctxItem("删除", function () { deleteSession(s.id); }, "danger"));
    document.body.appendChild(menu);
    var rect = menu.getBoundingClientRect();
    menu.style.left = Math.min(x, window.innerWidth - rect.width - 8) + "px";
    menu.style.top = Math.min(y, window.innerHeight - rect.height - 8) + "px";
    setTimeout(function () { document.addEventListener("click", closeCtx, { once: true }); }, 0);
  }

  function ctxItem(label, fn, cls) {
    var b = el("button", "ctx-item" + (cls ? " " + cls : ""), label);
    b.type = "button";
    b.addEventListener("click", function () { closeCtx(); fn(); });
    return b;
  }

  function closeCtx() {
    var m = $("session-menu");
    if (m && m.parentNode) { m.parentNode.removeChild(m); }
  }

  function exportSession(id, title) {
    getJSON("/api/session/export?id=" + encodeURIComponent(id)).then(function (j) {
      var blob = new Blob([j.markdown || ""], { type: "text/markdown;charset=utf-8" });
      var url = URL.createObjectURL(blob);
      var a = document.createElement("a");
      a.href = url;
      a.download = (title || id).replace(/[\\/:*?"<>|]+/g, "_") + ".md";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
      toast("已导出 Markdown", "ok");
    }).catch(function (e) { toast("导出失败：" + e.message, "err"); });
  }

  /* ================================================================ 命令 === */

  /** 用户/项目自定义命令（来自 .myclaude/commands/*.md）。 */
  var customCommands = [];

  function loadCustomCommands() {
    return getJSON("/api/commands").then(function (j) {
      customCommands = j.commands || [];
      return customCommands;
    }).catch(function () { customCommands = []; return []; });
  }

  function findCustom(name) {
    var n = String(name || "").toLowerCase();
    for (var i = 0; i < customCommands.length; i++) {
      if (customCommands[i].name === n) { return customCommands[i]; }
    }
    return null;
  }

  /** 把自定义命令展开成一次普通对话轮次。 */
  function runCustomCommand(cmd, args) {
    postJSON("/api/commands/run", { name: cmd.name, args: args }).then(function (j) {
      if (!j.ok || !j.prompt) { addNotice("命令展开失败：" + cmd.name, "err"); return; }
      addUserMessage("/" + cmd.name + (args ? " " + args : ""), []);
      addNotice("执行自定义命令 /" + cmd.name, "info");
      // Retry replays the expanded prompt, not the slash line.
      S.lastUserText = j.prompt;
      runTurn({ message: j.prompt, sessionKey: S.sessionKey });
    }).catch(function (e) { addNotice("命令执行失败：" + e.message, "err"); });
  }

  var COMMANDS = [
    { k: "/help", d: "显示命令列表", fn: function () { runCommand("/help"); } },
    { k: "/new", d: "新对话", fn: function () { newChat(); } },
    { k: "/model", d: "查看或切换模型", fn: function () { openSettings(); } },
    { k: "/mode", d: "切换权限模式", fn: function () { runCommand("/mode"); } },
    { k: "/tools", d: "可用工具", fn: function () { openTools(); } },
    { k: "/config", d: "查看当前配置", fn: function () { runCommand("/config"); } },
    { k: "/sessions", d: "历史会话", fn: function () { openSessions(); } },
    { k: "/files", d: "浏览工作目录", fn: function () { openFiles(); } },
    { k: "/tasks", d: "后台任务", fn: function () { openTasks(); } },
    { k: "/settings", d: "设置", fn: function () { openSettings(); } },
    { k: "/theme", d: "切换深色 / 浅色", fn: function () { toggleTheme(); } }
  ];

  function runCommand(text) {
    var parts = text.slice(1).split(/\s+/);
    var cmd = (parts.shift() || "").toLowerCase();
    var arg = parts.join(" ").trim();
    switch (cmd) {
      case "help":
        addNotice("命令：/help /new /model /mode /tools /config /sessions /files /tasks /settings /theme", "info");
        break;
      case "new":
        newChat();
        break;
      case "model":
        openSettings();
        break;
      case "mode":
        if (["ask", "auto", "plan"].indexOf(arg) >= 0) {
          postJSON("/api/config", { permissionMode: arg }).then(function (j) {
            if (S.config) { S.config.permissionMode = j.permissionMode || arg; }
            setMode(j.permissionMode || arg);
            toast("模式：" + modeName(j.permissionMode || arg), "ok");
          });
        } else {
          addNotice("用法：/mode ask|auto|plan", "warn");
        }
        break;
      case "tools":
        openTools();
        break;
      case "config":
        getJSON("/api/config").then(function (j) {
          addNotice(JSON.stringify(j, null, 2), "info");
        });
        break;
      case "sessions":
        openSessions();
        break;
      case "files":
        openFiles(arg || null);
        break;
      case "tasks":
        openTasks();
        break;
      case "settings":
        openSettings();
        break;
      case "theme":
        toggleTheme();
        break;
      case "commands":
        openCommandsModal();
        break;
      default: {
        var custom = findCustom(cmd);
        if (custom) { runCustomCommand(custom, arg); break; }
        addNotice("未知命令：/" + cmd + "（试试 /help 或 /commands）", "warn");
      }
    }
  }

  var slashOpen = false;
  var slashIndex = 0;
  var slashMatches = [];

  function updateSlashMenu(value) {
    var text = value || "";
    if (text.charAt(0) !== "/" || text.indexOf(" ") >= 0) { closeSlash(); return; }
    var needle = text.slice(1).toLowerCase();
    slashMatches = allCommands().filter(function (c) {
      return !needle || c.k.toLowerCase().replace(/^\//, "").indexOf(needle) >= 0;
    });
    if (!slashMatches.length) { closeSlash(); return; }
    slashIndex = Math.min(slashIndex, slashMatches.length - 1);
    slashOpen = true;
    drawSlash();
  }

  function drawSlash() {
    var host = $("slash");
    if (!host) { return; }
    host.hidden = false;
    clear(host);
    slashMatches.slice(0, 12).forEach(function (c, i) {
      var row = el("button", "slash-item" + (i === slashIndex ? " sel" : ""));
      row.type = "button";
      row.appendChild(el("span", "slash-k", c.k));
      row.appendChild(el("span", "slash-d", c.d));
      row.addEventListener("mousedown", function (e) {
        e.preventDefault();
        slashIndex = i;
        slashAccept();
      });
      host.appendChild(row);
    });
  }

  function slashMove(delta) {
    slashIndex = (slashIndex + delta + slashMatches.length) % slashMatches.length;
    drawSlash();
  }

  function slashAccept() {
    var item = slashMatches[slashIndex];
    if (!item) { closeSlash(); return; }
    var ta = $("in");
    ta.value = item.k + " ";
    autoGrow(ta);
    closeSlash();
    ta.focus();
  }

  function closeSlash() {
    slashOpen = false;
    slashIndex = 0;
    var host = $("slash");
    if (host) { host.hidden = true; clear(host); }
  }

  function applyMotion(enabled) {
    S.motion = enabled !== false;
    document.body.classList.toggle("no-motion", !S.motion);
    try { localStorage.setItem(LS_MOTION, S.motion ? "on" : "off"); } catch (e) { }
  }

  function applyTheme(theme) {
    S.theme = theme;
    document.documentElement.setAttribute("data-theme", theme);
    try { localStorage.setItem(LS_THEME, theme); } catch (e) { }
    var label = $("theme-label");
    if (label) { label.textContent = theme === "dark" ? "浅色模式" : "深色模式"; }
    var ti = $("theme-icon");
    if (ti && ti.firstChild) { ti.firstChild.setAttribute("href", theme === "dark" ? "#i-sun" : "#i-moon"); }
    var tb = $("btn-theme");
    if (tb) { tb.title = theme === "dark" ? "切换到浅色" : "切换到深色"; }
  }

  function toggleTheme() {
    applyTheme(S.theme === "dark" ? "light" : "dark");
  }

  /* ================================================================ 绑定 === */

  function bindEvents() {
    var ta = $("in");
    var send = $("send");
    if (send) { send.addEventListener("click", sendMessage); }
    var stop = $("btn-stop");
    if (stop) { stop.addEventListener("click", stopGeneration); }

    if (ta) {
      ta.addEventListener("input", function () { autoGrow(ta); updateSlashMenu(ta.value); });
      ta.addEventListener("keydown", function (e) {
        if (slashOpen) {
          if (e.key === "ArrowDown") { e.preventDefault(); slashMove(1); return; }
          if (e.key === "ArrowUp") { e.preventDefault(); slashMove(-1); return; }
          if (e.key === "Tab") { e.preventDefault(); slashAccept(); return; }
          if (e.key === "Escape") { e.preventDefault(); closeSlash(); return; }
          if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); slashAccept(); return; }
        }
        if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
          e.preventDefault();
          sendMessage();
        }
        if (e.key === "ArrowUp" && !ta.value && S.history.length) {
          e.preventDefault();
          S.histIdx = S.histIdx < 0 ? S.history.length - 1 : Math.max(0, S.histIdx - 1);
          ta.value = S.history[S.histIdx];
          autoGrow(ta);
        }
      });
      ta.addEventListener("paste", function (e) {
        var items = (e.clipboardData && e.clipboardData.items) || [];
        var files = [];
        for (var i = 0; i < items.length; i++) {
          if (items[i].kind === "file") {
            var f = items[i].getAsFile();
            if (f) { files.push(f); }
          }
        }
        if (files.length) { e.preventDefault(); addFiles(files); }
      });
    }

    var attach = $("btn-attach");
    var fileInput = $("file-input");
    if (attach && fileInput) {
      attach.addEventListener("click", function () { fileInput.click(); });
      fileInput.addEventListener("change", function () {
        addFiles(fileInput.files);
        fileInput.value = "";
      });
    }

    Array.prototype.forEach.call(document.querySelectorAll(".segmented-item"), function (btn) {
      btn.addEventListener("click", function () {
        var mode = btn.getAttribute("data-mode");
        postJSON("/api/config", { permissionMode: mode }).then(function (j) {
          if (S.config) { S.config.permissionMode = j.permissionMode || mode; }
          setMode(j.permissionMode || mode);
        }).catch(function (e) { toast("切换失败：" + e.message, "err"); });
      });
    });

    var bNew = $("btn-new-chat");
    if (bNew) { bNew.addEventListener("click", newChat); }
    var bSearch = $("btn-search-chat");
    if (bSearch) { bSearch.addEventListener("click", openCmd); }
    var bFiles = $("btn-files");
    if (bFiles) { bFiles.addEventListener("click", function () { openFiles(); }); }
    var bTools = $("btn-tools");
    if (bTools) { bTools.addEventListener("click", openTools); }
    var bTasks = $("btn-tasks");
    if (bTasks) { bTasks.addEventListener("click", openTasks); }
    var bSessions = $("btn-sessions");
    if (bSessions) { bSessions.addEventListener("click", openSessions); }
    var bSettings = $("btn-settings");
    if (bSettings) { bSettings.addEventListener("click", openSettings); }
    var bTheme = $("btn-theme");
    if (bTheme) { bTheme.addEventListener("click", toggleTheme); }
    var bVision = $("btn-vision");
    if (bVision) {
      bVision.addEventListener("click", function () {
        var v = !S.vision;
        postJSON("/api/config", { vision: v }).then(function () {
          S.vision = v;
          renderVision();
          toast("视觉已" + (v ? "开启" : "关闭"), v ? "ok" : "warn");
        });
      });
    }
    var bClear = $("btn-clear");
    if (bClear) { bClear.addEventListener("click", newChat); }
    var bExpand = $("btn-expand-tools");
    if (bExpand) { bExpand.addEventListener("click", toggleAllTools); }
    var bBottom = $("btn-to-bottom");
    if (bBottom) { bBottom.addEventListener("click", function () { S.autoScroll = true; scrollStream(true); }); }
    var bRail = $("btn-rail-toggle");
    if (bRail) { bRail.addEventListener("click", toggleRail); }
    var bRailC = $("btn-rail-collapse");
    if (bRailC) { bRailC.addEventListener("click", toggleRail); }
    var bTopNew = $("btn-top-new");
    if (bTopNew) { bTopNew.addEventListener("click", newChat); }
    var veil = $("rail-veil");
    if (veil) { veil.addEventListener("click", function () { $("app").classList.remove("rail-open"); veil.hidden = true; }); }
    var bInspClose = $("btn-insp-close");
    if (bInspClose) { bInspClose.addEventListener("click", function () { setInspector(false); }); }
    var bInsp = $("btn-insp-toggle");
    if (bInsp) { bInsp.addEventListener("click", function () { setInspector(!$("app").classList.contains("insp-open")); }); }
    var bModel = $("btn-model");
    if (bModel) { bModel.addEventListener("click", function (e) { e.stopPropagation(); toggleModelMenu(); }); }
    document.addEventListener("click", function (e) {
      var m = $("model-menu");
      if (m && !m.hidden && !m.contains(e.target)) { m.hidden = true; }
    });

    var stream = $("stream");
    if (stream) {
      stream.addEventListener("scroll", function () {
        var far = stream.scrollHeight - stream.scrollTop - stream.clientHeight > 120;
        S.autoScroll = !far;
        var b = $("btn-to-bottom");
        if (b) { b.hidden = !far; }
      });
    }

    var log = logRoot();
    if (log) {
      log.addEventListener("click", function (e) {
        var t = e.target;
        if (t && t.tagName === "IMG") { e.preventDefault(); openLightbox(t.getAttribute("src"), t.getAttribute("alt") || ""); return; }
        if (t && t.hasAttribute && t.hasAttribute("data-copy")) {
          var block = t.closest(".codeblock");
          var code = block && block.querySelector("pre");
          if (code) {
            copyText(code.textContent || "");
            t.textContent = "已复制";
            setTimeout(function () { t.textContent = "复制"; }, 1200);
          }
        }
      });
    }

    var depth = 0;
    window.addEventListener("dragenter", function (e) {
      if (Array.prototype.indexOf.call(e.dataTransfer.types || [], "Files") >= 0) { depth++; document.body.classList.add("dragging"); }
    });
    window.addEventListener("dragleave", function () { if (--depth <= 0) { depth = 0; document.body.classList.remove("dragging"); } });
    window.addEventListener("dragover", function (e) {
      if (Array.prototype.indexOf.call(e.dataTransfer.types || [], "Files") >= 0) { e.preventDefault(); }
    });
    window.addEventListener("drop", function (e) {
      if (!e.dataTransfer || !e.dataTransfer.files || !e.dataTransfer.files.length) { return; }
      e.preventDefault();
      depth = 0;
      document.body.classList.remove("dragging");
      addFiles(e.dataTransfer.files);
    });

    document.addEventListener("click", function (e) {
      var t = e.target;
      if (t && t.getAttribute && t.getAttribute("data-close")) { closeModal(); }
    });

    document.addEventListener("keydown", function (e) {
      var tag = (e.target && e.target.tagName) || "";
      var typing = tag === "INPUT" || tag === "TEXTAREA" || (e.target && e.target.isContentEditable);
      var mod = e.ctrlKey || e.metaKey;
      if (e.key === "Escape") {
        if (!$("modal").hidden) { closeModal(); return; }
        if (!$("cmd").hidden) { closeCmd(); return; }
        if ($("model-menu") && !$("model-menu").hidden) { $("model-menu").hidden = true; return; }
        if (S.busy) { stopGeneration(); return; }
      }
      if (mod && e.key.toLowerCase() === "k") { e.preventDefault(); openCmd(); return; }
      if (mod && e.key === ",") { e.preventDefault(); openSettings(); return; }
      if (mod && e.key.toLowerCase() === "b") { e.preventDefault(); toggleRail(); return; }
      if (mod && e.key.toLowerCase() === "i") { e.preventDefault(); setInspector(!$("app").classList.contains("insp-open")); return; }
      if (mod && e.key.toLowerCase() === "l") { e.preventDefault(); newChat(); return; }
      if (!typing && e.key === "?") { e.preventDefault(); openCmd(); }
    });

    var cmdInput = $("cmd-input");
    if (cmdInput) {
      cmdInput.addEventListener("input", function () { cmdIndex = 0; drawCmd(cmdInput.value); });
      cmdInput.addEventListener("keydown", function (e) {
        if (e.key === "ArrowDown") { e.preventDefault(); cmdIndex = Math.min(cmdIndex + 1, cmdMatches.length - 1); drawCmd(cmdInput.value); }
        else if (e.key === "ArrowUp") { e.preventDefault(); cmdIndex = Math.max(cmdIndex - 1, 0); drawCmd(cmdInput.value); }
        else if (e.key === "Enter") {
          e.preventDefault();
          var item = cmdMatches[cmdIndex];
          closeCmd();
          if (item) { item.fn(); }
        } else if (e.key === "Escape") { e.preventDefault(); closeCmd(); }
      });
    }
  }

  function isNarrow() { return window.innerWidth <= 900; }

  function toggleRail() {
    var app = $("app");
    if (isNarrow()) {
      var open = !app.classList.contains("rail-open");
      app.classList.toggle("rail-open", open);
      var v = $("rail-veil");
      if (v) { v.hidden = !open; }
      return;
    }
    var hidden = !app.classList.contains("rail-hidden");
    app.classList.toggle("rail-hidden", hidden);
    try { localStorage.setItem(LS_RAIL, hidden ? "hidden" : "shown"); } catch (e) { }
    setTimeout(moveModeThumb, 260);
  }

  /** 全部工具卡统一展开或收起。 */
  function toggleAllTools() {
    S.toolsExpanded = !S.toolsExpanded;
    var cards = document.querySelectorAll(".tool");
    for (var i = 0; i < cards.length; i++) {
      cards[i].classList.toggle("open", S.toolsExpanded);
    }
    var label = $("expand-tools-label");
    if (label) { label.textContent = S.toolsExpanded ? "收起输出" : "展开输出"; }
    var btn = $("btn-expand-tools");
    if (btn) { btn.classList.toggle("active", S.toolsExpanded); }
  }

  function setInspector(open) {
    var app = $("app");
    app.classList.toggle("insp-open", !!open);
    try { localStorage.setItem(LS_INSP, open ? "open" : "closed"); } catch (e) { }
    if (open) { renderInspector(); }
    setTimeout(moveModeThumb, 260);
  }

  var modelCache = null;

  function toggleModelMenu() {
    var menu = $("model-menu");
    if (!menu) { return; }
    if (!menu.hidden) { menu.hidden = true; return; }
    menu.hidden = false;
    drawModelMenu();
    if (!modelCache) {
      getJSON("/api/models").then(function (j) {
        modelCache = j.models || [];
        drawModelMenu();
      }).catch(function () { modelCache = []; drawModelMenu(); });
    }
  }

  function drawModelMenu() {
    var menu = $("model-menu");
    if (!menu) { return; }
    clear(menu);
    var cur = (S.config && S.config.model) || "";
    menu.appendChild(el("div", "model-menu-head", "模型"));
    var list = modelCache == null ? null : modelCache.slice();
    if (list && cur && list.indexOf(cur) < 0) { list.unshift(cur); }
    if (list == null) {
      menu.appendChild(el("div", "empty-note", "正在加载…"));
    } else if (!list.length) {
      menu.appendChild(el("div", "empty-note", "未发现可用模型，可在设置中手动填写"));
    } else {
      var box = el("div", "model-menu-list");
      list.forEach(function (name) {
        var b = el("button", "model-opt" + (name === cur ? " on" : ""));
        b.type = "button";
        b.appendChild(el("span", "model-opt-name", name));
        if (name === cur) { b.appendChild(el("span", "model-opt-check", "\u2713")); }
        b.addEventListener("click", function () {
          menu.hidden = true;
          if (name === cur) { return; }
          postJSON("/api/config", { model: name }).then(function (j) {
            if (S.config) { S.config.model = j.model || name; }
            renderTopMeta();
            renderInspector();
            toast("已切换到 " + (j.model || name), "ok");
          }).catch(function (e) { toast("切换失败：" + e.message, "err"); });
        });
        box.appendChild(b);
      });
      menu.appendChild(box);
    }
    var more = el("button", "model-more", "更多设置…");
    more.type = "button";
    more.addEventListener("click", function () { menu.hidden = true; openSettings(); });
    menu.appendChild(more);
  }

  var cmdIndex = 0;
  var cmdMatches = [];

  /** 内建命令 + 自定义命令，供斜杠菜单与命令面板共用。 */
  function allCommands() {
    var list = COMMANDS.slice();
    customCommands.forEach(function (c) {
      var k = "/" + c.name;
      if (list.some(function (x) { return x.k === k; })) { return; }
      list.push({
        k: k,
        d: c.description + (c.scope === "user" ? "（用户）" : "（项目）"),
        fn: function () { runCustomCommand(c, ""); }
      });
    });
    return list;
  }

  function openCommandsModal() {
    var list = allCommands();
    openModal("命令（" + list.length + "）", function (body) {
      list.forEach(function (c) {
        var row = el("div", "tool-row");
        row.appendChild(el("b", null, c.k));
        row.appendChild(el("span", null, c.d));
        body.appendChild(row);
      });
      if (!customCommands.length) {
        body.appendChild(el("div", "empty-note", "尚无自定义命令。在 .myclaude/commands/ 或 ~/.myclaude/commands/ 下放置 .md 文件即可，文件名即命令名，正文即提示词；$ARGUMENTS 会被替换为用户输入。"));
      }
    }, [{ label: "关闭", fn: closeModal }]);
  }

  function openCmd() {
    var c = $("cmd");
    if (!c) { return; }
    c.hidden = false;
    var input = $("cmd-input");
    input.value = "";
    cmdIndex = 0;
    drawCmd("");
    setTimeout(function () { input.focus(); }, 20);
  }

  function closeCmd() {
    var c = $("cmd");
    if (c) { c.hidden = true; }
  }

  function drawCmd(q) {
    var list = $("cmd-list");
    if (!list) { return; }
    clear(list);
    var needle = String(q || "").toLowerCase().replace(/^\//, "");
    cmdMatches = allCommands().filter(function (c) {
      return !needle || c.k.toLowerCase().indexOf(needle) >= 0 || c.d.toLowerCase().indexOf(needle) >= 0;
    });
    var chats = S.sessions.filter(function (s) {
      return String(s.title || s.id).toLowerCase().indexOf(needle) >= 0;
    }).slice(0, needle ? 8 : 5).map(function (s) {
      return { k: s.title || s.id, d: timeAgo(s.updatedAt || s.savedAt), chat: true, fn: function () { resumeSession(s.id); } };
    });
    cmdMatches = chats.concat(cmdMatches);
    if (!cmdMatches.length) {
      list.appendChild(el("div", "empty-note", "无匹配命令"));
      return;
    }
    cmdIndex = Math.min(cmdIndex, cmdMatches.length - 1);
    cmdMatches.forEach(function (c, i) {
      var row = el("button", "cmd-item" + (i === cmdIndex ? " sel" : "") + (c.chat ? " is-chat" : ""));
      row.appendChild(icon(c.chat ? "i-chat" : "i-spark", 15));
      row.type = "button";
      row.appendChild(el("span", "cmd-k", c.k));
      row.appendChild(el("span", "cmd-d", c.d));
      row.addEventListener("click", function () { closeCmd(); c.fn(); });
      list.appendChild(row);
    });
  }

  function openLightbox(src, alt) {
    if (!src) { return; }
    var box = el("div", "lightbox");
    var img = document.createElement("img");
    img.src = src;
    img.alt = alt;
    box.appendChild(img);
    if (alt) { box.appendChild(el("div", "lightbox-cap", alt)); }
    box.addEventListener("click", function () { closeLightbox(); });
    document.body.appendChild(box);
  }

  function closeLightbox() {
    var box = document.querySelector(".lightbox");
    if (box && box.parentNode) { box.parentNode.removeChild(box); }
  }

  function addFiles(list) {
    var jobs = [];
    Array.prototype.forEach.call(list || [], function (file) {
      if (!file) { return; }
      if (/^image\//.test(file.type || "")) {
        if (file.size > 5 * 1024 * 1024) { return; }
        jobs.push(readFileDataURL(file).then(function (url) {
          S.attachments.push({ kind: "image", name: file.name, mime: file.type, size: file.size, data: (url.split(",")[1] || ""), preview: url });
        }));
        return;
      }
      if (file.size > 512 * 1024) { return; }
      jobs.push(readFileText(file).then(function (txt) {
        S.attachments.push({ kind: "text", name: file.name, mime: file.type || "text/plain", size: file.size, text: txt });
      }));
    });
    return Promise.all(jobs).then(function () { renderAttachments(); });
  }

  function readFileText(file) {
    return new Promise(function (resolve, reject) {
      var r = new FileReader();
      r.onload = function () { resolve(r.result); };
      r.onerror = reject;
      r.readAsText(file);
    });
  }

  function readFileDataURL(file) {
    return new Promise(function (resolve, reject) {
      var r = new FileReader();
      r.onload = function () { resolve(r.result); };
      r.onerror = reject;
      r.readAsDataURL(file);
    });
  }

  /* ================================================================ 启动 === */

  window.addEventListener("resize", function () { moveModeThumb(); });

  function boot() {
    var params = new URLSearchParams(location.search);
    var savedTheme = params.get("theme");
    if (savedTheme !== "light" && savedTheme !== "dark") {
      savedTheme = null;
      try { savedTheme = localStorage.getItem(LS_THEME); } catch (e) { }
    }
    if (savedTheme !== "light" && savedTheme !== "dark") {
      savedTheme = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    }
    applyTheme(savedTheme);
    try {
      if (localStorage.getItem(LS_RAIL) === "hidden" && window.innerWidth > 900) { $("app").classList.add("rail-hidden"); }
      if (localStorage.getItem(LS_INSP) === "open" && window.innerWidth > 1200) { $("app").classList.add("insp-open"); }
    } catch (e) { }
    renderProfile();
    if (params.get("motion") === "off") { applyMotion(false); }

    loadCustomCommands();
    renderWelcomeCards();
    renderChatSkeleton();
    bindEvents();
    if (params.get("insp") === "1") { $("app").classList.add("insp-open"); }
    if (params.get("settings") === "1") { setTimeout(openSettings, 400); }
    if (params.get("commands") === "1") { setTimeout(openCommandsModal, 500); }
    if (params.get("slash")) { var sq = params.get("slash"); setTimeout(function () { updateSlashMenu("/" + (sq === "1" ? "" : sq)); }, 500); }
    if (params.get("resume")) { setTimeout(function () { resumeSession(params.get("resume")); }, 400); }

    getJSON("/api/config").then(function (j) {
      S.config = j;
      S.vision = j.vision !== false;
      S.stats = {
        messages: j.messages || 0,
        turns: j.turns || 0,
        tokens: j.tokens || 0,
        inputTokens: j.inputTokens || 0,
        outputTokens: j.outputTokens || 0,
        contextLimit: j.contextLimit || 0,
        contextUsed: j.contextUsed || 0
      };
      if (j.routing) { S.routing = j.routing; }
      setMode(j.permissionMode || "ask");
      renderVision();
      renderUsage();
      renderInspector();
      refreshSessions();
    }).catch(function (e) {
      addNotice("无法连接服务：" + e.message, "err");
    });

    var ta = $("in");
    if (ta) { ta.focus(); }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();

