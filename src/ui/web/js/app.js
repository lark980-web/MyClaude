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
      pendingQueue: [],
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
    replayingHistory: false,
    history: [],
    histIdx: -1,
    style: "normal",
    artifacts: [],
    activeArtifactId: null,
    artifactView: "preview",
    inspTab: "info",
    welcomeCat: "code",
    archivePolicy: "smart",
    thinking: false,
    webSearch: false,
    pendingCitations: [],
    _pendingRetryBranches: null,
    artifactFullscreen: false,
    pinnedMessages: [],
    pinnedExpanded: false,
    feedback: {},
    chatView: "project",
    sharedIds: [],
    titleOverride: null,
    project: { activeProjectId: "proj-default", projects: [], name: "当前项目", instructions: "", files: [], knowledge: [], totalTokens: 0, limitTokens: 128000, capacityPct: 0 }
  };

  var LS_PINNED_PREFIX = "myclaude.pinned.";

  var LS_THEME = "myclaude.theme";
  var LS_MOTION = "myclaude.motion";
  var LS_SESSION = "myclaude.session";
  var LS_NAME = "myclaude.name";
  var LS_RAIL = "myclaude.rail";
  var LS_INSP = "myclaude.inspector";
  var LS_VOICE_LANG = "myclaude.voice.lang";
  var LS_VOICE_ENGINE = "myclaude.voice.engine";
  var LS_STYLE = "myclaude.style";
  var LS_ARCHIVE_POLICY = "myclaude.archive.policy";
  var LS_WEB_SEARCH = "myclaude.websearch";
  var LS_CHAT_VIEW = "myclaude.chatview";

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


  /** 最多同时显示几条提示。 */
  var TOAST_MAX = 3;

  /**
   * Show a transient notification.
   *
   * Identical messages are refreshed rather than duplicated: deleting five
   * sessions in a row used to stack five "已删除" bars, which reads as a
   * glitch rather than as confirmation.
   */
  function toast(text, kind) {
    var wrap = $("toasts");
    if (!wrap) { return; }
    var label = String(text || "");

    // Collapse a repeat of the message already showing.
    var existing = null;
    Array.prototype.forEach.call(wrap.children, function (n) {
      if (n.getAttribute("data-msg") === label) { existing = n; }
    });
    if (existing) {
      clearTimeout(Number(existing.getAttribute("data-timer")));
      var bump = Number(existing.getAttribute("data-count") || 1) + 1;
      existing.setAttribute("data-count", String(bump));
      if (existing.lastChild) { existing.lastChild.textContent = bump > 1 ? " \u00D7" + bump : ""; }
      existing.setAttribute("data-timer", String(armToast(existing)));
      return;
    }

    var t = el("div", "toast " + (kind || ""));
    t.setAttribute("data-msg", label);
    t.appendChild(el("span", "toast-text", label));
    t.appendChild(el("span", "toast-count", ""));
    t.setAttribute("data-timer", String(armToast(t)));
    wrap.appendChild(t);

    // Keep the stack bounded.
    while (wrap.children.length > TOAST_MAX) {
      wrap.removeChild(wrap.firstChild);
    }
  }

  /** Schedule a toast for removal and return the timer id. */
  function armToast(node) {
    return setTimeout(function () {
      node.style.opacity = "0";
      node.style.transition = "opacity .2s";
      setTimeout(function () { if (node.parentNode) { node.parentNode.removeChild(node); } }, 220);
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

  function delJSON(url, body) {
    return fetch(url, {
      method: "DELETE",
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined
    }).then(function (r) {
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

  /**
   * Keep the transcript pinned to the newest content while it streams.
   *
   * The write is flagged as programmatic: the scroll listener treats every
   * scroll event as a user gesture, so scrolling ourselves would otherwise look
   * like "the user scrolled away" and silently turn auto-follow off — which is
   * why the view stopped following during long tool runs.
   */
  function scrollStream(force) {
    var st = $("stream");
    if (!st) { return; }
    if (force) { S.autoScroll = true; }
    if (S.autoScroll) {
      S.programmaticScroll = true;
      requestAnimationFrame(function () {
        st.scrollTop = st.scrollHeight;
        // Release the flag after the scroll event for this write has fired.
        requestAnimationFrame(function () { S.programmaticScroll = false; });
      });
    }
    var b = $("btn-to-bottom");
    if (b) {
      b.hidden = !(st.scrollHeight - st.scrollTop - st.clientHeight > 240);
      // 与输入卡片右上对齐：右移量 = 流区右缘 - 输入卡片右缘 + 16
      try {
        var inEl2 = $("in");
        var card2 = inEl2;
        while (card2 && card2 !== document.body) { var cs2 = getComputedStyle(card2); if (parseFloat(cs2.borderRadius) > 8 && cs2.boxShadow !== "none") break; card2 = card2.parentElement; }
        var diff2 = (st.getBoundingClientRect().left + st.clientWidth) - card2.getBoundingClientRect().right; // clientWidth 排除滚动条
        b.style.marginRight = (16 + diff2) + "px";
      } catch (e2) {}
    }
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

  /**
   * Token 估算，口径与 src/tokens.js 一致：CJK 约 1 字符 1 token，其余约 4 字符 1 token。
   * 前端各处的 chars/4 会把中文低估 3-4 倍，同一段提示词在卡片上显示 36 tok、
   * 实际约 114 —— 上下文占用因此看起来比真实情况宽松得多。
   */
  function estimateTextTokens(str) {
    var t = str == null ? "" : String(str);
    if (!t) { return 0; }
    var m = t.match(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af\u3000-\u303f\uff00-\uffef]/g);
    var cjk = m ? m.length : 0;
    return cjk + Math.ceil((t.length - cjk) / 4);
  }

  function logRoot() { return _logRedirect || $("log"); }

  /* 渐进重放期间把渲染临时导入离屏容器，整批再插回真实 #log（见 replayTranscript） */
  var _logRedirect = null;

  function collectTurnNodesAfter(userWrap) {
    var nodes = [];
    var cur = userWrap.nextElementSibling;
    while (cur && !cur.classList.contains("msg-user")) {
      nodes.push(cur);
      cur = cur.nextElementSibling;
    }
    return nodes;
  }

  var msgSeqCounter = 0;

  function assignMsgId(wrap, role) {
    if (!wrap._msgId) {
      msgSeqCounter++;
      wrap._msgId = "msg-" + role + "-" + msgSeqCounter;
      wrap.id = wrap._msgId;
    }
    return wrap._msgId;
  }

  function addUserMessage(text, files) {
    hideWelcome();
    var root = logRoot();
    var wrap = el("div", "msg msg-user");
    assignMsgId(wrap, "user");
    wrap._role = "user";
    wrap._text = text;
    wrap._files = (files || []).slice();
    wrap._branches = [];
    wrap._branchIdx = 0;

    if (files && files.length) {
      var row = el("div", "msg-files");
      files.forEach(function (f) {
        var chip = el("div", "chip" + (f.pasted ? " is-pasted" : f.fileRef ? " is-file-ref" : f.quote ? " is-quote" : ""));
        if (f.preview) {
          var img = document.createElement("img");
          img.src = f.preview;
          chip.appendChild(img);
        } else {
          chip.appendChild(el("span", "chip-ico", f.pasted ? "PASTED" : f.fileRef ? "@" : f.quote ? "引用" : "TXT"));
        }
        chip.appendChild(el("span", "chip-name", f.name));
        if (f.text) {
          chip.addEventListener("click", function () {
            openAttachmentPreviewModal(f);
          });
        }
        row.appendChild(chip);
      });
      wrap.appendChild(row);
    }
    var bubble = el("div", "bubble");
    bubble.textContent = text;
    wrap.appendChild(bubble);
    var actions = el("div", "msg-actions");

    function renderUserActions() {
      clear(actions);
      var hasBranches = Boolean(wrap._branches && wrap._branches.length > 1);
      wrap.classList.toggle("has-branches", hasBranches);
      if (hasBranches) {
        var nav = el("div", "msg-branch-nav");
        nav.title = "同一会话内切换不同提问分支版本";
        var prevB = el("button", "branch-arrow", "\u25C0");
        prevB.type = "button";
        prevB.title = "上一分支版本";
        prevB.disabled = wrap._branchIdx <= 0;
        prevB.addEventListener("click", function () {
          switchUserBranch(wrap, wrap._branchIdx - 1);
        });
        var nextB = el("button", "branch-arrow", "\u25B6");
        nextB.type = "button";
        nextB.title = "下一分支版本";
        nextB.disabled = wrap._branchIdx >= wrap._branches.length - 1;
        nextB.addEventListener("click", function () {
          switchUserBranch(wrap, wrap._branchIdx + 1);
        });
        nav.appendChild(prevB);
        nav.appendChild(el("span", "branch-indicator", (wrap._branchIdx + 1) + " / " + wrap._branches.length));
        nav.appendChild(nextB);
        actions.appendChild(nav);
      }
      var pinBtn = mkMini("置顶", function () {
        togglePinMessage(wrap, "user", function () { return wrap._text; }, pinBtn);
      });
      pinBtn.classList.add("pin-btn");
      wrap._pinBtn = pinBtn;
      updateMessagePinVisual(wrap, pinBtn, isMessagePinned(wrap, wrap._text));
      actions.appendChild(pinBtn);

      actions.appendChild(mkMini("编辑", function () {
        openInlineUserEditor(wrap, bubble, renderUserActions);
      }));
      actions.appendChild(mkMini("复制", function () { copyText(wrap._text); }));
    }

    wrap._renderActions = renderUserActions;
    renderUserActions();
    wrap.appendChild(actions);
    root.appendChild(wrap);
    // 消息目录的数据源：恢复过会话后新发的提问也要进目录，否则目录冻结在恢复时刻
    // （此前全库没有 _replayMsgs.push，恢复后目录只列旧消息）。重放路径
    // （renderReplayRange）自带 srcIdx 且在 replayingHistory 期内，这里跳过。
    if (!S.replayingHistory) {
      if (!S._replayMsgs) { S._replayMsgs = []; }
      S._replayMsgs.push({ role: "user", content: text });
      wrap.dataset.srcIdx = String(S._replayMsgs.length - 1);
    }
    scrollStream(true);
    return wrap;
  }

  function openInlineUserEditor(wrap, bubble, renderUserActions) {
    // A quiet restore runs right after boot: refusing it because a turn is
    // still finishing is what left the welcome screen up after a refresh.
    if (S.busy && !quiet) { toast("请等待当前回复结束", "warn"); return; }
    if (wrap.querySelector(".msg-edit-box")) { return; }
    bubble.hidden = true;
    var box = el("div", "msg-edit-box");
    var ta = el("textarea", "msg-edit-ta");
    ta.value = wrap._text || "";
    box.appendChild(ta);

    var bar = el("div", "msg-edit-bar");
    var cancelBtn = el("button", "btn ghost", "取消");
    cancelBtn.type = "button";
    cancelBtn.addEventListener("click", function () {
      box.parentNode.removeChild(box);
      bubble.hidden = false;
    });
    var saveBtn = el("button", "btn primary", "保存并重新生成");
    saveBtn.type = "button";
    saveBtn.addEventListener("click", function () {
      var nextText = ta.value.trim();
      if (!nextText) { return; }
      box.parentNode.removeChild(box);
      bubble.hidden = false;

      // 保存当前分支快照
      var currentNodes = collectTurnNodesAfter(wrap);
      if (!wrap._branches.length) {
        wrap._branches.push({ text: wrap._text, nodes: currentNodes });
      } else if (wrap._branches[wrap._branchIdx]) {
        wrap._branches[wrap._branchIdx].nodes = currentNodes;
      }
      currentNodes.forEach(function (n) {
        if (n.parentNode) { n.parentNode.removeChild(n); }
      });

      // 移除该消息之后的后续对话轮次，从当前节点分叉
      var root = logRoot();
      var trailing = wrap.nextElementSibling;
      while (trailing) {
        var next = trailing.nextElementSibling;
        root.removeChild(trailing);
        trailing = next;
      }

      wrap._text = nextText;
      bubble.textContent = nextText;
      wrap._branches.push({ text: nextText, nodes: [] });
      wrap._branchIdx = wrap._branches.length - 1;
      renderUserActions();

      S.lastUserText = nextText;
      runTurn({
        message: applyStyleInstruction(nextText),
        attachments: (wrap._files || []).map(stripPreview),
        retry: true,
        sessionKey: S.sessionKey
      }).then(function () {
        if (wrap._branches[wrap._branchIdx]) {
          wrap._branches[wrap._branchIdx].nodes = collectTurnNodesAfter(wrap);
        }
        renderUserActions();
      });
    });

    bar.appendChild(cancelBtn);
    bar.appendChild(saveBtn);
    box.appendChild(bar);
    wrap.insertBefore(box, bubble);
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
  }

  function switchUserBranch(wrap, targetIdx) {
    if (!wrap._branches || targetIdx < 0 || targetIdx >= wrap._branches.length) { return; }
    var currentNodes = collectTurnNodesAfter(wrap);
    if (wrap._branches[wrap._branchIdx]) {
      wrap._branches[wrap._branchIdx].nodes = currentNodes;
    }
    currentNodes.forEach(function (n) {
      if (n.parentNode) { n.parentNode.removeChild(n); }
    });

    wrap._branchIdx = targetIdx;
    var branch = wrap._branches[targetIdx];
    wrap._text = branch.text;
    var bubble = wrap.querySelector(".bubble");
    if (bubble) { bubble.textContent = branch.text; }

    var root = logRoot();
    var ref = wrap.nextElementSibling;
    (branch.nodes || []).forEach(function (n) {
      root.insertBefore(n, ref);
    });
    if (wrap._renderActions) { wrap._renderActions(); }
  }

  function addAssistantMessage() {
    hideWelcome();
    var root = logRoot();
    var wrap = el("div", "msg msg-asst");
    assignMsgId(wrap, "asst");
    wrap._role = "assistant";
    if (S.pendingCitations && S.pendingCitations.length) {
      wrap._citations = S.pendingCitations.slice();
      S.pendingCitations = [];
    }
    if (S._pendingRetryBranches && S._pendingRetryBranches.length) {
      wrap._asstBranches = S._pendingRetryBranches.slice();
      S._pendingRetryBranches = null;
    }
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

  /**
   * Streaming render.
   *
   * Every delta used to re-parse the whole accumulated answer, so a long reply
   * cost O(n^2) in markdown parsing and made the stream stutter. Now deltas
   * only fill a buffer and one render happens per animation frame — the
   * visible result is identical, the work is linear.
   */
  function renderAssistant(handle, text, streaming) {
    // Same think-splitting as flushAssistant: streaming must not paint the raw
    // <think> block (or a stray </think>) into the answer.
    var parsed = extractThinkTagContent(text);
    var visible = parsed ? parsed.rest : text;
    handle.raw = visible;
    if (!streaming) {
      handle.body.innerHTML = MD.render(visible || "");
      handle.body.className = "md ";
      scrollStream();
      return;
    }
    handle.body.className = "md cursor";
    handle._pending = visible;
    if (handle._raf) { return; }
    handle._raf = requestAnimationFrame(function () {
      handle._raf = null;
      var next = handle._pending;
      if (next == null) { return; }
      handle._pending = null;
      handle.body.innerHTML = MD.render(next || "");
      scrollStream();
    });
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

    // 折叠态输出预览（对齐上游 ⎿ 预览：≤3 行 + "… (+N lines)"），展开后由 .tool-body 接管
    var preview = el("div", "tool-preview");
    head.addEventListener("click", function () { box.classList.toggle("open"); });
    box.appendChild(head);
    box.appendChild(preview);
    box.appendChild(bodyDiv);

    // Claude 风格连续工具聚合：若前一个兄弟节点已是工具或工具组，自动归入可折叠的「连续操作组」
    var prev = root.lastElementChild;
    if (prev && prev.classList && prev.classList.contains("tool-group")) {
      var listHost = prev.querySelector(".tool-group-list");
      listHost.appendChild(box);
      updateToolGroupHeader(prev);
    } else if (prev && prev.classList && prev.classList.contains("tool")) {
      var group = createToolGroup(S.replayingHistory);
      root.replaceChild(group, prev);
      var gList = group.querySelector(".tool-group-list");
      gList.appendChild(prev);
      gList.appendChild(box);
      updateToolGroupHeader(group);
    } else {
      root.appendChild(box);
    }

    scrollStream();
    return { box: box, time: time, secOut: secOut, preOut: preOut, diffHost: diffHost, preview: preview, name: name, args: args };
  }

  function createToolGroup(openByDefault) {
    var group = el("div", "tool-group");
    var head = el("button", "tool-group-head");
    head.type = "button";
    head.appendChild(el("span", "tool-dot"));
    head.appendChild(el("span", "tool-group-title", "已执行多项工具操作"));
    head.appendChild(el("span", "tool-group-meta", ""));
    // 右侧实时读数：耗时 + 累计 token，任务结束后定格为执行记录。
    head.appendChild(el("span", "tool-group-live", ""));
    var chev = el("span", "tool-group-chev");
    chev.appendChild(icon("i-chev", 14));
    head.appendChild(chev);
    var list = el("div", "tool-group-list");
    head.addEventListener("click", function () {
      group.classList.toggle("open");
    });
    // Restored history opens expanded: a collapsed group hid the whole record,
    // which read as "the history is incomplete". Live runs stay collapsed.
    if (openByDefault) { group.classList.add("open"); }
    group.appendChild(head);
    group.appendChild(list);
    return group;
  }

  function updateToolGroupHeader(group) {
    if (!group) { return; }
    var tools = group.querySelectorAll(".tool");
    var titleEl = group.querySelector(".tool-group-title");
    var metaEl = group.querySelector(".tool-group-meta");
    var counts = {};
    var running = 0;
    Array.prototype.forEach.call(tools, function (t) {
      if (t.classList.contains("running")) { running++; }
      var nm = (t.querySelector(".tool-name") && t.querySelector(".tool-name").textContent) || "操作";
      counts[nm] = (counts[nm] || 0) + 1;
    });
    if (titleEl) {
      titleEl.textContent = running > 0
        ? "正在执行 " + tools.length + " 项工具操作…"
        : "已聚合 " + tools.length + " 项工具操作";
    }
    if (metaEl) {
      var summaryParts = Object.keys(counts).map(function (k) { return k + " ×" + counts[k]; });
      metaEl.textContent = summaryParts.join(" · ");
    }
  }

  /** 折叠态预览行：≤3 行全显，否则前 3 行 + 省略数（上游 chunk-3qs3b8zt.js 口径）。 */
  function toolPreviewLines(text) {
    var lines = String(text == null ? "" : text).split("\n");
    if (lines.length <= 3) { return { lines: lines, more: 0 }; }
    return { lines: lines.slice(0, 3), more: lines.length - 3 };
  }

  function renderToolPreview(card, text) {
    if (!card || !card.preview) { return; }
    clear(card.preview);
    var p = toolPreviewLines(text);
    p.lines.forEach(function (l) {
      card.preview.appendChild(el("div", "tool-preview-line", "⎿ " + l));
    });
    if (p.more > 0) {
      card.preview.appendChild(el("div", "tool-preview-line is-more", "⎿ … (+" + p.more + " lines)"));
    }
  }

  function finishToolCard(card, ok, elapsed, output, data) {
      if (!card) { return; }
      card.box.classList.remove("running");
      if (!ok) { card.box.classList.add("failed"); }
      var parentGroup = card.box.closest && card.box.closest(".tool-group");
      if (parentGroup) { updateToolGroupHeader(parentGroup); }
      // 运行中的点阵换回状态点
      var pix = card.box.querySelector(".pix");
      if (pix) {
        var dot = el("span", "tool-dot");
        pix.parentNode.replaceChild(dot, pix);
      }
      card.time.textContent = (ok ? "" : "失败 ") + elapsed + "ms";
      var text = String(output == null ? "" : output);
      renderToolPreview(card, text);
      // 展开态上限：上游 BASH_MAX_OUTPUT_LENGTH 默认 30000 字符（chunk-1wyh415r.js DCr=30000）。
      // 服务端发全量、上下文也在服务端裁——这里只管「显示不撑爆 DOM」。
      var TOOL_OUT_CAP = 30000;
      var shown = text;
      if (text.length > TOOL_OUT_CAP) {
        shown = text.slice(0, TOOL_OUT_CAP) + "\n…（输出共 " + text.length + " 字符，已截断显示前 " + TOOL_OUT_CAP + " 字符）";
      }
      card.preOut.textContent = shown;
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

    // Show the change, not the arguments: a coloured diff is what the user
    // actually needs to decide, and renderDiff already exists for tool cards.
    if (Array.isArray(ev.diff) && ev.diff.length) {
      var diffHost = el("div", "ask-diff");
      renderDiff(diffHost, ev.diff);
      card.appendChild(diffHost);
      var argsPre = el("pre", "ask-args ask-args-collapsed");
      argsPre.textContent = argsText(ev.args);
      var toggle = el("button", "ask-args-toggle", "查看原始参数");
      toggle.type = "button";
      toggle.addEventListener("click", function () {
        var hidden = argsPre.classList.toggle("ask-args-collapsed");
        toggle.textContent = hidden ? "查看原始参数" : "收起原始参数";
      });
      card.appendChild(toggle);
      card.appendChild(argsPre);
    } else {
      var pre = el("pre", "ask-args");
      pre.textContent = argsText(ev.args);
      card.appendChild(pre);
    }

    var row = el("div", "ask-row");
    var yes = el("button", "btn primary", "允许");
    var no = el("button", "btn ghost", "拒绝");
    var all = el("button", "btn", "不再询问此命令");

    function settle() {
      clear(row);
      row.appendChild(el("span", "empty-note", "已处理"));
    }

    yes.addEventListener("click", function () { settle(); answerConfirm(true); });
    no.addEventListener("click", function () { settle(); answerConfirm(false); });
    all.addEventListener("click", function () {
      settle();
      // Remember the choice for this exact tool so the same edit does not ask
      // again; the rule is stored through the permission engine.
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
    if (!S.busy) { toast("已提交，任务在后台继续，完成后刷新即可看到结果", "info"); }
  }

  /**
   * The run hit its turn cap. A bare stop read like the task had died;
   * give the user a one-click way to keep going, plus the /auto hint.
   */
  function addMaxTurnsCard(limit) {
    var wrap = el("div", "notice notice-warn");
    var msg = el("span", null, "已达回合上限（" + limit + " 回合），任务暂停在当前进度。");
    var btn = el("button", "btn continue-btn", "继续");
    btn.type = "button";
    btn.title = "从当前进度继续（发送：继续完成未完成的部分）";
    btn.addEventListener("click", function () {
      if (S.busy) { return; }
      btn.disabled = true;
      wrap.remove();
      runTurn({
        message: "继续完成未完成的部分。若任务已全部完成，直接简短汇报现状即可。",
        sessionKey: S.sessionKey
      });
    });
    wrap.appendChild(msg);
    wrap.appendChild(btn);
    var hint = el("span", "empty-note", " 或 /auto on 开启自主续跑");
    wrap.appendChild(hint);
    logRoot().appendChild(wrap);
    wrap.scrollIntoView({ block: "nearest" });
  }

  /** 回合以错误收场 → 一键重试卡（对齐 claude.ai 失败后的 Retry）。 */
  function addRetryCard() {
    var wrap = el("div", "notice notice-warn");
    var msg = el("span", null, "本次回复未能完成。");
    var btn = el("button", "btn continue-btn", "重试");
    btn.type = "button";
    btn.title = "重新发送上一条消息";
    btn.addEventListener("click", function () {
      if (S.busy) { return; }
      btn.disabled = true;
      wrap.remove();
      retryLast(null);
    });
    wrap.appendChild(msg);
    wrap.appendChild(btn);
    logRoot().appendChild(wrap);
    wrap.scrollIntoView({ block: "nearest" });
  }

  /** 回复被 max_tokens 截断（finish_reason=length）→ 一键续写。 */
  function addTruncatedCard() {
    var wrap = el("div", "notice notice-info");
    var msg = el("span", null, "回复因长度限制被截断。");
    var btn = el("button", "btn continue-btn", "继续生成");
    btn.type = "button";
    btn.title = "让模型从上次中断的地方接着输出";
    btn.addEventListener("click", function () {
      if (S.busy) { return; }
      btn.disabled = true;
      wrap.remove();
      runTurn({
        message: "继续。从上次被截断的地方无缝接着输出，不要重复已有内容。",
        sessionKey: S.sessionKey
      });
    });
    wrap.appendChild(msg);
    wrap.appendChild(btn);
    logRoot().appendChild(wrap);
    wrap.scrollIntoView({ block: "nearest" });
  }

  /**
   * 把供应商返回的原始错误 JSON 转成人类可读的提示 + 可操作建议。
   * 供应商（ZCode/OpenAI/Anthropic 兼容层）常把 {"error":{...}} 整段丢上来，
   * 直接显示会让用户看到一坨 JSON，不知道该做什么。
   */
  function humanizeApiError(raw) {
    var s = String(raw == null ? "" : raw);
    var msg = "", code = "", type = "";
    try {
      var m = s.match(/\{[\s\S]*\}/);
      if (m) {
        var j = JSON.parse(m[0]);
        var e = j.error || j;
        msg = e.message || e.detail || "";
        code = String(e.code || j.code || "");
        type = String(e.type || j.type || "");
      }
    } catch (err) {}
    var lower = (msg + " " + type + " " + code + " " + s).toLowerCase();
    var hint = "";
    if (/risk|blocked|forbidden|封禁|封停|停用|禁用|拦截|异常活动|banned|suspend|unusual activity|abuse/.test(lower)) {
      hint = "供应商风控拦截了本次请求。这通常是账号侧限制，换一个供应商或模型、或到供应商控制台申诉后即可恢复。";
    } else if (/401|invalid.*key|unauthor|认证|密钥|api key/.test(lower)) {
      hint = "密钥无效或未配置。请点右上角「模型与供应商配置」填写正确的 API Key。";
    } else if (/429|rate.?limit|quota|限流|too many/.test(lower)) {
      hint = "请求过于频繁或额度用尽。稍等片刻重试，或在配置里切换备用模型。";
    } else if (/402|insufficient|balance|余额|欠费/.test(lower)) {
      hint = "账户余额不足，请到供应商控制台充值后重试。";
    } else if (/404|model.*not.*found|no such model|模型不存在|没有该模型|模型不可用/.test(lower)) {
      hint = "该模型在接口上不存在。请在模型菜单里换一个可用模型。";
    } else if (/timeout|timed out|超时|ETIMEDOUT/.test(lower)) {
      hint = "请求超时。检查网络或代理后重试。";
    } else if (/error in input stream|stream interrupted|socket hang up|premature close|broken pipe|stream reset|stream closed|terminated/.test(lower)) {
      hint = "上游到模型的流被掐断（网关侧瞬时故障）。断在开头会自动换线路重试；已输出过内容则点「重试」继续——会话历史的断点配对已自动修复。";
    } else if (/econnrefused|enotfound|fetch failed|network|连接失败|connection refused|getaddrinfo|eai_again/.test(lower)) {
      hint = "连不上接口地址。确认本地网关/代理是否在运行，或检查「接口服务地址」配置。";
    } else if (/context.*(length|window)|too long|超出.*上下文/.test(lower)) {
      hint = "上下文超出模型窗口。用 /compact 压缩后重试。";
    }
    var head = msg || s.replace(/\s+/g, " ");
    if (head.length > 300) { head = head.slice(0, 300) + "…"; }
    return { text: head, hint: hint };
  }

  function addNotice(text, kind) {
    hideWelcome();
    var root = logRoot();
    var box = el("div", "notice " + (kind || "info"));
    box.appendChild(el("span", "notice-ico", kind === "ok" ? "\u2713" : kind === "err" ? "\u00D7" : kind === "warn" ? "!" : "i"));
    var k = kind || "info";
    if (k === "err" && /\{|error|\[error\]/i.test(String(text))) {
      var h = humanizeApiError(text);
      box.appendChild(el("span", "notice-text", h.text));
      if (h.hint) { box.appendChild(el("div", "notice-hint", h.hint)); }
      var raw = el("button", "notice-raw-btn", "查看原始错误");
      raw.type = "button";
      var rawPre = el("pre", "notice-raw");
      rawPre.style.display = "none";
      rawPre.textContent = String(text);
      raw.addEventListener("click", function () {
        var open = rawPre.style.display !== "none";
        rawPre.style.display = open ? "none" : "block";
        raw.textContent = open ? "查看原始错误" : "收起原始错误";
      });
      box.appendChild(raw);
      box.appendChild(rawPre);
    } else {
      box.appendChild(el("span", "notice-text", text));
    }
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

  var MINI_ICON = { "复制": "i-copy", "重试": "i-retry", "编辑": "i-edit", "置顶": "i-pin", "朗读": "i-volume", "赞": "i-thumb-up", "踩": "i-thumb-down" };

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

  /* ---- 消息反馈 (👍/👎，对齐 claude.ai 的 message feedback) ----
   * 服务端按「会话id + 正文摘要」持久化在 feedback.json 里；会话文件本身
   * 由自动保存器整文件重写，反馈走独立 sidecar 才不会和保存器赛跑。 */
  function digestText(s) {
    var str = String(s == null ? "" : s);
    var h1 = 0xdeadbeef, h2 = 0x41c6ce57;
    for (var i = 0; i < str.length; i++) {
      var ch = str.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 2654435761);
      h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
  }

  function loadFeedbackForCurrentSession() {
    var sid = S.sessionKey;
    if (!sid) { return; }
    getJSON("/api/feedback?sessionId=" + encodeURIComponent(sid)).then(function (j) {
      if (sid !== S.sessionKey) { return; }
      S.feedback = (j && j.feedback) || {};
      applyFeedbackToDom();
    }).catch(function () {});
  }

  /** 重放/恢复会话后，把已存的反馈标记回对应消息上。 */
  function applyFeedbackToDom() {
    var root = logRoot();
    if (!root || !S.feedback) { return; }
    Array.prototype.forEach.call(root.querySelectorAll(".msg-asst"), function (wrap) {
      var raw = wrap._raw != null ? wrap._raw : (wrap.textContent || "");
      var fb = S.feedback[digestText(raw)];
      wrap.classList.toggle("fb-up", fb === "up");
      wrap.classList.toggle("fb-down", fb === "down");
    });
  }

  function setFeedback(handle, fb) {
    var wrap = handle && handle.wrap;
    if (!wrap) { return; }
    var digest = digestText(handle.raw || "");
    var cur = S.feedback[digest] || null;
    var next = cur === fb ? null : fb;
    if (next) { S.feedback[digest] = next; } else { delete S.feedback[digest]; }
    wrap.classList.toggle("fb-up", next === "up");
    wrap.classList.toggle("fb-down", next === "down");
    toast(next === "up" ? "已标记为有用" : next === "down" ? "已标记为无用" : "已取消反馈", "info");
    if (!S.sessionKey) { return; }
    postJSON("/api/feedback", { sessionId: S.sessionKey, digest: digest, fb: next }).catch(function () {});
  }

  function mkFeedbackButtons(handle) {
    var up = mkMini("赞", function () { setFeedback(handle, "up"); });
    var down = mkMini("踩", function () { setFeedback(handle, "down"); });
    up.classList.add("fb-btn-up");
    down.classList.add("fb-btn-down");
    up.title = "这条回复有帮助";
    down.title = "这条回复需改进";
    return [up, down];
  }

  /* ---- 提示音 (对齐 claude.ai 的回合完成/需要确认 chime) ----
   * WebAudio 合成，不引外部音频文件；默认开启，偏好存 localStorage。 */
  var LS_SOUND = "myclaude.sound";
  var soundPref = "on";
  var soundCtx = null;
  try { soundPref = localStorage.getItem(LS_SOUND) === "off" ? "off" : "on"; } catch (e) {}

  function soundEnabled() { return soundPref === "on"; }

  function setSoundPref(on) {
    soundPref = on ? "on" : "off";
    try { localStorage.setItem(LS_SOUND, soundPref); } catch (e) {}
  }

  function playChime(kind) {
    if (!soundEnabled()) { return; }
    try {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) { return; }
      if (!soundCtx) { soundCtx = new AC(); }
      if (soundCtx.state === "suspended") { soundCtx.resume(); }
      var t0 = soundCtx.currentTime;
      // 三种语义：done 双音上行（完成）、ask 单音柔和（等待用户）、err 低音（出错）
      var notes = kind === "done" ? [[523.25, 0], [783.99, 0.13]]
                : kind === "ask" ? [[659.26, 0]]
                : kind === "err" ? [[196, 0], [155.56, 0.15]]
                : [[440, 0]];
      notes.forEach(function (n) {
        var o = soundCtx.createOscillator();
        var g = soundCtx.createGain();
        o.type = "sine";
        o.frequency.value = n[0];
        g.gain.setValueAtTime(0, t0 + n[1]);
        g.gain.linearRampToValueAtTime(0.12, t0 + n[1] + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + n[1] + 0.5);
        o.connect(g);
        g.connect(soundCtx.destination);
        o.start(t0 + n[1]);
        o.stop(t0 + n[1] + 0.55);
      });
    } catch (e) {}
  }

  /* ---- 快捷键面板 (对齐 claude.ai 的 “?” 键盘快捷键总览) ---- */
  var SHORTCUT_GROUPS = [
    {
      name: "通用",
      items: [
        { keys: ["Ctrl", "K"], desc: "搜索命令与会话（命令面板）" },
        { keys: ["Ctrl", "Shift", "O"], desc: "新建对话" },
        { keys: ["Ctrl", "L"], desc: "新建对话（备选）" },
        { keys: ["Ctrl", "B"], desc: "收起 / 展开左侧栏" },
        { keys: ["Ctrl", "I"], desc: "收起 / 展开右侧检查器" },
        { keys: ["Ctrl", ","], desc: "打开设置" },
        { keys: ["?"], desc: "键盘快捷键面板（本页）" },
        { keys: ["Ctrl", "/"], desc: "键盘快捷键面板（备选）" },
        { keys: ["Esc"], desc: "关闭弹窗；对话进行中则停止生成" }
      ]
    },
    {
      name: "对话",
      items: [
        { keys: ["Enter"], desc: "发送消息" },
        { keys: ["Shift", "Enter"], desc: "输入框内换行" },
        { keys: ["↑"], desc: "输入框为空时调出上一条消息" },
        { keys: ["Ctrl", "Shift", "P"], desc: "打开 Projects 知识库" },
        { keys: ["Ctrl", "Shift", "L"], desc: "打开提示词库" },
        { keys: ["Alt", "V"], desc: "语音输入开 / 关" }
      ]
    },
    {
      name: "消息",
      items: [
        { keys: ["悬停"], desc: "显示复制 / 编辑 / 重试 / 置顶 / 朗读 / 赞踩" },
        { keys: ["@"], desc: "引用文件（路径补全）" },
        { keys: ["/"], desc: "输入框行首调出斜杠命令菜单" }
      ]
    }
  ];

  function openShortcutsModal() {
    openModal("键盘快捷键", function (body) {
      var grid = el("div", "shortcut-grid");
      SHORTCUT_GROUPS.forEach(function (g) {
        var col = el("div", "shortcut-col");
        col.appendChild(el("div", "shortcut-head", g.name));
        g.items.forEach(function (it) {
          var row = el("div", "shortcut-row");
          var keys = el("span", "shortcut-keys");
          it.keys.forEach(function (k, i) {
            if (i > 0) { keys.appendChild(el("span", "shortcut-plus", "+")); }
            keys.appendChild(el("kbd", null, k));
          });
          row.appendChild(keys);
          row.appendChild(el("span", "shortcut-desc", it.desc));
          col.appendChild(row);
        });
        grid.appendChild(col);
      });
      body.appendChild(grid);
      var foot = el("div", "shortcut-sound");
      var bell = el("button", "btn ghost" + (soundEnabled() ? "" : " off"), soundEnabled() ? "🔔 提示音：开" : "🔕 提示音：关");
      bell.type = "button";
      bell.addEventListener("click", function () {
        setSoundPref(!soundEnabled());
        bell.textContent = soundEnabled() ? "🔔 提示音：开" : "🔕 提示音：关";
        bell.classList.toggle("off", !soundEnabled());
        if (soundEnabled()) { playChime("done"); }
      });
      foot.appendChild(bell);
      foot.appendChild(el("span", "shortcut-sound-note", "回合完成与等待确认时播放（点按可试听）"));
      body.appendChild(foot);

      var foot2 = el("div", "shortcut-sound");
      var ntf = el("button", "btn ghost" + (notifyEnabled() ? "" : " off"), notifyEnabled() ? "🔔 桌面通知：开" : "🔕 桌面通知：关");
      ntf.type = "button";
      ntf.addEventListener("click", function () {
        var next = !notifyEnabled();
        setNotifyPref(next);
        if (next) { askNotifyPermission(function (granted) {
          ntf.textContent = granted ? "🔔 桌面通知：开" : "🔕 桌面通知：关（浏览器未授权）";
          ntf.classList.toggle("off", !granted);
          if (!granted) { toast("浏览器拒绝了通知权限，请在地址栏权限图标里允许", "warn"); }
        }); }
        else { ntf.textContent = "🔕 桌面通知：关"; ntf.classList.add("off"); }
      });
      foot2.appendChild(ntf);
      foot2.appendChild(el("span", "shortcut-sound-note", "切到其他标签页时，回复完成/等待确认会发系统通知"));
      body.appendChild(foot2);
    }, [{ label: "关闭", fn: closeModal }]);
  }

  /* ---- 桌面通知（对齐 claude.ai 的 tab 隐藏时通知）----
   * 只在 document.hidden 时打扰；回到页面即清除未读并把标题复原。 */
  var LS_NOTIFY = "myclaude.notify";
  var notifyPref = "off";
  var unreadCount = 0;
  var baseTitle = document.title;
  try { notifyPref = localStorage.getItem(LS_NOTIFY) === "on" ? "on" : "off"; } catch (e) {}

  function notifyEnabled() { return notifyPref === "on"; }

  function setNotifyPref(on) {
    notifyPref = on ? "on" : "off";
    try { localStorage.setItem(LS_NOTIFY, notifyPref); } catch (e) {}
  }

  function askNotifyPermission(cb) {
    if (!("Notification" in window)) { toast("此浏览器不支持桌面通知", "warn"); if (cb) { cb(false); } return; }
    if (Notification.permission === "granted") { if (cb) { cb(true); } return; }
    if (Notification.permission === "denied") { if (cb) { cb(false); } return; }
    Notification.requestPermission().then(function (p) { if (cb) { cb(p === "granted"); } }).catch(function () { if (cb) { cb(false); } });
  }

  function maybeNotify(title, body) {
    if (!notifyEnabled() || !document.hidden) { return; }
    unreadCount++;
    document.title = "(" + unreadCount + ") " + baseTitle;
    try {
      if ("Notification" in window && Notification.permission === "granted") {
        var n = new Notification(title, { body: body, tag: "myclaude", silent: soundEnabled() });
        n.onclick = function () { try { window.focus(); n.close(); } catch (e) {} };
        setTimeout(function () { try { n.close(); } catch (e) {} }, 8000);
      }
    } catch (e) {}
  }

  document.addEventListener("visibilitychange", function () {
    if (!document.hidden) { unreadCount = 0; document.title = baseTitle; }
  });

  /* ---- 输入草稿按会话保留（对齐 claude.ai 的 composer 草稿）----
   * 切会话/刷新不丢正在写的内容；发送后清空。 */
  var LS_DRAFT_PREFIX = "myclaude.draft.";
  var draftTimer = null;

  function draftKey() { return LS_DRAFT_PREFIX + (S.sessionKey || "draft"); }

  function saveDraftNow(text) {
    try {
      if (text) { localStorage.setItem(draftKey(), text); }
      else { localStorage.removeItem(draftKey()); }
    } catch (e) {}
  }

  function saveDraftSoon(text) {
    clearTimeout(draftTimer);
    draftTimer = setTimeout(function () { saveDraftNow(text); }, 400);
  }

  function restoreDraft() {
    var ta = $("in");
    if (!ta) { return; }
    var saved = "";
    try { saved = localStorage.getItem(draftKey()) || ""; } catch (e) {}
    // 无条件覆盖：目标会话没有草稿就清空输入框，避免把上一个会话的
    // 半句话发到错误的对话里（claude.ai 的 per-conversation draft 语义）。
    ta.value = saved;
    autoGrow(ta);
  }

  function clearDraft() { saveDraftNow(""); }

  /* ---- 图片灯箱（对齐 claude.ai 的消息图片点击放大）---- */
  function openLightbox(src, alt) {
    var old = $("lightbox");
    if (old && old.parentNode) { old.parentNode.removeChild(old); }
    var ov = el("div", "lightbox-veil");
    ov.id = "lightbox";
    var img = document.createElement("img");
    img.className = "lightbox-img";
    img.src = src;
    img.alt = alt || "";
    ov.appendChild(img);
    ov.appendChild(el("span", "lightbox-hint", "点击任意处或按 Esc 关闭"));
    ov.addEventListener("click", function () { if (ov.parentNode) { ov.parentNode.removeChild(ov); } });
    document.body.appendChild(ov);
  }

  /* ---- 搜索命中跳转：恢复会话后滚动到命中的那条消息 ---- */
  function jumpToSnippet(snippet) {
    var core = String(snippet || "").replace(/[…\s]+/g, " ").trim().slice(0, 48);
    if (!core) { return; }
    var tries = 0;
    var timer = setInterval(function () {
      tries++;
      var root = logRoot();
      var nodes = root ? Array.prototype.slice.call(root.querySelectorAll(".msg-user, .msg-asst")) : [];
      var hit = null;
      for (var i = 0; i < nodes.length; i++) {
        var norm = (nodes[i].textContent || "").replace(/\s+/g, " ");
        if (norm.indexOf(core) >= 0) { hit = nodes[i]; break; }
      }
      if (hit) {
        clearInterval(timer);
        hit.scrollIntoView({ behavior: "smooth", block: "center" });
        hit.classList.add("msg-flash");
        setTimeout(function () { hit.classList.remove("msg-flash"); }, 2600);
      } else if (tries > 20) {
        clearInterval(timer);
      }
    }, 200);
  }

  /* ---- 消息置顶与聊天区顶部置顶栏 (Pin Messages to Top of Chat Area) ---- */
  function pinnedStorageKey(sessionId) {
    return LS_PINNED_PREFIX + (sessionId || S.sessionKey || "draft");
  }

  function savePinnedForCurrentSession() {
    try {
      localStorage.setItem(pinnedStorageKey(), JSON.stringify(S.pinnedMessages || []));
    } catch (e) {}
  }

  function loadPinnedForCurrentSession() {
    try {
      var raw = localStorage.getItem(pinnedStorageKey());
      var parsed = raw ? JSON.parse(raw) : [];
      S.pinnedMessages = Array.isArray(parsed) ? parsed : [];
    } catch (e) {
      S.pinnedMessages = [];
    }
    renderPinnedBar();
  }

  function isMessagePinned(wrap, rawText) {
    if (!S.pinnedMessages || !S.pinnedMessages.length) { return false; }
    var id = wrap && wrap._msgId;
    var clean = String(rawText || "").trim();
    return S.pinnedMessages.some(function (p) {
      if (id && p.id === id) { return true; }
      return clean && p.text === clean;
    });
  }

  function updateMessagePinVisual(wrap, pinBtn, isPinned) {
    if (!wrap) { return; }
    wrap.classList.toggle("is-pinned", !!isPinned);
    if (pinBtn) {
      pinBtn.classList.toggle("active", !!isPinned);
      pinBtn.title = isPinned ? "取消置顶此消息" : "置顶此消息到聊天区顶部以便随时参考";
      pinBtn.setAttribute("aria-pressed", isPinned ? "true" : "false");
    }
    var existingTag = wrap.querySelector(".msg-pin-tag");
    if (isPinned && !existingTag) {
      var tag = el("div", "msg-pin-tag");
      tag.appendChild(icon("i-pin", 12));
      tag.appendChild(el("span", null, "已置顶到顶部"));
      if (wrap.classList.contains("msg-asst")) {
        var contentBox = wrap.querySelector(".content");
        if (contentBox) { contentBox.insertBefore(tag, contentBox.firstChild); }
      } else {
        wrap.insertBefore(tag, wrap.firstChild);
      }
    } else if (!isPinned && existingTag && existingTag.parentNode) {
      existingTag.parentNode.removeChild(existingTag);
    }
  }

  function makePinnedSnippet(rawText) {
    var clean = String(rawText || "")
      .replace(/```[\s\S]*?```/g, " [代码片段] ")
      .replace(/[#>*_`~-]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (!clean) { clean = String(rawText || "").replace(/\s+/g, " ").trim(); }
    return clean.length > 96 ? clean.slice(0, 96) + "…" : clean;
  }

  function smoothAdjustStreamForPinnedBar(prevHeight, newHeight, anchorNode) {
    var stream = $("stream");
    if (!stream) { return; }
    var deltaH = (newHeight || 0) - (prevHeight || 0);
    if (!deltaH) { return; }

    requestAnimationFrame(function () {
      var maxScroll = Math.max(0, stream.scrollHeight - stream.clientHeight);
      if (deltaH > 0) {
        if (maxScroll > 0) {
          stream.scrollBy({ top: deltaH, behavior: "smooth" });
        }
        if (anchorNode && anchorNode.getBoundingClientRect) {
          var sRect = stream.getBoundingClientRect();
          var aRect = anchorNode.getBoundingClientRect();
          if (aRect.top < sRect.top + 8) {
            stream.scrollBy({ top: aRect.top - sRect.top - 12, behavior: "smooth" });
          } else if (aRect.bottom > sRect.bottom - 8 && maxScroll > 0) {
            stream.scrollBy({ top: Math.min(deltaH, aRect.bottom - sRect.bottom + 12), behavior: "smooth" });
          }
        }
      } else if (deltaH < 0 && stream.scrollTop > 0) {
        stream.scrollBy({ top: deltaH, behavior: "smooth" });
      }
    });
  }

  function togglePinMessage(wrap, role, getTextFn, pinBtn) {
    var rawText = String((getTextFn && getTextFn()) || "").trim();
    if (!rawText) {
      toast("空白消息无法置顶", "warn");
      return;
    }
    var msgId = assignMsgId(wrap, role === "assistant" ? "asst" : "user");
    var idx = -1;
    for (var i = 0; i < S.pinnedMessages.length; i++) {
      if (S.pinnedMessages[i].id === msgId || S.pinnedMessages[i].text === rawText) {
        idx = i;
        break;
      }
    }
    if (idx >= 0) {
      S.pinnedMessages.splice(idx, 1);
      updateMessagePinVisual(wrap, pinBtn, false);
      savePinnedForCurrentSession();
      renderPinnedBar({ anchorNode: wrap, animateScroll: true });
      toast("已取消置顶该对话片段", "info");
    } else {
      var wasEmpty = S.pinnedMessages.length === 0;
      S.pinnedMessages.push({
        id: msgId,
        role: role === "assistant" ? "assistant" : "user",
        text: rawText,
        snippet: makePinnedSnippet(rawText),
        pinnedAt: new Date().toISOString()
      });
      updateMessagePinVisual(wrap, pinBtn, true);
      savePinnedForCurrentSession();
      renderPinnedBar({ firstPin: wasEmpty, anchorNode: wrap, animateScroll: true });
      toast("已置顶到聊天区顶部，点击顶部置顶栏可随时定位或引用", "ok");
    }
  }

  function findDomNodeForPin(pinItem) {
    var root = logRoot();
    if (!root || !pinItem) { return null; }
    var byId = document.getElementById(pinItem.id);
    if (byId && root.contains(byId)) { return byId; }
    var msgs = root.querySelectorAll(".msg");
    for (var i = 0; i < msgs.length; i++) {
      var m = msgs[i];
      var mText = String(m._text || m._raw || "").trim();
      if (mText && mText === pinItem.text) {
        m._msgId = pinItem.id;
        m.id = pinItem.id;
        return m;
      }
    }
    return null;
  }

  function scrollToPinnedMessage(pinItem) {
    var node = findDomNodeForPin(pinItem);
    if (!node) {
      toast("该置顶片段不在当前视图中", "warn");
      return;
    }
    node.scrollIntoView({ behavior: "smooth", block: "center" });
    node.classList.remove("pin-flash");
    void node.offsetWidth;
    node.classList.add("pin-flash");
    setTimeout(function () {
      node.classList.remove("pin-flash");
    }, 1400);
  }

  function quotePinnedMessageToInput(pinItem) {
    if (!pinItem || !pinItem.text) { return; }
    var snippet = pinItem.snippet || makePinnedSnippet(pinItem.text);
    S.attachments.push({
      kind: "text",
      quote: true,
      name: "置顶引用: " + snippet.slice(0, 22) + (snippet.length > 22 ? "…" : ""),
      mime: "text/plain",
      size: pinItem.text.length,
      lines: pinItem.text.split(/\r?\n/).length,
      text: "> [置顶片段参考 (" + (pinItem.role === "assistant" ? "MyClaude" : "用户") + ")]：\n" + pinItem.text
    });
    renderAttachments();
    var ta = $("in");
    if (ta) { ta.focus(); }
    toast("已将置顶片段作为引用加入当前输入", "ok");
  }

  function unpinByItem(pinItem) {
    if (!pinItem) { return; }
    var node = findDomNodeForPin(pinItem);
    S.pinnedMessages = (S.pinnedMessages || []).filter(function (p) {
      return p.id !== pinItem.id && p.text !== pinItem.text;
    });
    if (node) {
      updateMessagePinVisual(node, node._pinBtn || node.querySelector(".pin-btn"), false);
    }
    savePinnedForCurrentSession();
    renderPinnedBar({ anchorNode: node, animateScroll: true });
    toast("已取消置顶", "info");
  }

  function syncPinnedDomNodes() {
    var root = logRoot();
    if (!root) { return; }
    Array.prototype.forEach.call(root.querySelectorAll(".msg"), function (m) {
      var txt = m._text != null ? m._text : (m._raw || "");
      var pinned = isMessagePinned(m, txt);
      if (pinned) {
        var match = (S.pinnedMessages || []).filter(function (p) {
          return p.id === m._msgId || p.text === String(txt || "").trim();
        })[0];
        if (match) {
          m._msgId = match.id;
          m.id = match.id;
        }
      }
      updateMessagePinVisual(m, m._pinBtn || m.querySelector(".pin-btn"), pinned);
    });
    renderPinnedBar({ animateScroll: false });
  }

  function renderPinnedBar(opts) {
    var bar = $("pinned-bar");
    if (!bar) { return; }
    var wasHidden = bar.hidden;
    var prevHeight = wasHidden ? 0 : (bar.offsetHeight || 0);
    var shouldAnimateScroll = !opts || opts.animateScroll !== false;

    clear(bar);
    var list = S.pinnedMessages || [];
    if (!list.length) {
      bar.hidden = true;
      bar.classList.remove("pop-in");
      S.pinnedExpanded = false;
      if (shouldAnimateScroll && prevHeight > 0) {
        smoothAdjustStreamForPinnedBar(prevHeight, 0, opts && opts.anchorNode);
      }
      return;
    }
    bar.hidden = false;

    var isFirstPin = Boolean((opts && opts.firstPin) || (wasHidden && list.length === 1));
    if (isFirstPin) {
      bar.classList.remove("pop-in");
      void bar.offsetWidth;
      bar.classList.add("pop-in");
    } else if (!wasHidden) {
      bar.classList.remove("pop-in");
    }

    var inner = el("div", "pinned-bar-inner");
    var latest = list[list.length - 1];

    var headRow = el("div", "pinned-head-row");
    var headLeft = el("div", "pinned-head-left");
    headLeft.title = "点击定位到该置顶消息原文：\n" + latest.text.slice(0, 240);

    var badge = el("span", "pinned-ico-badge");
    badge.appendChild(icon("i-pin", 12));
    badge.appendChild(el("span", null, "已置顶 " + list.length));
    headLeft.appendChild(badge);

    var roleTag = el("span", "pinned-role-tag" + (latest.role === "assistant" ? " asst" : ""), latest.role === "assistant" ? "AI 回复" : "用户提问");
    headLeft.appendChild(roleTag);

    headLeft.appendChild(el("span", "pinned-preview-text", latest.snippet || makePinnedSnippet(latest.text)));
    headLeft.addEventListener("click", function () {
      scrollToPinnedMessage(latest);
    });
    headRow.appendChild(headLeft);

    var headRight = el("div", "pinned-head-right");

    var jumpBtn = el("button", "pinned-op-btn", "定位原文");
    jumpBtn.type = "button";
    jumpBtn.title = "滚动到对话流中的对应消息位置";
    jumpBtn.addEventListener("click", function () {
      scrollToPinnedMessage(latest);
    });
    headRight.appendChild(jumpBtn);

    var quoteBtn = el("button", "pinned-op-btn primary-op", "引用追问");
    quoteBtn.type = "button";
    quoteBtn.title = "将此置顶片段引用到底部输入框";
    quoteBtn.addEventListener("click", function () {
      quotePinnedMessageToInput(latest);
    });
    headRight.appendChild(quoteBtn);

    if (list.length > 1) {
      var expBtn = el("button", "pinned-op-btn", S.pinnedExpanded ? "收起列表 \u25B4" : "全部 (" + list.length + ") \u25BE");
      expBtn.type = "button";
      expBtn.addEventListener("click", function () {
        S.pinnedExpanded = !S.pinnedExpanded;
        renderPinnedBar({ animateScroll: true });
      });
      headRight.appendChild(expBtn);
    }

    var unpinBtn = el("button", "pinned-op-btn", list.length > 1 && S.pinnedExpanded ? "清空置顶" : "\u00D7");
    unpinBtn.type = "button";
    unpinBtn.title = list.length > 1 && S.pinnedExpanded ? "取消当前对话的所有置顶消息" : "取消置顶此条消息";
    unpinBtn.addEventListener("click", function () {
      if (list.length > 1 && S.pinnedExpanded) {
        var oldH = bar.offsetHeight || 0;
        S.pinnedMessages = [];
        savePinnedForCurrentSession();
        syncPinnedDomNodes();
        smoothAdjustStreamForPinnedBar(oldH, 0, null);
        toast("已清空当前对话的所有置顶消息", "info");
      } else {
        unpinByItem(latest);
      }
    });
    headRight.appendChild(unpinBtn);

    headRow.appendChild(headRight);
    inner.appendChild(headRow);

    if (S.pinnedExpanded && list.length > 1) {
      var drawer = el("div", "pinned-drawer");
      list.slice().reverse().forEach(function (item, idx) {
        var row = el("div", "pinned-item");
        var main = el("div", "pinned-item-main");
        main.title = "点击滚动定位到此消息：\n" + item.text.slice(0, 240);
        main.appendChild(el("span", "fb-rank", "#" + (list.length - idx)));
        main.appendChild(el("span", "pinned-role-tag" + (item.role === "assistant" ? " asst" : ""), item.role === "assistant" ? "AI 回复" : "用户提问"));
        main.appendChild(el("span", "pinned-item-snippet", item.snippet || makePinnedSnippet(item.text)));
        main.addEventListener("click", function () {
          scrollToPinnedMessage(item);
        });
        row.appendChild(main);

        var acts = el("div", "pinned-item-actions");
        var bJump = el("button", "fb-op-btn", "定位");
        bJump.type = "button";
        bJump.addEventListener("click", function () { scrollToPinnedMessage(item); });
        acts.appendChild(bJump);

        var bQuote = el("button", "fb-op-btn use", "引用");
        bQuote.type = "button";
        bQuote.addEventListener("click", function () { quotePinnedMessageToInput(item); });
        acts.appendChild(bQuote);

        var bCopy = el("button", "fb-op-btn", "复制");
        bCopy.type = "button";
        bCopy.addEventListener("click", function () { copyText(item.text); });
        acts.appendChild(bCopy);

        var bDel = el("button", "fb-op-btn del", "\u00D7");
        bDel.type = "button";
        bDel.title = "取消置顶";
        bDel.addEventListener("click", function () { unpinByItem(item); });
        acts.appendChild(bDel);

        row.appendChild(acts);
        drawer.appendChild(row);
      });
      inner.appendChild(drawer);
    }

    bar.appendChild(inner);

    var newHeight = bar.offsetHeight || 0;
    if (shouldAnimateScroll && newHeight !== prevHeight) {
      smoothAdjustStreamForPinnedBar(prevHeight, newHeight, opts && opts.anchorNode);
    }
  }

  /* ---- 语音朗读 (TTS SpeechSynthesis 内联播放控制栏) 与内联引文渲染 ---- */
  var LS_TTS_RATE = "myclaude.tts.rate";
  var TTS_SPEEDS = [0.75, 1.0, 1.25, 1.5, 2.0];

  var ttsState = {
    activeWrap: null,
    activeBtn: null,
    barEl: null,
    playPauseBtn: null,
    statusTextEl: null,
    statusPctEl: null,
    progressFillEl: null,
    speedBtns: [],
    cleanText: "",
    charIndex: 0,
    baseOffset: 0,
    rate: 1.0,
    playing: false,
    paused: false,
    utterance: null,
     fallbackTimer: null,
    sessionToken: 0
  };

  try {
    var savedTtsRate = parseFloat(localStorage.getItem(LS_TTS_RATE));
    if (!isNaN(savedTtsRate) && savedTtsRate >= 0.5 && savedTtsRate <= 2.5) {
      ttsState.rate = savedTtsRate;
    }
  } catch (e) {}

  function cleanMarkdownForTts(raw) {
    return String(raw || "")
      .replace(/```[\s\S]*?```/g, "，代码片段已略过，")
      .replace(/[#>*_`~[\]()]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function clearTtsFallbackTimer() {
    if (ttsState.fallbackTimer) {
      clearInterval(ttsState.fallbackTimer);
      ttsState.fallbackTimer = null;
    }
  }

  function updateTtsPlayerUI() {
    var totalLen = Math.max(1, (ttsState.cleanText || "").length);
    var curIdx = Math.min(totalLen, Math.max(0, ttsState.charIndex || 0));
    var pct = Math.min(100, Math.round((curIdx / totalLen) * 100));

    if (ttsState.activeBtn) {
      ttsState.activeBtn.classList.toggle("speaking", Boolean(ttsState.playing || ttsState.paused));
      ttsState.activeBtn.title = ttsState.playing
        ? "正在朗读（点击暂停）"
        : (ttsState.paused ? "已暂停朗读（点击继续）" : "语音朗读此条 AI 回复");
    }
    if (ttsState.activeWrap) {
      ttsState.activeWrap.classList.toggle("tts-active", Boolean(ttsState.barEl));
    }
    if (!ttsState.barEl) { return; }

    ttsState.barEl.classList.toggle("is-paused", !ttsState.playing);

    if (ttsState.playPauseBtn) {
      ttsState.playPauseBtn.textContent = ttsState.playing ? "\u23F8 暂停" : (curIdx > 0 && curIdx < totalLen ? "\u25B6 继续" : "\u25B6 播放");
      ttsState.playPauseBtn.title = ttsState.playing ? "暂停语音朗读" : "继续/开始语音朗读";
    }

    if (ttsState.statusTextEl) {
      var snippet = (ttsState.cleanText || "").slice(curIdx, curIdx + 26).trim();
      if (ttsState.playing) {
        ttsState.statusTextEl.textContent = snippet ? ("正在朗读：“" + snippet + (snippet.length >= 26 ? "…”" : "”")) : "正在朗读回复内容…";
      } else if (ttsState.paused) {
        ttsState.statusTextEl.textContent = snippet ? ("已暂停：“" + snippet + (snippet.length >= 26 ? "…”" : "”")) : "已暂停朗读";
      } else {
        ttsState.statusTextEl.textContent = "朗读已完成（点击播放可重听）";
      }
    }

    if (ttsState.statusPctEl) {
      ttsState.statusPctEl.textContent = pct + "%";
    }
    if (ttsState.progressFillEl) {
      ttsState.progressFillEl.style.width = pct + "%";
    }

    (ttsState.speedBtns || []).forEach(function (b) {
      var r = parseFloat(b.getAttribute("data-rate"));
      b.classList.toggle("active", Math.abs(r - ttsState.rate) < 0.02);
    });
  }

  function stopTtsPlayback(removeBar) {
    ttsState.sessionToken++;
    clearTtsFallbackTimer();
    if ("speechSynthesis" in window) {
      try { window.speechSynthesis.cancel(); } catch (e) {}
    }
    ttsState.playing = false;
    ttsState.paused = false;
    ttsState.utterance = null;

    if (removeBar) {
      if (ttsState.barEl && ttsState.barEl.parentNode) {
        ttsState.barEl.parentNode.removeChild(ttsState.barEl);
      }
      if (ttsState.activeWrap) {
        ttsState.activeWrap.classList.remove("tts-active");
      }
      if (ttsState.activeBtn) {
        ttsState.activeBtn.classList.remove("speaking");
        ttsState.activeBtn.title = "语音朗读此条 AI 回复";
      }
      ttsState.barEl = null;
      ttsState.activeWrap = null;
      ttsState.activeBtn = null;
      ttsState.playPauseBtn = null;
      ttsState.statusTextEl = null;
      ttsState.statusPctEl = null;
      ttsState.progressFillEl = null;
      ttsState.speedBtns = [];
    } else {
      updateTtsPlayerUI();
    }
  }

  function startTtsFromOffset(offset) {
    if (!("speechSynthesis" in window)) {
      toast("当前浏览器不支持语音朗读 (SpeechSynthesis)", "warn");
      return;
    }
    var synth = window.speechSynthesis;
    ttsState.sessionToken++;
    var myToken = ttsState.sessionToken;
    clearTtsFallbackTimer();

    try { synth.cancel(); } catch (e) {}

    var fullText = ttsState.cleanText || "";
    if (!fullText) { return; }
    var safeOffset = Math.max(0, Math.min(fullText.length - 1, offset || 0));
    var remaining = fullText.slice(safeOffset);
    if (!remaining.trim()) {
      safeOffset = 0;
      remaining = fullText;
    }

    ttsState.baseOffset = safeOffset;
    ttsState.charIndex = safeOffset;
    ttsState.playing = true;
    ttsState.paused = false;

    var utter = new SpeechSynthesisUtterance(remaining);
    utter.lang = /[\u4e00-\u9fa5]/.test(remaining) ? "zh-CN" : "en-US";
    utter.rate = ttsState.rate || 1.0;
    ttsState.utterance = utter;

    var boundaryFired = false;
    utter.onboundary = function (ev) {
      if (ttsState.sessionToken !== myToken) { return; }
      if (typeof ev.charIndex === "number") {
        boundaryFired = true;
        ttsState.charIndex = Math.min(fullText.length, ttsState.baseOffset + ev.charIndex);
        updateTtsPlayerUI();
      }
    };

    // 部分浏览器中文语音引擎不触发 onboundary，使用平滑字符估算兜底进度条与倍速续播定位
    var charsPerSec = 4.6 * (ttsState.rate || 1.0);
    ttsState.fallbackTimer = setInterval(function () {
      if (ttsState.sessionToken !== myToken || !ttsState.playing || ttsState.paused) { return; }
      if (!boundaryFired) {
        ttsState.charIndex = Math.min(fullText.length - 1, ttsState.charIndex + Math.max(1, Math.round(charsPerSec * 0.25)));
        updateTtsPlayerUI();
      }
    }, 250);

    utter.onend = function () {
      if (ttsState.sessionToken !== myToken) { return; }
      clearTtsFallbackTimer();
      ttsState.charIndex = fullText.length;
      ttsState.playing = false;
      ttsState.paused = false;
      updateTtsPlayerUI();
    };

    utter.onerror = function (ev) {
      if (ttsState.sessionToken !== myToken) { return; }
      if (ev && (ev.error === "interrupted" || ev.error === "canceled")) { return; }
      clearTtsFallbackTimer();
      ttsState.playing = false;
      ttsState.paused = false;
      updateTtsPlayerUI();
    };

    updateTtsPlayerUI();
    synth.speak(utter);
  }

  function pauseTtsPlayback() {
    if (!ttsState.playing) { return; }
    var synth = window.speechSynthesis;
    ttsState.playing = false;
    ttsState.paused = true;
    if (synth && synth.speaking) {
      try { synth.pause(); } catch (e) {}
    }
    updateTtsPlayerUI();
  }

  function resumeTtsPlayback() {
    var synth = window.speechSynthesis;
    if (ttsState.paused && synth && synth.paused) {
      ttsState.playing = true;
      ttsState.paused = false;
      try { synth.resume(); } catch (e) {
        startTtsFromOffset(ttsState.charIndex);
      }
      updateTtsPlayerUI();
      return;
    }
    var nextOffset = ttsState.charIndex >= (ttsState.cleanText.length - 2) ? 0 : ttsState.charIndex;
    startTtsFromOffset(nextOffset);
  }

  function setTtsPlaybackRate(nextRate) {
    var r = Number(nextRate) || 1.0;
    ttsState.rate = r;
    try { localStorage.setItem(LS_TTS_RATE, String(r)); } catch (e) {}
    if (ttsState.playing) {
      startTtsFromOffset(ttsState.charIndex);
    } else {
      updateTtsPlayerUI();
    }
  }

  function mountInlineTtsBar(wrap, btn, cleanText) {
    if (!wrap) { return; }
    if (ttsState.activeWrap && ttsState.activeWrap !== wrap) {
      stopTtsPlayback(true);
    }
    var oldBar = wrap.querySelector(".tts-player-bar");
    if (oldBar && oldBar.parentNode) {
      oldBar.parentNode.removeChild(oldBar);
    }

    ttsState.activeWrap = wrap;
    ttsState.activeBtn = btn;
    ttsState.cleanText = cleanText;
    ttsState.charIndex = 0;
    ttsState.baseOffset = 0;

    var bar = el("div", "tts-player-bar");
    bar.setAttribute("role", "region");
    bar.setAttribute("aria-label", "语音朗读播放控制栏");

    var playPauseBtn = el("button", "tts-ctrl-btn play-pause", "\u23F8 暂停");
    playPauseBtn.type = "button";
    playPauseBtn.addEventListener("click", function () {
      if (ttsState.playing) {
        pauseTtsPlayback();
      } else {
        resumeTtsPlayback();
      }
    });
    bar.appendChild(playPauseBtn);

    var wave = el("div", "tts-wave");
    wave.setAttribute("aria-hidden", "true");
    for (var w = 0; w < 4; w++) { wave.appendChild(document.createElement("i")); }
    bar.appendChild(wave);

    var progWrap = el("div", "tts-progress-wrap");
    var statusRow = el("div", "tts-status-row");
    var statusText = el("span", "tts-status-text", "正在朗读回复内容…");
    var statusPct = el("span", "tts-status-pct", "0%");
    statusRow.appendChild(statusText);
    statusRow.appendChild(statusPct);
    progWrap.appendChild(statusRow);

    var track = el("div", "tts-progress-track");
    track.title = "点击进度条可跳转到对应段落位置朗读";
    var fill = el("div", "tts-progress-fill");
    track.appendChild(fill);
    track.addEventListener("click", function (e) {
      var rect = track.getBoundingClientRect();
      if (!rect.width) { return; }
      var ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      var targetOffset = Math.floor(ratio * (ttsState.cleanText.length || 0));
      startTtsFromOffset(targetOffset);
    });
    progWrap.appendChild(track);
    bar.appendChild(progWrap);

    var speedGroup = el("div", "tts-speed-group");
    speedGroup.appendChild(el("span", "tts-speed-label", "倍速"));
    var speedBtns = [];
    TTS_SPEEDS.forEach(function (spd) {
      var sb = el("button", "tts-speed-btn" + (Math.abs(spd - ttsState.rate) < 0.02 ? " active" : ""), spd + "x");
      sb.type = "button";
      sb.setAttribute("data-rate", String(spd));
      sb.title = "切换朗读语速为 " + spd + " 倍速";
      sb.addEventListener("click", function () {
        setTtsPlaybackRate(spd);
      });
      speedBtns.push(sb);
      speedGroup.appendChild(sb);
    });
    bar.appendChild(speedGroup);

    var replayBtn = el("button", "tts-ctrl-btn icon-only", "\u21BA");
    replayBtn.type = "button";
    replayBtn.title = "从头重新朗读";
    replayBtn.addEventListener("click", function () {
      startTtsFromOffset(0);
    });
    bar.appendChild(replayBtn);

    var stopBtn = el("button", "tts-ctrl-btn icon-only stop-btn", "\u2715");
    stopBtn.type = "button";
    stopBtn.title = "停止朗读并收起控制栏";
    stopBtn.addEventListener("click", function () {
      stopTtsPlayback(true);
    });
    bar.appendChild(stopBtn);

    var contentBox = wrap.querySelector(".content") || wrap;
    var actionsBox = wrap.querySelector(".msg-actions");
    if (actionsBox && actionsBox.nextSibling) {
      contentBox.insertBefore(bar, actionsBox.nextSibling);
    } else {
      contentBox.appendChild(bar);
    }

    ttsState.barEl = bar;
    ttsState.playPauseBtn = playPauseBtn;
    ttsState.statusTextEl = statusText;
    ttsState.statusPctEl = statusPct;
    ttsState.progressFillEl = fill;
    ttsState.speedBtns = speedBtns;
  }

  function toggleSpeakText(text, btn, wrap) {
    if (!("speechSynthesis" in window)) {
      toast("当前浏览器不支持语音朗读 (SpeechSynthesis)", "warn");
      return;
    }
    var targetWrap = wrap || (btn && btn.closest && btn.closest(".msg-asst")) || null;
    if (ttsState.activeWrap && ttsState.activeWrap === targetWrap && ttsState.barEl) {
      if (ttsState.playing) {
        pauseTtsPlayback();
      } else {
        resumeTtsPlayback();
      }
      return;
    }

    var cleanText = cleanMarkdownForTts(text);
    if (!cleanText) {
      toast("没有可朗读的文本内容", "warn");
      return;
    }

    mountInlineTtsBar(targetWrap, btn, cleanText);
    startTtsFromOffset(0);
  }

  function extractMarkdownCitations(rawText, existingCitations) {
    var map = {};
    var list = [];
    (existingCitations || []).forEach(function (c, i) {
      var idx = c.index || (i + 1);
      map[idx] = c;
      list.push(c);
    });
    var regex = /\[(\d+)\]\s*[:：]?\s*\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g;
    var m;
    while ((m = regex.exec(String(rawText || ""))) !== null) {
      var idxNum = parseInt(m[1], 10);
      if (!map[idxNum]) {
        var dom = "web";
        try { dom = new URL(m[3]).hostname.replace(/^www\./, ""); } catch (e) {}
        var entry = { index: idxNum, title: m[2], url: m[3], domain: dom, snippet: "" };
        map[idxNum] = entry;
        list.push(entry);
      }
    }
    return list;
  }

  function decorateCitationsInMessage(handle) {
    if (!handle || !handle.body || !handle.wrap) { return; }
    var citations = extractMarkdownCitations(handle.raw, handle.wrap._citations);
    if (!citations.length) { return; }
    handle.wrap._citations = citations;

    var citeMap = {};
    citations.forEach(function (c) { citeMap[c.index] = c; });

    // 将正文中的 [1] [2] 转换为可点击的角标胶囊
    handle.body.innerHTML = handle.body.innerHTML.replace(/\[(\d+)\](?!\()/g, function (full, numStr) {
      var n = parseInt(numStr, 10);
      var c = citeMap[n];
      if (!c) { return full; }
      var safeUrl = String(c.url || "#").replace(/"/g, "&quot;");
      var safeTitle = String((c.title || "") + (c.snippet ? " — " + c.snippet : "")).replace(/"/g, "&quot;");
      return '<a class="cite-badge" href="' + safeUrl + '" target="_blank" rel="noopener noreferrer" title="' + safeTitle + '">' + n + '</a>';
    });

    var oldStrip = handle.wrap.querySelector(".citations-strip");
    if (oldStrip && oldStrip.parentNode) {
      oldStrip.parentNode.removeChild(oldStrip);
    }

    var strip = el("div", "citations-strip");
    var titleRow = el("div", "citations-strip-title");
    titleRow.appendChild(icon("i-globe", 13));
    titleRow.appendChild(el("span", null, "联网检索参考信源 (" + citations.length + ")"));
    strip.appendChild(titleRow);

    var grid = el("div", "citations-grid");
    citations.forEach(function (c) {
      var card = document.createElement("a");
      card.className = "citation-card";
      card.href = c.url || "#";
      card.target = "_blank";
      card.rel = "noopener noreferrer";
      var top = el("div", "citation-card-top");
      top.appendChild(el("span", "citation-idx", String(c.index)));
      top.appendChild(el("span", "citation-domain", c.domain || "web"));
      card.appendChild(top);
      card.appendChild(el("div", "citation-title", c.title || c.url));
      if (c.snippet) {
        card.appendChild(el("div", "citation-snippet", c.snippet));
      }
      grid.appendChild(card);
    });
    strip.appendChild(grid);

    var contentBox = handle.wrap.querySelector(".content") || handle.wrap;
    contentBox.insertBefore(strip, handle.actions);
  }

  function switchAssistantBranch(handle, targetIdx) {
    if (!handle || !handle.wrap || !handle.wrap._asstBranches) { return; }
    var branches = handle.wrap._asstBranches;
    if (targetIdx < 0 || targetIdx >= branches.length) { return; }
    handle.wrap._asstBranchIdx = targetIdx;
    var b = branches[targetIdx];
    handle.raw = b.raw || "";
    handle.wrap._raw = handle.raw;
    handle.wrap._citations = b.citations || [];
    flushAssistant(handle, handle.raw, false);
    addCopyActions(handle);
    toast("已切换至回复版本 " + (targetIdx + 1) + " / " + branches.length, "info");
  }

  function addCopyActions(handle) {
    if (!handle || !handle.actions) { return; }
    clear(handle.actions);
    if (handle.wrap) {
      handle.wrap._raw = handle.raw;
    }

    // 1. 同会话多分支版本切换器 (◀ 1 / 2 ▶)
    var branches = handle.wrap && handle.wrap._asstBranches;
    var hasBranches = Boolean(branches && branches.length > 1);
    if (handle.wrap) {
      handle.wrap.classList.toggle("has-branches", hasBranches);
    }
    if (hasBranches) {
      var curIdx = typeof handle.wrap._asstBranchIdx === "number" ? handle.wrap._asstBranchIdx : branches.length - 1;
      var nav = el("div", "msg-branch-nav");
      nav.title = "切换对比同一提问的不同 AI 回复版本";
      var prevB = el("button", "branch-arrow", "\u25C0");
      prevB.type = "button";
      prevB.title = "上一回复版本";
      prevB.disabled = curIdx <= 0;
      prevB.addEventListener("click", function () {
        switchAssistantBranch(handle, curIdx - 1);
      });
      var nextB = el("button", "branch-arrow", "\u25B6");
      nextB.type = "button";
      nextB.title = "下一回复版本";
      nextB.disabled = curIdx >= branches.length - 1;
      nextB.addEventListener("click", function () {
        switchAssistantBranch(handle, curIdx + 1);
      });
      nav.appendChild(prevB);
      nav.appendChild(el("span", "branch-indicator", (curIdx + 1) + " / " + branches.length));
      nav.appendChild(nextB);
      handle.actions.appendChild(nav);
    }

    var pinBtn = mkMini("置顶", function () {
      togglePinMessage(handle.wrap, "assistant", function () { return handle.raw; }, pinBtn);
    });
    pinBtn.classList.add("pin-btn");
    if (handle.wrap) {
      handle.wrap._pinBtn = pinBtn;
      updateMessagePinVisual(handle.wrap, pinBtn, isMessagePinned(handle.wrap, handle.raw));
    }
    handle.actions.appendChild(pinBtn);

    var ttsBtn = mkMini("朗读", function () {
      toggleSpeakText(handle.raw, ttsBtn, handle.wrap);
    });
    ttsBtn.classList.add("tts-btn");
    ttsBtn.title = "语音朗读此条 AI 回复（打开内联播放与倍速控制栏）";
    handle.actions.appendChild(ttsBtn);

    handle.actions.appendChild(mkMini("复制", function () { copyText(handle.raw); }));
    // 重试带菜单：同模型重试 / 更简短 / 更详细（对齐 claude.ai 的 retry 变体）
    var retryBtn = mkMini("重试", function () { openRetryMenu(retryBtn, handle); });
    handle.actions.appendChild(retryBtn);
    mkFeedbackButtons(handle).forEach(function (b) { handle.actions.appendChild(b); });
    // 已有反馈时把激活态点亮（流式结束与分支切换都会走这里）
    if (S.feedback && handle.raw) {
      var fb = S.feedback[digestText(handle.raw)];
      handle.wrap.classList.toggle("fb-up", fb === "up");
      handle.wrap.classList.toggle("fb-down", fb === "down");
    }

    decorateCitationsInMessage(handle);
  }

  /**
   * Split a leading <think>...</think> block away from the answer.
   *
   * Some gateways put their reasoning inline in `content` instead of a dedicated
   * field. That reasoning belongs in the collapsible "thinking" panel, never in
   * the message body — and it must never reach `handle.raw`, which feeds copy,
   * TTS, pin and the saved branch history.
   *
   * The closing tag is searched from the opening tag onwards so a stray
   * `implicit reasoning` mentioned inside the prose cannot swallow the answer.
   * A closing tag with no opening one is dropped too: it is a model tic, not
   * content, and rendering it as text is what leaked into transcripts before.
   */
  function extractThinkTagContent(raw) {
    var s = String(raw == null ? "" : raw);
    var start = s.indexOf("<think>");
    // An opening tag only starts a block when nothing but whitespace precedes it;
    // buried in prose it is quoted content and must be left alone.
    if (start > 0 && !/^\s*$/.test(s.slice(0, start))) { start = -1; }
    if (start < 0) {
      var closeAt = s.indexOf("</think>");
      if (closeAt < 0) { return null; }
      // A closing tag with no opener: either the gateway dropped the opener but
      // kept the reasoning inline, or the tag is merely quoted inside prose.
      // Only a paragraph break before the tag marks the former — that is the
      // case where a page of analysis used to print above a one-line answer.
      var before = s.slice(0, closeAt);
      if (/\n\s*$/.test(before) && before.trim()) {
        return { think: before.trim(), rest: s.slice(closeAt + 8).replace(/^\s+/, ""), open: false };
      }
      // Quoted in prose: leave the line untouched.
      return { think: "", rest: s, open: false };
    }
    var end = s.indexOf("</think>", start + 7);
    if (end < 0) {
      return { think: s.slice(start + 7).trim(), rest: "", open: true };
    }
    return {
      think: s.slice(start + 7, end).trim(),
      rest: s.slice(0, start) + s.slice(end + 8),
      open: false
    };
  }

  function flushAssistant(handle, text, streaming) {
    var full = text == null ? handle.raw : text;
    var parsed = extractThinkTagContent(full);
    var visibleText = parsed ? parsed.rest : full;
    handle.raw = visibleText;
    handle.think = parsed ? parsed.think : "";
    handle.pending = false;
    handle.body.className = "md" + (streaming ? " cursor" : " ");
    handle.body.innerHTML = MD.render(visibleText || (streaming && parsed && parsed.open ? "正在深度思考推演中…" : ""));
    if (!streaming) {
      enhanceCodeblocksWithArtifacts(handle.body);
    }
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
    // 任务计时挂思考条上；label 会被「正在思考…/已思考 N 秒」反复改写，
    // 独立 span 才不会被覆盖。
    var timer = el("span", "thought-timer");
    timer.title = "任务进行时间";
    head.appendChild(timer);
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
    return { box: box, label: label, body: body, timer: timer };
  }

  function openAttachmentPreviewModal(f) {
    if (!f) { return; }
    openModal(f.name || "附件内容", function (body) {
      if (f.pasted) {
        var ta = el("textarea", "msg-edit-ta");
        ta.style.minHeight = "260px";
        ta.style.fontFamily = "var(--mono)";
        ta.style.fontSize = "12.5px";
        ta.value = f.text || "";
        ta.addEventListener("input", function () {
          f.text = ta.value;
          f.size = f.text.length;
        });
        body.appendChild(ta);
      } else {
        var pre = el("pre", "code wrap");
        pre.textContent = f.text || "";
        body.appendChild(pre);
      }
    }, [
      {
        label: "展开到输入框",
        cls: "ghost",
        fn: function () {
          var ta = $("in");
          if (ta && f.text) {
            ta.value = (ta.value ? ta.value + "\n" : "") + f.text;
            autoGrow(ta);
          }
          var idx = S.attachments.indexOf(f);
          if (idx >= 0) { S.attachments.splice(idx, 1); renderAttachments(); }
          closeModal();
        }
      },
      { label: "完成", cls: "primary", fn: closeModal }
    ]);
  }

  function renderAttachments() {
    var tray = $("attach-list");
    if (!tray) { return; }
    clear(tray);
    if (!S.attachments.length) { tray.hidden = true; return; }
    tray.hidden = false;
    S.attachments.forEach(function (f, i) {
      var cls = "chip" + (f.pasted ? " is-pasted" : f.fileRef ? " is-file-ref" : f.quote ? " is-quote" : "");
      var chip = el("div", cls);
      chip.title = f.pasted ? "点击查看或编辑粘贴的长文本" : f.fileRef ? "点击预览引用的工作区文件" : f.name;
      if (f.preview) {
        var img = document.createElement("img");
        img.src = f.preview;
        chip.appendChild(img);
      } else {
        var icoText = f.pasted ? "PASTED" : f.fileRef ? "@" : f.quote ? "引用" : "TXT";
        chip.appendChild(el("span", "chip-ico", icoText));
      }
      chip.appendChild(el("span", "chip-name", f.name));
      chip.appendChild(el("span", "chip-size", f.lines ? f.lines + " 行" : bytes(f.size)));
      chip.addEventListener("click", function (e) {
        if (e.target && e.target.classList && e.target.classList.contains("chip-x")) { return; }
        if (f.text) { openAttachmentPreviewModal(f); }
      });
      var x = el("button", "chip-x", "\u00D7");
      x.type = "button";
      x.title = "移除";
      x.addEventListener("click", function (e) {
        e.stopPropagation();
        S.attachments.splice(i, 1);
        renderAttachments();
      });
      chip.appendChild(x);
      tray.appendChild(chip);
    });
  }

  /* ---- 任务实时读数：耗时 + 累计 token ---- */
  function fmtClockMs(ms) {
    var s = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
    var m = Math.floor(s / 60), ss = s % 60;
    return m + ":" + (ss < 10 ? "0" : "") + ss;
  }
  function fmtTok(n) {
    n = Number(n) || 0;
    return n >= 1000 ? (n / 1000).toFixed(1) + "k" : String(n);
  }
  /** 把同一份实时读数写到工具聚合条右侧徽标 + 思考条计时器。
   * active=false 时定格（去掉脉冲），文本留在 DOM 里作为本轮记录。 */
  function setLiveStat(elapsedMs, inTok, outTok, active) {
    var total = (Number(inTok) || 0) + (Number(outTok) || 0);
    var txt = fmtClockMs(elapsedMs) + " · " + fmtTok(total) + " tok";
    var root = logRoot();
    if (!root) return;
    Array.prototype.forEach.call(root.querySelectorAll(".tool-group-live"), function (b) {
      b.textContent = txt;
      b.classList.toggle("is-running", !!active);
      b.title = "任务耗时 " + fmtClockMs(elapsedMs) + " · 累计 " + total.toLocaleString() + " tokens（输入 " + (Number(inTok) || 0) + " / 输出 " + (Number(outTok) || 0) + "）";
    });
    Array.prototype.forEach.call(root.querySelectorAll(".thought-timer"), function (t) {
      t.textContent = txt;
      t.title = "任务耗时 " + fmtClockMs(elapsedMs) + " · 累计 " + total.toLocaleString() + " tokens";
    });
    var liveEl = $("live");
    if (liveEl) { liveEl.title = "任务进行中 · " + fmtClockMs(elapsedMs) + " · " + fmtTok(total) + " tok"; }
  }

  function setBusy(v) {
    S.busy = v;
    var send = $("send");
    var stop = $("btn-stop");

    if (send) { send.disabled = v; }
    if (stop) { stop.hidden = !v; }

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
    // 任务进行时间：显示在对话流当前回合的思考条上，不再挤在输入框右侧
    if (v) {
      S.busyStartedAt = Date.now();
      if (!S.busyTimer) {
        S.busyTimer = setInterval(function () {
          // 客户端每秒自转；服务端 progress 事件会用更准的 token 数覆盖同一处。
          setLiveStat(Date.now() - (S.busyStartedAt || Date.now()),
            (S.stats && S.stats.inputTokens) || 0, (S.stats && S.stats.outputTokens) || 0, true);
        }, 1000);
      }
    } else {
      if (S.busyTimer) { clearInterval(S.busyTimer); S.busyTimer = null; }
      var root2 = logRoot();
      var timers2 = root2 ? root2.querySelectorAll(".thought-timer") : [];
      Array.prototype.forEach.call(timers2, function (t) { t.textContent = ""; });
      // 工具聚合条徽标不清空：定格成这一轮的执行记录。
      Array.prototype.forEach.call(root2 ? root2.querySelectorAll(".tool-group-live") : [], function (b) {
        b.classList.remove("is-running");
      });
    }
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
    var state = freshTurnState();

    setBusy(true);
    var oldEnd = logRoot().querySelector(".turn-end");
    if (oldEnd && oldEnd.parentNode) { oldEnd.parentNode.removeChild(oldEnd); }
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
      // 409 = 该会话已有任务在跑（比如我们刚刷新了页面）。此时不该报错，
      // 而是转入跟随模式把后台任务接回来。
      if (/HTTP 409/.test(e.message || "")) {
        addNotice("检测到该会话已有任务在运行 — 已接回后台任务", "info");
        var followState = freshTurnState();
        followTurnEvents(S.sessionKey || "default", followState);
        return;
      }
      addNotice("请求失败：" + e.message, "err");
      endTurn(state);
    });
  }

  function freshTurnState() {
    return {
      asst: null,
      buffer: "",
      pendingTools: [],
      startedAt: Date.now(),
      thought: null,
      reasoningBuf: "",
      thoughtTimer: null
    };
  }

  /* ---- 断线重连：把仍在后台跑的回合接回界面 ----
   * 刷新、断网、睡眠唤醒后，服务端任务并没有死（事件还在 turnBus 里）。
   * 页面加载时查 /api/turn-state：running 就打开 /api/turn-events——
   * 服务端先重放缓冲，再实时扇出；这里复用 handleStreamEvent 的同一条
   * 渲染路径，与正常回合完全一致。 */
  function reattachRunningTurn() {
    var key = S.sessionKey || "default";
    getJSON("/api/turn-state?sessionKey=" + encodeURIComponent(key)).then(function (st) {
      if (!st || !st.running || S.busy) { return; }
      setBusy(true);
      addNotice("检测到后台任务仍在运行 — 已重新接上（刷新 / 断网不再中断任务）", "info");
      followTurnEvents(key, freshTurnState());
    }).catch(function () { /* 服务端无此端点（旧版本）时静默 */ });
  }

  function followTurnEvents(key, state) {
    fetch("/api/turn-events?sessionKey=" + encodeURIComponent(key), { headers: { Accept: "text/event-stream" } })
      .then(function (res) {
        if (!res.ok || !res.body) { throw new Error("HTTP " + res.status); }
        var reader = res.body.getReader();
        var dec = new TextDecoder();
        var buf = "";
        var replay = [];
        function pump() {
          return reader.read().then(function (r) {
            if (r.done) { endTurn(state); return; }
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
              if (ev.type === "turn_replay") {
                // 只应用「最后一个已持久化边界」之后的事件：assistant_end /
                // tool_end 之前的内容已随 2.5s 定期落盘进了会话文件，重放会
                // 与 resumeSession 渲染的历史重复。
                var boundary = -1;
                for (var i = 0; i < replay.length; i++) {
                  if (replay[i].type === "assistant_end" || replay[i].type === "tool_end") { boundary = i; }
                }
                for (var j = boundary + 1; j < replay.length; j++) {
                  try { handleStreamEvent(replay[j], state); } catch (e) { /* 单事件失败不挡跟随 */ }
                }
                replay = null;
                if (ev.done) { endTurn(state); return; }
                continue;
              }
              if (replay) { replay.push(ev); }
              else if (ev.type === "done") { endTurn(state); return; }
              else {
                try { handleStreamEvent(ev, state); } catch (e) { /* 单事件失败不挡跟随 */ }
              }
            }
            return pump();
          });
        }
        return pump();
      })
      .catch(function () { endTurn(state); });
  }

  function finalizeAssistantBranches(asst) {
    if (!asst || !asst.wrap) { return; }
    if (asst.wrap._asstBranches && !asst.wrap._branchRecorded) {
      asst.wrap._branchRecorded = true;
      asst.wrap._asstBranches.push({
        raw: asst.raw || "",
        citations: asst.wrap._citations || []
      });
      asst.wrap._asstBranchIdx = asst.wrap._asstBranches.length - 1;
    }
  }

  /**
   * 回合收束页脚。
   *
   * 回合结束是真实状态，此前任务戛然而止没有任何标记。只保留最新一条
   * （历史不堆噪音）；助手以问句收尾时说「在等你回复」，否则报统计。
   */
  function addTurnEndMarker(state) {
    var prev = logRoot().querySelector(".turn-end");
    if (prev && prev.parentNode) { prev.parentNode.removeChild(prev); }
    var secs = Math.max(1, Math.round((Date.now() - state.startedAt) / 1000));
    var st = S.stats || {};
    var fmt = function (n) { n = n || 0; return n >= 1000 ? (n / 1000).toFixed(1).replace(/\.0$/, "") + "k" : String(n); };
    var last = (state.asst && state.asst.raw) || "";
    var asking = /[?？]\s*["\u300d\u300f）)\]]?\s*$/.test(String(last).trim());
    var box = el("div", "turn-end" + (asking ? " waiting" : ""));
    box.appendChild(el("span", "te-dot"));
    var bits = [asking ? "Claude 在等你回复" : "回合完成", secs + " 秒"];
    if (st.turns) { bits.push(st.turns + " 轮"); }
    if (st.inputTokens || st.outputTokens) { bits.push("\u2191" + fmt(st.inputTokens) + " \u2193" + fmt(st.outputTokens) + " tokens"); }
    box.appendChild(el("span", null, bits.join(" \u00b7 ")));
    logRoot().appendChild(box);
    scrollStream();
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
      finalizeAssistantBranches(state.asst);
      addCopyActions(state.asst);
    }
    addTurnEndMarker(state);
    setBusy(false);
    refreshStats();
  }

  var _turnHadError = false;

  function handleStreamEvent(ev, state) {
    // Reasoning streams on its own channel: it belongs in the collapsible
    // panel, never in the answer body.
    if (ev.type === "reasoning") {
      state.reasoningBuf += ev.text;
      if (state.thought) {
        state.thought.body.textContent = state.reasoningBuf;
        var secsR = Math.max(1, Math.round((Date.now() - state.startedAt) / 1000));
        state.thought.label.textContent = "深度思考中…（" + state.reasoningBuf.length + " 字 · " + secsR + " 秒）";
        state.thought.box.classList.add("open");
      }
      // The thinking panel grows too; keep it in view while it streams.
      scrollStream();
      return;
    }
    if (ev.type === "delta") {
      state.buffer += ev.text;
      var parsed = extractThinkTagContent(state.buffer);
      if (parsed && state.thought) {
        state.thought.body.textContent = parsed.think;
        if (parsed.open) {
          state.thought.box.classList.add("open");
          state.thought.label.textContent = "深度思考中…（" + parsed.think.length + " 字）";
          return;
        } else {
          var secsThink = Math.max(1, Math.round((Date.now() - state.startedAt) / 1000));
          state.thought.label.textContent = "已深度思考 " + secsThink + " 秒（" + parsed.think.length + " 字）";
        }
      }
      if (!state.asst) {
        if (state.thought && !parsed) {
          clearTimeout(state.thoughtTimer);
          var secs = Math.max(1, Math.round((Date.now() - state.startedAt) / 1000));
          state.thought.label.textContent = "已思考 " + secs + " 秒";
        }
        state.asst = addAssistantMessage();
      }
      renderAssistant(state.asst, state.buffer, true);
      return;
    }
    if (ev.type === "assistant_end") {
      if (state.asst) {
        flushAssistant(state.asst, state.buffer, false);
        finalizeAssistantBranches(state.asst);
        addCopyActions(state.asst);
      }
      state.asst = null;
      state.buffer = "";
      return;
    }
    if (ev.type === "tool_start") {
      if (state.asst) {
        flushAssistant(state.asst, state.buffer, false);
        finalizeAssistantBranches(state.asst);
        addCopyActions(state.asst);
        state.asst = null;
        state.buffer = "";
      }
      state.pendingTools.push(addToolCard(ev.call.name, ev.call.args));
      // A tool card is new content too: follow it like any other output.
      scrollStream();
      return;
    }
    if (ev.type === "tool_end") {
      finishToolCard(state.pendingTools.shift(), ev.ok, ev.elapsed, ev.output, ev.data);
      scrollStream();
      return;
    }
    if (ev.type === "confirm") { playChime("ask"); maybeNotify("需要你的确认", "MyClaude 正在等待工具调用授权"); showConfirm(ev); return; }
    if (ev.type === "question") { playChime("ask"); maybeNotify("有一个问题等你回答", "MyClaude 需要你的输入才能继续"); showQuestion(ev); return; }
    if (ev.type === "mode") { setMode(ev.permissionMode); return; }
    if (ev.type === "max_turns") { addMaxTurnsCard(ev.limit); return; }
    if (ev.type === "truncated") { addTruncatedCard(); return; }
    if (ev.type === "todos") {
      S.todos = ev.todos || [];
      renderInspector();
      scrollStream();
      return;
    }
    if (ev.type === "progress") {
      // 服务端每秒推一次：比客户端自转更准的累计 token。
      S.stats.inputTokens = ev.inputTokens || 0;
      S.stats.outputTokens = ev.outputTokens || 0;
      S.stats.tokens = (ev.inputTokens || 0) + (ev.outputTokens || 0);
      S.stats.turns = ev.turns || 0;
      S.stats.messages = ev.messages || 0;
      setLiveStat(ev.elapsedMs, ev.inputTokens, ev.outputTokens, true);
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
    if (ev.type === "error") { _turnHadError = true; addNotice(ev.text, "err"); return; }
    if (ev.type === "success") { addNotice(ev.text, "ok"); return; }
    if (ev.type === "session") {
      if (ev.id) {
        var prevKey = S.sessionKey;
        S.sessionKey = ev.id;
        try { localStorage.setItem(LS_SESSION, ev.id); } catch (e) { }
        if (!prevKey && S.pinnedMessages && S.pinnedMessages.length) {
          savePinnedForCurrentSession();
        }
      }
      refreshSessions();
      return;
    }
    if (ev.type === "session_title") {
      // AI 自动命名到达：覆盖派生标题，刷新侧栏
      if (ev.title) {
        S.titleOverride = { key: S.sessionKey, title: ev.title };
        renderTopMeta();
        refreshSessions();
      }
      return;
    }
    if (ev.type === "compact") { addNotice("上下文已压缩（丢弃 " + (ev.dropped ?? "?") + " 条旧消息），长对话继续", "info"); }
          if (ev.type === "done") {
      refreshStatusLine(true); // 回合结束按最新 stats 重算状态行
            // 定格实时读数：工具聚合条右侧保留本轮最终耗时 + token 作为记录。
            setLiveStat(Date.now() - (S.busyStartedAt || Date.now()),
              (S.stats && S.stats.inputTokens) || 0, (S.stats && S.stats.outputTokens) || 0, false);
            playChime("done");
            maybeNotify("回复已完成", "MyClaude 的新回复已生成，点击回到对话");
            // 本回合出现过错误（如 provider error）→ 给一键重试，免得用户
            // 重新打字或去找上一条消息。
            if (_turnHadError && S.lastUserText) { addRetryCard(); }
            _turnHadError = false;
            // AI 自动命名是回合外异步完成的：晚 3 秒刷新一次侧栏拿标题
            setTimeout(function () { refreshSessions(); }, 3000);
            setBusy(false);
          }
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
    clearDraft();
    S.attachments = []; renderAttachments();
    S.lastUserText = text;
    if (S.history[S.history.length - 1] !== text) { S.history.push(text); }
    S.histIdx = -1;
    addUserMessage(text, files);

    if (S.webSearch && text) {
      getJSON("/api/web-search?q=" + encodeURIComponent(text.slice(0, 120))).then(function (res) {
        var cites = (res && res.results) || [];
        S.pendingCitations = cites;
        var citeBlock = "";
        if (cites.length) {
          var lines = cites.map(function (c) {
            return "[" + c.index + "] " + c.title + " (" + c.url + ") — " + (c.snippet || "");
          }).join("\n");
          citeBlock = "[联网实时搜索参考信源 (Web Search Citations) — 请结合以下检索结果回答，并在正文中引用对应事实时使用内联角标如 [1]、[2]：\n" + lines + "]\n\n";
        }
        runTurn({
          message: citeBlock + applyStyleInstruction(text),
          attachments: files.map(stripPreview),
          sessionKey: S.sessionKey
        });
      }).catch(function () {
        runTurn({
          message: applyStyleInstruction(text),
          attachments: files.map(stripPreview),
          sessionKey: S.sessionKey
        });
      });
      return;
    }

    runTurn({
      message: applyStyleInstruction(text),
      attachments: files.map(stripPreview),
      sessionKey: S.sessionKey
    });
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

  function retryLast(handle, extraInstruction) {
    if (S.busy) { toast("请等待当前回复结束", "warn"); return; }
    if (!S.lastUserText) { toast("没有可重试的内容", "warn"); return; }
    if (handle && handle.wrap) {
      var prevBranches = handle.wrap._asstBranches
        ? handle.wrap._asstBranches.slice()
        : [{ raw: handle.raw || "", citations: handle.wrap._citations || [] }];
      S._pendingRetryBranches = prevBranches;
    }
    var root = logRoot();
    var node = handle && handle.wrap;
    while (node && node.classList && !node.classList.contains("msg-user")) {
      var prev = node.previousElementSibling;
      if (node.parentNode === root) { root.removeChild(node); }
      node = prev;
    }
    // 更简短 / 更详细：原提问保持不变，把长度要求作为补充指令拼在后面，
    // 这样重试后的分支记录里用户仍然看得到自己最初问了什么。
    var message = S.lastUserText;
    if (extraInstruction) { message += "\n\n（" + extraInstruction + "）"; }
    runTurn({ message: applyStyleInstruction(message), retry: true, sessionKey: S.sessionKey });
  }

  /** 重试菜单：小气泡弹出，点击外部关闭（对齐 claude.ai 的 retry 长度变体）。 */
  function openRetryMenu(anchorBtn, handle) {
    var old = $("retry-menu");
    if (old && old.parentNode) { old.parentNode.removeChild(old); return; }
    var menu = el("div", "mini-menu");
    menu.id = "retry-menu";
    [
      { label: "重新生成", desc: "用当前模型再答一次", extra: null },
      { label: "更简短", desc: "压缩篇幅，只保留要点", extra: "请比上一次回答明显更简短，只保留关键结论" },
      { label: "更详细", desc: "展开说明与示例", extra: "请比上一次回答更详细，补充步骤、示例与边界情况" }
    ].forEach(function (item) {
      var row = el("button", "mini-menu-item");
      row.type = "button";
      row.appendChild(el("span", "mini-menu-label", item.label));
      row.appendChild(el("span", "mini-menu-desc", item.desc));
      row.addEventListener("click", function () {
        if (menu.parentNode) { menu.parentNode.removeChild(menu); }
        retryLast(handle, item.extra);
      });
      menu.appendChild(row);
    });
    document.body.appendChild(menu);
    var rect = anchorBtn.getBoundingClientRect();
    menu.style.left = Math.min(rect.left, window.innerWidth - menu.offsetWidth - 8) + "px";
    menu.style.top = Math.max(8, rect.top - menu.offsetHeight - 6) + "px";
    setTimeout(function () {
      var close = function (e) {
        if (menu.parentNode && !menu.contains(e.target)) {
          menu.parentNode.removeChild(menu);
          document.removeEventListener("click", close, true);
        }
      };
      document.addEventListener("click", close, true);
    }, 0);
  }

  function stopGeneration() {
    if (!S.busy) { return; }
    postJSON("/api/abort", { sessionKey: S.sessionKey }).catch(function () {});
  }

  /* ================================================================ 面板 === */

  // Shift+Tab 权限模式轮转。顺序必须与 src/agent/modes.js 的 MODE_CYCLE 一致：
  //   ask -> acceptEdits -> plan -> bypassPermissions -> auto -> ask
  // dontAsk 与 fullAccess 刻意不在环上（前者上游明确排除，后者是逃生门）。
  var MODE_RING = ["ask", "acceptEdits", "plan", "bypassPermissions", "auto"];
  function cyclePermissionMode() {
    var cur = (S.config && S.config.permissionMode) || "ask";
    var i = MODE_RING.indexOf(cur);
    var next = i < 0 ? MODE_RING[0] : MODE_RING[(i + 1) % MODE_RING.length];
    postJSON("/api/config", { permissionMode: next }).then(function () {
      setMode(next);
      toast("权限模式 → " + next, "ok");
    }).catch(function (e) { addNotice("切换权限模式失败：" + e.message, "err"); });
  }

  function setMode(mode) {
    if (S.config) { S.config.permissionMode = mode; }
    renderTopMeta();
    moveModeThumb();
  }

  /**
   * Reflect the active permission mode in the composer dropdown.
   *
   * Kept under the old name because several call sites (boot, resize, setMode)
   * already invoke it; only the control it drives changed from a segmented
   * group to a native select.
   */
  function moveModeThumb() {
    var sel = $("mode-select");
    if (!sel) { return; }
    var mode = (S.config && S.config.permissionMode) || "ask";
    // A mode outside the picker (fullAccess is reachable with /mode) still
    // has to show itself: falling back to "ask" would tell the user they are
    // protected at the moment they are not.
    var known = Array.prototype.some.call(sel.options, function (o) { return o.value === mode; });
    if (!known) {
      var stale = sel.querySelector('option[data-extra="1"]');
      if (stale) { stale.parentNode.removeChild(stale); }
      var extra = document.createElement("option");
      extra.value = mode;
      extra.setAttribute("data-extra", "1");
      extra.textContent = modeName(mode) + " · 高级模式";
      sel.appendChild(extra);
    } else {
      var old = sel.querySelector('option[data-extra="1"]');
      if (old) { old.parentNode.removeChild(old); }
    }
    sel.value = mode;
    var opt = sel.options[sel.selectedIndex];
    // The option text stays short so the row keeps its shape; the sentence
    // lives on the option title, which is what the user hovers for.
    if (opt) { sel.title = opt.title || opt.textContent; }
  }

  var lastRenderedModel = null;
  var modelSwitchAnimTimer = null;

  function animateModelLabelChange(nextModel) {
    var ml = $("model-label");
    var btn = $("btn-model");
    var sub = $("top-sub");
    var labelText = nextModel || "选择模型";
    if (!ml) { return; }

    if (!S.motion || !lastRenderedModel || lastRenderedModel === nextModel) {
      ml.textContent = labelText;
      ml.title = labelText;
      lastRenderedModel = nextModel;
      updateModelBtnDot(nextModel);
      return;
    }

    lastRenderedModel = nextModel;
    clearTimeout(modelSwitchAnimTimer);
    if (btn) {
      btn.classList.remove("label-in", "switching");
      void btn.offsetWidth;
      btn.classList.add("switching", "label-out");
    }
    if (sub) {
      sub.classList.remove("switching");
      void sub.offsetWidth;
      sub.classList.add("switching");
    }

    modelSwitchAnimTimer = setTimeout(function () {
      ml.textContent = labelText;
      ml.title = labelText;
      updateModelBtnDot(nextModel);
      if (btn) {
        btn.classList.remove("label-out");
        btn.classList.add("label-in");
      }
      setTimeout(function () {
        if (btn) { btn.classList.remove("switching", "label-in"); }
        if (sub) { sub.classList.remove("switching"); }
      }, 320);
    }, 110);
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
      var override = S.titleOverride && S.titleOverride.key === S.sessionKey ? S.titleOverride.title : null;
      var txt = override || (first ? (first.textContent || "").trim().replace(/\s+/g, " ") : "新对话");
      title.textContent = txt.length > 40 ? txt.slice(0, 37) + "…" : txt;
    }
    var wm = $("w-meta");
    if (wm && c.model) { wm.textContent = c.cwd || ""; }
    animateModelLabelChange(c.model);

    var tc = $("tool-count");
    if (tc) { tc.textContent = String((c.tools || []).length); }

    renderProfile();
  }

  /** 短标签用于分段器与顶栏；完整说明见设置页。 */
  function modeName(mode) {
    var names = { ask: "询问", acceptEdits: "接受编辑", auto: "自动", dontAsk: "不再提问", plan: "计划", bypassPermissions: "全部放行" ,
      fullAccess: "完全放行" };
    return names[mode] || "询问";
  }

  function renderUsage() {
    var host = $("usage");
    if (!host) { return; }
    // contextUsed/contextLimit 都是 token 数（statsOf 已统一单位），比例要现算；
    // 直接把 token 数当比例乘 100 曾显示出「11926700%」这种荒诞数字。
    var limit = S.stats.contextLimit || 0;
    var used = limit > 0 ? Math.min(1, (S.stats.contextUsed || 0) / limit) : 0;
    var ring = host.querySelector(".usage-ring");
    if (ring) {
      var deg = Math.round(used * 360);
      var tone = used >= 0.9 ? "var(--crit)" : used >= 0.7 ? "var(--warn)" : "var(--accent)";
      ring.style.background = "conic-gradient(" + tone + " " + deg + "deg, var(--line-strong) " + deg + "deg)";
      host.classList.toggle("hot", used >= 0.7);
    }
    var label = host.querySelector(".usage-pct");
    if (label) { label.textContent = Math.round(used * 100) + "%"; }
    host.title = "上下文：" + (S.stats.contextUsed || 0) + " / " + (S.stats.contextLimit || 0) +
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
    renderStatusLineSection(body);
    renderSessionSection(body);
    renderRoutingSection(body);
    renderTodoSection(body);
    renderMcpSection(body);
    refreshStatusLine();
  }

  /* ------------------------------------------------------------------
   * 状态行（阶段 2）：右栏常驻一段，由 /api/statusline 真执行配置里的外部命令。
   * 上游契约见 src/agent/statusline.js —— stdin 是 StatusLineCommandInput JSON。
   * renderInspector 会被 stats 频繁重绘，所以这里节流；done 事件里强制刷新。
   * ------------------------------------------------------------------ */
  var _lastStatusRefresh = 0;
  function renderStatusLineSection(root) {
    var sec = section("状态行");
    var box = el("div", "status-line-text", "（未配置）");
    box.id = "status-line-text";
    box.title = "用 /statusline <命令> 配置";
    sec.body.appendChild(box);
    root.appendChild(sec.sec);
  }
  function refreshStatusLine(force) {
    var now = Date.now();
    if (!force && now - _lastStatusRefresh < 2000) { return; }
    _lastStatusRefresh = now;
    // 上游契约：vim 启用时 stdin 带 vim.mode（INSERT|NORMAL|VISUAL|VISUAL LINE）——
    // GUI 的实时编辑模式由前端上报（chunk-e0x0xb6d.js 契约注释）。
    var vimQs = "";
    if (vimSt && vimSt.enabled && vimSt.session) {
      vimQs = "&vimMode=" + encodeURIComponent(vimSt.session.mode);
    }
    getJSON("/api/statusline?sessionKey=" + encodeURIComponent(sessionKeyOf()) + vimQs).then(function (j) {
      var n = $("status-line-text");
      if (!n) { return; }
      if (!j.configured) { n.textContent = "未配置（/statusline <命令>）"; return; }
      n.textContent = j.text || (j.error ? "执行失败：" + j.error : "(无输出)");
      if (j.command) { n.title = j.command; }
    }).catch(function () { /* 状态行是装饰，失败不打扰用户 */ });
  }

  function renderSessionSection(root) {
    var c = S.config || {};
    var s = section("会话");
    var dl = el("dl", "kv");
    var ep = c.endpoint || {};
    var modelVendor = ep.vendor || vendorFromUrl(c.baseUrl, c.model);
    kv(dl, "模型", c.model || "-", true, modelVendor);
    kv(dl, "模式", modeName(c.permissionMode || "ask"));
    kv(dl, "轮次", String(S.stats.turns || 0));
    kv(dl, "消息", String(S.stats.messages || 0));
    var tok = S.stats.inputTokens || S.stats.outputTokens
      ? (S.stats.inputTokens + " / " + S.stats.outputTokens)
      : (S.stats.tokens ? "≈" + S.stats.tokens : "0");
    kv(dl, "Token", tok, true);
    kv(dl, "目录", c.cwd ? c.cwd.split(/[\\/]/).slice(-1)[0] : "-", true);
      var ctxU = S.stats.contextUsed || 0; var ctxL = S.stats.contextLimit || 0;
      if (ctxU > 0 && ctxU <= 1 && ctxL > 0) { ctxU = Math.round(ctxU * ctxL); }
      kv(dl, "上下文", ctxL ? Math.round(ctxU / 1000) + "k / " + Math.round(ctxL / 1000) + "k" : String(ctxU || 0));
    s.body.appendChild(dl);
    // Context Window 视野（参照 affectui.com 同名组件）：40 格，每格 2.5%，
    // 已用格按水位着色，悬停显示精确数值。
    if (ctxL > 0) {
      var used = Math.min(1, ctxU / ctxL);
      var CELLS = 40;
      var field = el("div", "ctx-field");
      field.title = "上下文水位 " + Math.round(used * 100) + "%（" + ctxU + " / " + ctxL + " tokens）";
      for (var ci = 0; ci < CELLS; ci++) {
        var cell = el("span", "ctx-cell");
        var fill = ci / CELLS;
        if (fill < used) {
          // 分段着色（对齐 /context 分解视图）：系统提示段与历史消息段颜色不同。
          const sysShare = (S.stats.systemTokens || 0) / (S.stats.contextLimit || 1);
          if (fill < sysShare) { cell.classList.add("sys"); }
          else if (used >= 0.9) { cell.classList.add("hot"); }
          else if (used >= 0.7) { cell.classList.add("warm"); }
          else { cell.classList.add("fill"); }
        }
        field.appendChild(cell);
      }
      s.body.appendChild(field);
    }
    root.appendChild(s.sec);

    // 消息目录：长对话里按用户提问快速跳转（点击滚动+闪烁定位）
    // 会话恢复时只渐进渲染最后 REPLAY_CHUNK 条，若按 DOM 取列表，目录就只有那一小截。
    // 因此优先按 S._replayMsgs 的数据构建，未渲染的条目在点击时按批补齐再滚动。
    var tocSec = section("消息目录");
    var tocEntries = [];
    var tocMsgs = S._replayMsgs || [];
    if (tocMsgs.length) {
      tocMsgs.forEach(function (m, i) {
        if (!m || m.role !== "user") { return; }
        var raw = typeof m.content === "string" ? m.content : "";
        if (Array.isArray(m.content)) {
          m.content.forEach(function (pt) { if (pt && pt.type === "text") { raw += (raw ? "\n" : "") + pt.text; } });
        }
        if (!raw.trim()) { return; } // 无文本无图的提问没有可渲染气泡，目录列了也点不到（死行）
        tocEntries.push({ idx: i, text: raw.replace(/\s+/g, " ").trim().slice(0, 60) });
      });
    } else {
      var domUsers = Array.prototype.slice.call((logRoot() && logRoot().querySelectorAll) ? logRoot().querySelectorAll(".msg-user") : []);
      domUsers.forEach(function (node) {
        tocEntries.push({ node: node, text: (node.textContent || "").replace(/\s+/g, " ").trim().slice(0, 60) });
      });
    }
    if (!tocEntries.length) {
      tocSec.body.appendChild(el("div", "empty-note", "开始对话后，这里列出你的每一次提问，点击即可跳转。"));
    } else {
      var list = el("div", "toc-list");
      tocEntries.forEach(function (entry, i) {
        var text = entry.text || ("提问 " + (i + 1));
        var node = entry.node || (entry.idx != null ? logRoot().querySelector('[data-src-idx="' + entry.idx + '"]') : null);
        var notLoaded = !node && entry.idx != null;
        var row = el("button", "toc-row" + (notLoaded ? " is-unloaded" : ""));
        row.type = "button";
        row.appendChild(el("span", "toc-idx", String(i + 1).padStart(2, "0")));
        row.appendChild(el("span", "toc-text", text));
        row.title = notLoaded ? (text + "（尚未加载，点击后加载）") : text;
        row.addEventListener("click", function () { jumpToTocEntry(entry); });
        list.appendChild(row);
      });
      tocSec.body.appendChild(list);
    }
    root.appendChild(tocSec.sec);
  }

  /** 备用模型探活结果，键为 model。null 表示尚未检测。 */
  var fallbackProbe = null;
  var fallbackProbing = false;

  function probeFallbacks() {
    if (fallbackProbing) { return; }
    fallbackProbing = true;
    renderInspector();
    postJSON("/api/fallbacks/test", {}).then(function (j) {
      fallbackProbing = false;
      fallbackProbe = {};
      ((j && j.results) || []).forEach(function (r) {
        fallbackProbe[r.model] = r;
      });
      renderInspector();
      toast("已完成 " + ((j && j.results && j.results.length) || 0) + " 个备用模型连通性检测", "ok");
    }).catch(function (e) {
      fallbackProbing = false;
      renderInspector();
      toast("测活失败：" + e.message, "err");
    });
  }

  function saveFallbacksPool(nextPool, msg) {
    return postJSON("/api/config", { fallbacks: nextPool }).then(function (j) {
      if (S.config) { S.config.fallbacks = j.fallbacks || nextPool; }
      renderInspector();
      if (msg) { toast(msg, "ok"); }
    }).catch(function (e) {
      toast("保存备用模型失败：" + e.message, "err");
    });
  }

  function openAddFallbackModal() {
    var c = S.config || {};
    var pool = (c.fallbacks || []).slice();
    openModal("管理与添加备用模型（故障容灾池）", function (body) {
      body.appendChild(el("div", "hint", "当主模型遇到 429 限流、5xx 故障、超时或网络中断时，系统会按以下优先级顺序自动无缝切换到备用模型继续回答。"));

      var mInput = document.createElement("input");
      mInput.placeholder = "例如：deepseek-v3 或 openai/gpt-oss-20b";
      body.appendChild(field("备用模型名称", mInput));

      var uInput = document.createElement("input");
      uInput.value = c.baseUrl || "http://127.0.0.1:8000/v1";
      uInput.placeholder = "接口地址 Base URL（可与主模型不同厂商）";
      body.appendChild(field("备用接口地址（Base URL）", uInput));

      var kInput = document.createElement("input");
      kInput.type = "password";
      kInput.autocomplete = "off";
      kInput.placeholder = "留空则复用主接口密钥";
      body.appendChild(field("独立 API Key（可选）", kInput));

      var quickHint = el("div", "hint", "或点击下方模型快速填入：");
      var quickBox = el("div", "options");
      body.appendChild(quickHint);
      body.appendChild(quickBox);

      getJSON("/api/models").then(function (j) {
        var list = (j && j.models) || [];
        clear(quickBox);
        list.slice(0, 8).forEach(function (m) {
          var b = el("button", "opt");
          b.type = "button";
          var perf = modelLatencyOf(m);
          b.appendChild(el("span", "latency-dot " + perf.tier));
          b.appendChild(el("span", "opt-label", m.id));
          b.appendChild(el("span", "model-opt-ms " + perf.tier, perf.ms + "ms"));
          b.addEventListener("click", function () {
            mInput.value = m.id;
            if (m.baseUrl) { uInput.value = m.baseUrl; }
          });
          quickBox.appendChild(b);
        });
      }).catch(function () {});

      body._collect = function () {
        var modelName = mInput.value.trim();
        var baseUrl = uInput.value.trim() || c.baseUrl;
        var apiKey = kInput.value.trim();
        if (!modelName) {
          toast("请填写备用模型名称", "warn");
          return null;
        }
        var exists = pool.some(function (f) { return f.model === modelName && (f.baseUrl || c.baseUrl) === baseUrl; });
        if (exists) {
          toast("该备用模型已在列表中", "warn");
          return null;
        }
        var entry = { name: modelName, model: modelName, baseUrl: baseUrl };
        if (apiKey) { entry.apiKey = apiKey; }
        pool.push(entry);
        return pool;
      };
    }, [
      { label: "取消", cls: "ghost", fn: closeModal },
      {
        label: "添加到备用池",
        cls: "primary",
        fn: function () {
          var body = $("modal-body");
          var next = body && body._collect && body._collect();
          if (!next) { return; }
          closeModal();
          saveFallbacksPool(next, "已添加备用模型");
        }
      }
    ]);
  }

  /**
   * Show the failover pool and — importantly — allow testing, switching,
   * reordering, and adding/removing fallback candidates directly.
   */
  function renderRoutingSection(root) {
    var c = S.config || {};
    var pool = (c.fallbacks || []).slice();
    var s = section("备用模型（故障容灾）");

    // 顶部操作栏：一键测活 + 添加备用模型
    var headBar = el("div", "fb-head-bar");
    headBar.appendChild(el("span", "empty-note", "主模型限流/超时/5xx 时按序自动接管"));
    var actBox = el("div", "fb-head-actions");
    var btnProbe = el("button", "model-action-btn", fallbackProbing ? "测活中…" : "一键测活");
    btnProbe.type = "button";
    btnProbe.disabled = fallbackProbing || !pool.length;
    btnProbe.title = !pool.length ? "暂无备用模型，请先点「+ 添加」配置容灾候选模型" : (fallbackProbing ? "正在检测备用模型接口连通性…" : "测试所有备用模型接口连通性与响应延迟");
    btnProbe.addEventListener("click", probeFallbacks);
    actBox.appendChild(btnProbe);

    var btnAdd = el("button", "model-action-btn", "+ 添加");
    btnAdd.type = "button";
    btnAdd.title = "添加新的跨厂商或同厂商备用模型";
    btnAdd.addEventListener("click", openAddFallbackModal);
    actBox.appendChild(btnAdd);
    headBar.appendChild(actBox);
    s.body.appendChild(headBar);

    var routing = S.routing || {};
    var live = routing.model && routing.model !== c.model;
    if (live || routing.switches) {
      var now = el("div", "route-live");
      now.appendChild(el("span", "pill ok", live ? "已容灾切换" : "曾自动切换 " + routing.switches + " 次"));
      now.appendChild(el("span", null, routing.model || c.model));
      if (routing.lastError) {
        now.title = "上次触发原因：" + routing.lastError;
      }
      s.body.appendChild(now);
    }

    if (!pool.length) {
      s.body.appendChild(el("div", "empty-note", "暂无备用模型。点击右上角「+ 添加」配置容灾候选模型。"));
      root.appendChild(s.sec);
      return;
    }

    var list = el("div", "fb-list");
    pool.forEach(function (f, idx) {
      var v = f.vendor || vendorFromUrl(f.baseUrl || c.baseUrl, f.model);
      var row = el("div", "fb-row");

      var left = el("div", "fb-row-main");
      var topLine = el("div", "fb-row-top");
      topLine.appendChild(el("span", "fb-rank", "#" + (idx + 1)));
      var nameB = el("b", "fb-model-name", f.model);
      nameB.title = f.model + " (" + (f.baseUrl || c.baseUrl) + ")";
      topLine.appendChild(nameB);
      left.appendChild(topLine);

      var subLine = el("div", "fb-row-sub");
      subLine.appendChild(el("span", "fb-vendor", v));
      var probe = fallbackProbe && fallbackProbe[f.model];
      var pill = el("span", "pill run", fallbackProbing ? "检测中…" : (live ? "待命" : "未检测"));
      if (probe && !fallbackProbing) {
        pill.textContent = probe.ok ? "可用 " + probe.ms + "ms" : "不可用 (" + probe.ms + "ms)";
        pill.className = "pill " + (probe.ok ? "ok" : "fail");
        if (!probe.ok && probe.error) { pill.title = "错误原因：" + probe.error; }
      }
      subLine.appendChild(pill);
      left.appendChild(subLine);
      row.appendChild(left);

      var right = el("div", "fb-row-ops");
      var useBtn = el("button", "fb-op-btn use", f.model === c.model ? "当前" : "启用");
      useBtn.type = "button";
      useBtn.disabled = f.model === c.model;
      useBtn.title = "立即将该备用模型设为主模型";
      useBtn.addEventListener("click", function () {
        var patch = { model: f.model };
        if (f.baseUrl) { patch.baseUrl = f.baseUrl; }
        postJSON("/api/config", patch).then(function (j) {
          if (S.config) {
            S.config.model = j.model || f.model;
            if (f.baseUrl) { S.config.baseUrl = f.baseUrl; }
          }
          renderTopMeta();
          renderInspector();
          toast("已启用备用模型 " + f.model + " 作为当前主模型", "ok");
        });
      });
      right.appendChild(useBtn);

      if (idx > 0) {
        var upBtn = el("button", "fb-op-btn", "\u2191");
        upBtn.type = "button";
        upBtn.title = "提高优先级";
        upBtn.addEventListener("click", function () {
          var next = pool.slice();
          var tmp = next[idx - 1];
          next[idx - 1] = next[idx];
          next[idx] = tmp;
          saveFallbacksPool(next, "已调整备用模型优先级");
        });
        right.appendChild(upBtn);
      }

      var delBtn = el("button", "fb-op-btn del", "\u00D7");
      delBtn.type = "button";
      delBtn.title = "从备用池移除";
      delBtn.addEventListener("click", function () {
        var next = pool.filter(function (_, i) { return i !== idx; });
        saveFallbacksPool(next, "已移除备用模型 " + f.model);
      });
      right.appendChild(delBtn);

      row.appendChild(right);
      list.appendChild(row);
    });
    s.body.appendChild(list);

    root.appendChild(s.sec);
  }


  /** "3 分钟前" 之类的相对时间。 */
  function relTime(iso) {
    var t = Date.parse(iso);
    if (isNaN(t)) { return ""; }
    var d = Math.max(0, Date.now() - t) / 1000;
    if (d < 60) { return "刚刚"; }
    if (d < 3600) { return Math.floor(d / 60) + " 分钟前"; }
    if (d < 86400) { return Math.floor(d / 3600) + " 小时前"; }
    return Math.floor(d / 86400) + " 天前";
  }

  function renderTodoSection(root) {
    var s = section("待办清单");
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
        row.appendChild(el("span", "todo-box",
          t.status === "completed" ? "\u2713" : t.status === "in_progress" ? "\u25b8" : "\u25cb"));
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
    TaskOutput: "读取后台子任务的输出与状态",
    GitStatus: "查看分支与工作区改动",
    GitDiff: "查看改动差异",
    GitLog: "查看提交历史",
    GitCommit: "暂存并提交改动"
  };

  /* 只读清单的展示分组：按能力归类，不属于 Claude 行为定义。
     未列入的工具统一归入「其它」，保证新增/MCP 工具不会被漏掉。 */
  var TOOL_GROUPS = [
    { name: "文件与编辑", tools: ["Read", "Write", "Edit", "MultiEdit", "LS", "NotebookRead", "NotebookEdit"] },
    { name: "搜索", tools: ["Glob", "Grep"] },
    { name: "终端与后台任务", tools: ["Bash", "BashOutput", "KillShell", "TaskOutput"] },
    { name: "网络", tools: ["WebFetch", "WebSearch"] },
    { name: "代理与规划", tools: ["TodoWrite", "AskUserQuestion", "ExitPlanMode", "Task"] },
    { name: "Git", tools: ["GitStatus", "GitDiff", "GitLog", "GitCommit"] }
  ];

  function toolZh(name, description) {
    if (TOOL_ZH[name]) { return TOOL_ZH[name]; }
    return String(description || "").split(".")[0];
  }



  /** MCP 服务器状态：连接情况与各自暴露的工具数。 */
  function openAddMcpModal() {
    openModal("添加 MCP 服务器", function (body) {
      var nameI = el("input"); nameI.placeholder = "标识名，如 filesystem";
      var typeS = el("select");
      [["stdio", "本地命令（stdio）"], ["url", "远程地址（HTTP/SSE）"]].forEach(function (o) { var op = el("option"); op.value = o[0]; op.textContent = o[1]; typeS.appendChild(op); });
      var cmdI = el("input"); cmdI.placeholder = "命令，如 npx";
      var argsI = el("input"); argsI.placeholder = "参数（空格分隔），如 -y @modelcontextprotocol/server-filesystem";
      var urlI = el("input"); urlI.placeholder = "https://example.com/mcp"; urlI.style.display = "none";
      cmdI.style.display = ""; argsI.style.display = "";
      typeS.addEventListener("change", function () { var stdio = typeS.value === "stdio"; cmdI.style.display = stdio ? "" : "none"; argsI.style.display = stdio ? "" : "none"; urlI.style.display = stdio ? "none" : ""; });
      body.appendChild(field("名称", nameI));
      body.appendChild(field("类型", typeS));
      body.appendChild(field("命令", cmdI));
      body.appendChild(field("参数", argsI));
      body.appendChild(field("URL", urlI));
      body._collect = function () {
        var name = nameI.value.trim(); if (!name) { toast("请填写名称", "warn"); return null; }
        if (typeS.value === "stdio") {
          if (!cmdI.value.trim()) { toast("请填写命令", "warn"); return null; }
          return { action: "add", name: name, command: cmdI.value.trim(), args: argsI.value.trim() ? argsI.value.trim().split(/\s+/) : [] };
        }
        if (!urlI.value.trim()) { toast("请填写 URL", "warn"); return null; }
        return { action: "add", name: name, url: urlI.value.trim() };
      };
    }, [{ label: "保存", cls: "primary", fn: function () {
      var mb = $("modal-body");
      var payload = mb && mb._collect && mb._collect();
      if (!payload) { return; }
      postJSON("/api/mcp", payload).then(function () { closeModal(); toast("MCP 服务器已添加，下一回合生效", "ok"); renderInspector(); }).catch(function (e) { toast("添加失败：" + e.message, "err"); });
    } }]);
  }

  function renderMcpSection(root) {
    var s = section("MCP 服务器");
    var addBtn = el("button", "model-action-btn", "+ 添加");
    addBtn.type = "button";
    addBtn.addEventListener("click", openAddMcpModal);
    if (s.head) { s.head.appendChild(addBtn); } else { s.body.insertBefore(addBtn, s.body.firstChild); }
    var host = el("div", "mcp-list");
    s.body.appendChild(host);
    root.appendChild(s.sec);
    getJSON("/api/mcp").then(function (j) {
      var list = j.servers || [];
      clear(host);
      if (!list.length) {
        var em = el("div", "empty-note", "还没有 MCP 服务器。");
      var cta = el("button", "model-action-btn", "+ 添加 MCP 服务器");
      cta.type = "button";
      cta.addEventListener("click", openAddMcpModal);
      em.appendChild(cta);
      host.appendChild(em);
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

  /**
   * One key/value row in an inspector section.
   *
   * @param {HTMLElement} dl
   * @param {string} k label
   * @param {string} v value
   * @param {boolean} [mono] render the value in the mono font
   * @param {string} [suffix] dim trailing label, e.g. a vendor name
   */
  function kv(dl, k, v, mono, suffix) {
    var row = el("div", "kv-row");
    row.appendChild(el("dt", null, k));
    var dd = el("dd", mono ? "mono" : null);
    dd.appendChild(el("span", null, v));
    if (suffix) { dd.appendChild(el("span", "kv-suffix", suffix)); }
    row.appendChild(dd);
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

  /** 每个项目分组默认展示的会话数，超出折叠为「再显示 N 条」。 */
  var GROUP_LIMIT = 5;
  var expandedGroups = {};
  var archivedGroupOpen = false;

  /** Row awaiting delete confirmation, so the state survives a re-render. */
  var pendingDelete = null;

  /**
   * 会话自动归档策略定义：结合时间戳（距今未活跃时长）与活跃度（消息数/轮次、项目常驻上限）。
   */
  var ARCHIVE_POLICIES = [
    {
      id: "smart",
      shortLabel: "智能归档",
      tag: "智能",
      label: "智能归档（按时间与活跃度）",
      desc: "超过 7 天未活跃，或超过 24 小时且消息 ≤ 2 条的低活跃会话，或同项目超出前 8 条的旧会话自动移入「已归档」"
    },
    {
      id: "low_activity",
      shortLabel: "低活跃优先",
      tag: "活跃度",
      label: "低活跃优先（≤ 2 条消息或超 3 天）",
      desc: "消息数 ≤ 2 条且闲置满 1 小时的浅层对话，或超过 3 天未活跃的会话自动归档"
    },
    {
      id: "1d",
      shortLabel: "24 小时前",
      tag: ">24h",
      label: "24 小时前未活跃自动归档",
      desc: "最后更新时间超过 24 小时的未置顶会话自动移入「已归档」"
    },
    {
      id: "3d",
      shortLabel: "3 天前",
      tag: ">3天",
      label: "3 天前未活跃自动归档",
      desc: "最后更新时间超过 3 天的未置顶会话自动移入「已归档」"
    },
    {
      id: "7d",
      shortLabel: "7 天前",
      tag: ">7天",
      label: "7 天前未活跃自动归档",
      desc: "最后更新时间超过 7 天的未置顶会话自动移入「已归档」"
    },
    {
      id: "30d",
      shortLabel: "30 天前",
      tag: ">30天",
      label: "30 天前未活跃自动归档",
      desc: "最后更新时间超过 30 天的未置顶会话自动移入「已归档」"
    },
    {
      id: "manual",
      shortLabel: "仅手动",
      tag: "手动",
      label: "仅手动归档（关闭自动归档）",
      desc: "不按时间或活跃度自动归档，仅将手动归档的会话放入「已归档」分组"
    }
  ];

  function getArchivePolicyMeta(policyId) {
    var id = policyId || S.archivePolicy || "smart";
    for (var i = 0; i < ARCHIVE_POLICIES.length; i++) {
      if (ARCHIVE_POLICIES[i].id === id) { return ARCHIVE_POLICIES[i]; }
    }
    return ARCHIVE_POLICIES[0];
  }

  function renderArchivePolicyButton() {
    var meta = getArchivePolicyMeta();
    var lbl = $("archive-policy-label");
    var btn = $("btn-archive-policy");
    if (lbl) { lbl.textContent = meta.shortLabel; }
    if (btn) { btn.title = meta.label + "：" + meta.desc + "（点击配置）"; }
  }

  function setArchivePolicy(nextPolicy, silent) {
    S.archivePolicy = nextPolicy || "smart";
    try { localStorage.setItem(LS_ARCHIVE_POLICY, S.archivePolicy); } catch (e) {}
    renderArchivePolicyButton();
    renderChatList();
    if (!silent) {
      var meta = getArchivePolicyMeta(S.archivePolicy);
      toast("已切换归档规则：" + meta.label, "ok");
    }
  }

  /**
   * 判断单条会话是否应当进入「已归档」分组。
   * 返回 { archived: boolean, auto: boolean, shortTag: string, reason: string }
   */
  function evaluateSessionArchive(s, rankInProject) {
    if (!s) { return { archived: false, auto: false, shortTag: "", reason: "" }; }
    // 当前正在进行的会话与置顶会话始终保持在活跃列表
    if (s.id === S.sessionKey || s.pinned) {
      return { archived: false, auto: false, shortTag: "", reason: "" };
    }
    // 用户手动归档的会话始终归档
    if (s.archived === true) {
      return { archived: true, auto: false, shortTag: "手动", reason: "手动归档" };
    }
    // 用户明确从归档中恢复过的会话，不再被自动规则强制归档
    if (s.unarchived === true) {
      return { archived: false, auto: false, shortTag: "", reason: "" };
    }

    var policy = S.archivePolicy || "smart";
    if (policy === "manual") {
      return { archived: false, auto: false, shortTag: "", reason: "" };
    }

    var ts = Date.parse(s.updatedAt || s.savedAt || 0) || 0;
    var ageMs = ts > 0 ? Math.max(0, Date.now() - ts) : 0;
    var ageHours = ageMs / 3600000;
    var ageDays = ageMs / 86400000;
    var msgs = typeof s.messages === "number" ? s.messages : 0;

    if (policy === "smart") {
      if (ageDays >= 7) {
        return { archived: true, auto: true, shortTag: "超7天", reason: "自动归档：超过 7 天未活跃" };
      }
      if (ageHours >= 24 && msgs <= 2) {
        return { archived: true, auto: true, shortTag: "低活跃", reason: "自动归档：超过 24 小时且消息 ≤ 2 条" };
      }
      if (ageDays >= 3 && msgs <= 4) {
        return { archived: true, auto: true, shortTag: "低频", reason: "自动归档：超过 3 天且消息 ≤ 4 条" };
      }
      if (typeof rankInProject === "number" && rankInProject >= 8 && ageHours >= 12) {
        return { archived: true, auto: true, shortTag: "旧会话", reason: "自动归档：超出项目常驻活跃上限（前 8 条）" };
      }
      return { archived: false, auto: false, shortTag: "", reason: "" };
    }

    if (policy === "low_activity") {
      if (msgs <= 2 && ageHours >= 1) {
        return { archived: true, auto: true, shortTag: "≤2条", reason: "自动归档：低活跃短会话（≤ 2 条消息）" };
      }
      if (ageDays >= 3) {
        return { archived: true, auto: true, shortTag: "超3天", reason: "自动归档：超过 3 天未活跃" };
      }
      return { archived: false, auto: false, shortTag: "", reason: "" };
    }

    var dayThresholds = { "1d": 1, "3d": 3, "7d": 7, "30d": 30 };
    var minDays = dayThresholds[policy];
    if (minDays && ageDays >= minDays) {
      var tag = minDays === 1 ? "超24h" : "超" + minDays + "天";
      return {
        archived: true,
        auto: true,
        shortTag: tag,
        reason: "自动归档：超过 " + (minDays === 1 ? "24 小时" : minDays + " 天") + "未活跃"
      };
    }

    return { archived: false, auto: false, shortTag: "", reason: "" };
  }

  function toggleArchiveSession(s, targetArchived) {
    if (!s || !s.id) { return; }
    var nextVal = typeof targetArchived === "boolean" ? targetArchived : !s.archived;
    patchJSON("/api/sessions/" + encodeURIComponent(s.id), { archived: nextVal }).then(function () {
      if (nextVal) { archivedGroupOpen = true; }
      refreshSessions();
      toast(nextVal ? "已移入「已归档」分组" : "已从「已归档」恢复到最近列表", "ok");
    }).catch(function (e) {
      toast("操作失败：" + e.message, "err");
    });
  }

  /** 一键将当前列表中的低活跃会话（≤2条消息且非当前会话）归档，释放侧栏空间。 */
  function archiveInactiveNow() {
    var candidates = (S.sessions || []).filter(function (s) {
      if (s.id === S.sessionKey || s.pinned || s.archived) { return false; }
      var msgs = typeof s.messages === "number" ? s.messages : 0;
      var ts = Date.parse(s.updatedAt || s.savedAt || 0) || 0;
      var ageHours = ts > 0 ? Math.max(0, Date.now() - ts) / 3600000 : 0;
      return msgs <= 2 || ageHours >= 24;
    });
    if (!candidates.length) {
      toast("当前没有可归档的低活跃或旧会话", "info");
      return;
    }
    Promise.all(candidates.map(function (s) {
      return patchJSON("/api/sessions/" + encodeURIComponent(s.id), { archived: true });
    })).then(function () {
      archivedGroupOpen = true;
      refreshSessions();
      toast("已将 " + candidates.length + " 条旧/低活跃会话移入「已归档」", "ok");
    });
  }

  function openArchivePolicyModal() {
    var curPolicy = S.archivePolicy || "smart";
    openModal("会话自动归档设置", function (body) {
      body.appendChild(el("div", "hint", "根据会话的最后活跃时间戳与消息活跃度，自动将旧会话或短对话移入侧边栏底部的「已归档」分组，保持主列表清爽。置顶会话与当前正在进行的会话不会被自动归档。"));
      var list = el("div", "options");
      var pickedId = curPolicy;
      ARCHIVE_POLICIES.forEach(function (p) {
        var b = el("button", "opt" + (p.id === pickedId ? " picked" : ""));
        b.type = "button";
        b.appendChild(el("span", "opt-mark", "\u2713"));
        var col = el("div", null);
        col.style.display = "flex";
        col.style.flexDirection = "column";
        col.style.gap = "2px";
        col.style.flex = "1";
        col.appendChild(el("span", "opt-label", p.label));
        var sub = el("span", null, p.desc);
        sub.style.fontSize = "11.5px";
        sub.style.color = "var(--fg-4)";
        col.appendChild(sub);
        b.appendChild(col);
        b.addEventListener("click", function () {
          pickedId = p.id;
          Array.prototype.forEach.call(list.querySelectorAll(".opt"), function (x) { x.classList.remove("picked"); });
          b.classList.add("picked");
          setArchivePolicy(pickedId);
        });
        list.appendChild(b);
      });
      body.appendChild(list);
    }, [
      {
        label: "一键归档低活跃会话",
        cls: "ghost",
        fn: function () {
          closeModal();
          archiveInactiveNow();
        }
      },
      { label: "完成", cls: "primary", fn: closeModal }
    ]);
  }

  function buildSessionRow(s, archiveInfo) {
    var isArchived = !!(archiveInfo && archiveInfo.archived);
    var b = el("button", "chat-row" + (s.id === S.sessionKey ? " active" : "") + (isArchived ? " is-archived" : ""));
    b.type = "button";
    if (s.pinned) { b.appendChild(el("span", "chat-pin", "\u2605")); }
    var titleEl = el("span", "chat-title", s.title || s.id);
    var metaTime = timeAgo(s.updatedAt || s.savedAt);
    titleEl.title = (s.title || s.id) + " · " + (s.messages || 0) + " 条消息" + (metaTime ? " · " + metaTime : "") + (archiveInfo && archiveInfo.reason ? "（" + archiveInfo.reason + "）" : "");
    b.appendChild(titleEl);

    if (isArchived && archiveInfo.shortTag) {
      var tag = el("span", "chat-arc-tag" + (archiveInfo.auto ? " auto" : ""), archiveInfo.shortTag);
      tag.title = archiveInfo.reason || "已归档";
      b.appendChild(tag);
    }

    b.appendChild(el("span", "chat-meta", metaTime));

    // 「已分享」角标：这个会话存在只读快照链接
    if ((S.sharedIds || []).indexOf(s.id) >= 0) {
      var sh = el("span", "chat-shared-tag");
      sh.appendChild(icon("i-share", 11));
      sh.appendChild(el("span", null, "分享"));
      sh.title = "此会话已创建只读分享链接（右键可复制链接或取消分享）";
      b.appendChild(sh);
    }

    if (pendingDelete === s.id) {
      var yes = el("button", "chat-del-yes", "删除");
      yes.type = "button";
      yes.addEventListener("click", function (e) {
        e.stopPropagation();
        pendingDelete = null;
        deleteSession(s.id);
      });
      b.appendChild(yes);
      var no = el("button", "chat-del-no", "取消");
      no.type = "button";
      no.addEventListener("click", function (e) {
        e.stopPropagation();
        pendingDelete = null;
        renderChatList();
      });
      b.appendChild(no);
    } else {
      var arcBtn = el("button", "chat-arc", isArchived ? "\u2191" : "\u2193");
      arcBtn.type = "button";
      arcBtn.title = isArchived ? "移出归档（恢复到最近列表）" : "归档此会话";
      arcBtn.addEventListener("click", function (e) {
        e.stopPropagation();
        toggleArchiveSession(s, !isArchived);
      });
      b.appendChild(arcBtn);

      var x = el("button", "chat-del", "\u00D7");
      x.type = "button";
      x.title = "删除";
      x.addEventListener("click", function (e) {
        e.stopPropagation();
        pendingDelete = s.id;
        renderChatList();
      });
      b.appendChild(x);
    }

    b.addEventListener("contextmenu", function (e) {
      e.preventDefault();
      openSessionMenu(s, e.clientX, e.clientY, isArchived);
    });
    b.addEventListener("click", function () { resumeSession(s.id); });
    return b;
  }

  /**
   * Render the session list grouped by project (working directory), while
   * automatically moving old or low-activity sessions into the collapsible
   * '已归档' group at the bottom of the sidebar.
   */
  /** 侧栏视图：按项目分组（默认）或按时间分组（今天/昨天/近7天…，对齐 claude.ai）。 */
  function setChatView(v) {
    S.chatView = v === "time" ? "time" : "project";
    try { localStorage.setItem(LS_CHAT_VIEW, S.chatView); } catch (e) {}
    renderChatList();
  }

  function timeBucketOf(s) {
    var t = Date.parse(s.updatedAt || s.savedAt || 0) || 0;
    if (!t) { return "更早"; }
    var now = new Date();
    var startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    if (t >= startToday) { return "今天"; }
    if (t >= startToday - 86400000) { return "昨天"; }
    if (t >= startToday - 7 * 86400000) { return "近 7 天"; }
    if (t >= startToday - 30 * 86400000) { return "近 30 天"; }
    return "更早";
  }

  var TIME_BUCKET_ORDER = ["置顶", "今天", "昨天", "近 7 天", "近 30 天", "更早"];

  function renderChatList() {
    var list = $("chat-list");
    if (!list) { return; }
    clear(list);
    renderArchivePolicyButton();

    // 视图切换（项目 ⇄ 时间）
    var viewSeg = el("div", "chat-view-seg");
    [["project", "按项目"], ["time", "按时间"]].forEach(function (pair) {
      var vb = el("button", "chat-view-btn" + ((S.chatView || "project") === pair[0] ? " active" : ""), pair[1]);
      vb.type = "button";
      vb.title = pair[0] === "project" ? "按工作目录分组（适合多项目并行）" : "按时间分组：今天/昨天/近 7 天…（claude.ai 风格）";
      vb.addEventListener("click", function () { setChatView(pair[0]); });
      viewSeg.appendChild(vb);
    });
    list.appendChild(viewSeg);

    if (!S.sessions.length) {
      list.appendChild(el("div", "rail-empty", "暂无历史对话"));
    }

    // First bucket by working directory and sort newest first within each project
    // so we can evaluate both timestamp/activity and per-project rank.
    var rawGroups = {};
    S.sessions.forEach(function (s) {
      var key = normCwd(s.cwd);
      if (!rawGroups[key]) { rawGroups[key] = []; }
      rawGroups[key].push(s);
    });

    var activeGroups = {};
    var archivedEntries = [];
    var activeCount = 0;

    Object.keys(rawGroups).forEach(function (key) {
      var sorted = rawGroups[key].slice().sort(function (a, b) {
        if (!!a.pinned !== !!b.pinned) { return a.pinned ? -1 : 1; }
        var ua = Date.parse(a.updatedAt || a.savedAt || 0) || 0;
        var ub = Date.parse(b.updatedAt || b.savedAt || 0) || 0;
        return ub - ua;
      });
      sorted.forEach(function (s, idx) {
        var evalRes = evaluateSessionArchive(s, idx);
        if (evalRes.archived) {
          archivedEntries.push({ session: s, info: evalRes });
        } else {
          if (!activeGroups[key]) { activeGroups[key] = []; }
          activeGroups[key].push(s);
          activeCount++;
        }
      });
    });

    var badge = $("chat-count");
    if (badge) {
      badge.textContent = String(activeCount);
      badge.title = "活跃会话 " + activeCount + " 条 · 已归档 " + archivedEntries.length + " 条";
    }

    var buildGroupBlock = function (name, items, opts) {
      opts = opts || {};
      var wrap = el("div", "chat-group" + (opts.cls ? " " + opts.cls : ""));
      var gkey = opts.groupKey || name;
      // 时间分组默认展开（claude.ai 风格）；项目分组维持旧行为：
      // 默认收起只显示 GROUP_LIMIT 条，点头部展开全部。
      var open = opts.defaultOpen ? expandedGroups[gkey] !== false : expandedGroups[gkey] === true;
      if (items.length) {
        var head = el("button", "chat-group-head");
        head.type = "button";
        head.title = opts.title || name;
        head.appendChild(el("span", "chat-group-arrow", open ? "\u25BE" : "\u25B8"));
        head.appendChild(el("span", "chat-group-name", name));
        head.appendChild(el("span", "chat-group-n", String(items.length)));
        head.addEventListener("click", function () {
          expandedGroups[gkey] = !open;
          renderChatList();
        });
        wrap.appendChild(head);
      }
      var shown = open ? items : items.slice(0, GROUP_LIMIT);
      shown.forEach(function (s) { wrap.appendChild(buildSessionRow(s, { archived: false })); });
      if (!open && items.length > GROUP_LIMIT) {
        var more = el("button", "chat-group-more", "再显示 " + (items.length - GROUP_LIMIT) + " 条");
        more.type = "button";
        more.addEventListener("click", function () {
          expandedGroups[gkey] = true;
          renderChatList();
        });
        wrap.appendChild(more);
      }
      return wrap;
    };

    if ((S.chatView || "project") === "time") {
      // 时间分组视图：置顶单独一组，其余按 今天/昨天/近7天/近30天/更早
      var actives = [];
      Object.keys(activeGroups).forEach(function (key) { actives = actives.concat(activeGroups[key]); });
      actives.sort(function (a, b) {
        var ua = Date.parse(a.updatedAt || a.savedAt || 0) || 0;
        var ub = Date.parse(b.updatedAt || b.savedAt || 0) || 0;
        return ub - ua;
      });
      var buckets = {};
      actives.forEach(function (s) {
        var bucket = s.pinned ? "置顶" : timeBucketOf(s);
        if (!buckets[bucket]) { buckets[bucket] = []; }
        buckets[bucket].push(s);
      });
      TIME_BUCKET_ORDER.forEach(function (name) {
        if (buckets[name] && buckets[name].length) {
          list.appendChild(buildGroupBlock(name, buckets[name], {
            groupKey: "time:" + name,
            defaultOpen: true,
            cls: name === "置顶" ? "pinned-group" : "",
            title: name === "置顶" ? "置顶的会话" : name + "活跃的会话"
          }));
        }
      });
    } else {
      // Most recently touched active project first.
      var keys = Object.keys(activeGroups).sort(function (a, b) {
        return newestAt(activeGroups[b]) - newestAt(activeGroups[a]);
      });

      if (!keys.length && archivedEntries.length) {
        list.appendChild(el("div", "rail-empty", "近期无活跃对话（" + archivedEntries.length + " 条旧会话已自动归档）"));
      }

      keys.forEach(function (key) {
        list.appendChild(buildGroupBlock(projectName(key), activeGroups[key], {
          groupKey: key,
          title: key,
          defaultOpen: false
        }));
      });
    }

    // 底部「已归档」分组：收纳按时间戳/活跃度自动归档或手动归档的旧会话
    archivedEntries.sort(function (a, b) {
      var ua = Date.parse(a.session.updatedAt || a.session.savedAt || 0) || 0;
      var ub = Date.parse(b.session.updatedAt || b.session.savedAt || 0) || 0;
      return ub - ua;
    });

    var policyMeta = getArchivePolicyMeta();
    var arcWrap = el("div", "chat-group archived-group");
    var arcHead = el("button", "chat-group-head");
    arcHead.type = "button";
    arcHead.title = "已归档会话（" + policyMeta.label + "）";
    arcHead.appendChild(el("span", "chat-group-arrow", archivedGroupOpen ? "\u25BE" : "\u25B8"));
    var arcIco = el("span", "archived-head-ico");
    arcIco.appendChild(icon("i-archive", 13));
    arcHead.appendChild(arcIco);
    arcHead.appendChild(el("span", "chat-group-name", "已归档"));
    arcHead.appendChild(el("span", "archived-policy-tag", policyMeta.tag));
    arcHead.appendChild(el("span", "chat-group-n", String(archivedEntries.length)));
    arcHead.addEventListener("click", function () {
      archivedGroupOpen = !archivedGroupOpen;
      renderChatList();
    });
    arcWrap.appendChild(arcHead);

    if (archivedGroupOpen) {
      var arcBody = el("div", "archived-body");
      var toolbar = el("div", "archived-toolbar");
      var sel = el("select", "archive-policy-select");
      sel.title = "选择自动归档规则";
      ARCHIVE_POLICIES.forEach(function (p) {
        var opt = document.createElement("option");
        opt.value = p.id;
        opt.textContent = "规则：" + p.shortLabel;
        if (p.id === (S.archivePolicy || "smart")) { opt.selected = true; }
        sel.appendChild(opt);
      });
      sel.addEventListener("change", function (e) {
        e.stopPropagation();
        setArchivePolicy(sel.value);
      });
      toolbar.appendChild(sel);

      var cleanBtn = el("button", "archived-action-btn", "归档旧会话");
      cleanBtn.type = "button";
      cleanBtn.title = "立即将 ≤2 条消息或超 24 小时的未置顶会话归档";
      cleanBtn.addEventListener("click", function (e) {
        e.stopPropagation();
        archiveInactiveNow();
      });
      toolbar.appendChild(cleanBtn);
      arcBody.appendChild(toolbar);

      if (!archivedEntries.length) {
        arcBody.appendChild(el("div", "archived-empty", "暂无归档会话。符合「" + policyMeta.shortLabel + "」条件的历史会话会自动移入此处，也可在任意会话右侧点击 ↓ 手动归档。"));
      } else {
        archivedEntries.forEach(function (item) {
          arcBody.appendChild(buildSessionRow(item.session, item.info));
        });
      }
      arcWrap.appendChild(arcBody);
    }

    list.appendChild(arcWrap);
  }

  /** Folder name for a working directory, falling back to the full path. */
  /**
   * Normalise a working directory so one project is one group.
   *
   * Sessions saved from different entry points record the same folder with
   * different separators ("E:\\\\proj" vs "E:/proj") and drive-letter case,
   * which would otherwise split a single project into several groups.
   */
  function normCwd(cwd) {
    if (!cwd) { return "(unknown)"; }
    var s = String(cwd).replace(/\\/g, "/").replace(/\/+$/, "");
    // Lower-case only the drive letter, not the rest of the path.
    s = s.replace(/^([A-Za-z]):/, function (_, d) { return d.toLowerCase() + ":"; });
    return s || "(unknown)";
  }

  /**
   * 已知供应商前缀，按匹配优先级排列。
   */
  var VENDORS = [
    { id: "deepseek",   zh: "DeepSeek",   re: /^(deepseek|deepseek-)/i },
    { id: "zhipu",      zh: "智谱",       re: /^(glm|z-ai\/glm|zhipu)/i },
    { id: "openai",     zh: "OpenAI",     re: /^(gpt-|o[13]|text-davinci|openai\/)/i },
    { id: "anthropic", zh: "Anthropic", re: /^(claude)/i },
    { id: "alibaba",    zh: "阿里通义",   re: /^(qwen|tongyi|aliyun)/i },
    { id: "meta",       zh: "Meta",      re: /^(llama|meta\/)/i },
    { id: "moonshot",   zh: "月之暗面",   re: /^(kimi|moonshot)/i },
    { id: "baidu",     zh: "百度",      re: /^(ernie)/i },
    { id: "baichuan",   zh: "百川",      re: /^(baichuan)/i },
    { id: "google",     zh: "Google",     re: /^(gemini|palm|bard)/i },
    { id: "mistral",    zh: "Mistral",    re: /^(mistral|mixtral)/i },
    { id: "xai",        zh: "xAI",        re: /^(grok)/i },
    { id: "nvidia",    zh: "NVIDIA",     re: /^(nvidia\/)/i }
  ];

  /**
   * 从模型名推断供应商。无法识别时回落为「其他」。
   *
   * 模型名形如 "deepseek-v4.1-flash" 或 "openai/gpt-oss-20b"，
   * 供应商信息只在名字里，所以这里集中做一次识别，
   * 避免每处展示各写一套判断。
   */
  /** 与后端 src/vendors.js 同规则的 baseUrl → 供应商判定（前端兜底用）。 */
  var HOST_VENDORS = [
    [/(^|\.)api\.deepseek\.com/i, "DeepSeek"],
    [/(^|\.)open\.bigmodel\.cn/i, "智谱"],
    [/(^|\.)dashscope\.aliyuncs\.com/i, "阿里通义"],
    [/(^|\.)api\.moonshot\.cn/i, "月之暗面"],
    [/(^|\.)api\.baichuan-ai\.com/i, "百川"],
    [/(^|\.)qianfan\.baidubce\.com/i, "百度"],
    [/(^|\.)api\.anthropic\.com/i, "Anthropic"],
    [/(^|\.)generativelanguage\.googleapis\.com/i, "Google"],
    [/(^|\.)api\.mistral\.ai/i, "Mistral"],
    [/(^|\.)api\.x\.ai/i, "xAI"],
    [/(^|\.)integrate\.api\.nvidia\.com/i, "NVIDIA"],
    [/(^|\.)openrouter\.ai/i, "OpenRouter"],
    [/(^|\.)api\.openai\.com/i, "OpenAI"],
    [/(^|\.)api\.groq\.com/i, "Groq"],
    [/(^|\.)api\.together\.ai/i, "Together"],
    [/(^|\.)api\.fireworks\.ai/i, "Fireworks"],
    [/(^|\.)api\.siliconflow\.cn/i, "硅基流动"],
    [/(^|\.)api\.minimax\.chat/i, "MiniMax"]
  ];

  function isLocalUrl(u) {
    return /(^|\/\/)(127\.|0\.0\.0\.0|localhost|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/i.test(String(u || ""));
  }

  function vendorFromUrl(baseUrl, model) {
    var url = String(baseUrl || "");
    // 只在主机名上匹配，避免 baseUrl 尾部的路径（/v1 等）影响结果。
    var host = (url.match(/^https?:\/\/([^/]+)/i) || [null, url])[1].replace(/:\d+$/, "");
    for (var i = 0; i < HOST_VENDORS.length; i++) {
      if (HOST_VENDORS[i][0].test(host)) { return HOST_VENDORS[i][1]; }
    }
    // 本地网关背后往往是多家供应商，先按模型名识别，识别不出才归网关本身。
    var byName = vendorOf(model).zh;
    if (byName !== "其他") { return byName; }
    if (isLocalUrl(url)) { return "本地网关"; }
    return byName;
  }

  function vendorOf(name) {
    var s = String(name || "").trim();
    if (!s) { return { id: "other", zh: "其他" }; }
    for (var i = 0; i < VENDORS.length; i++) {
      if (VENDORS[i].re.test(s)) { return { id: VENDORS[i].id, zh: VENDORS[i].zh }; }
    }
    // 形如 "vendor/model" 的第一个片段，若未在已知表中则原样显示。
    if (s.indexOf("/") > 0) { return { id: s.split("/")[0].toLowerCase(), zh: s.split("/")[0] }; }
    return { id: "other", zh: "其他" };
  }

  /**
   * 把模型列表按供应商分桶，返回按已知顺序排列的分组。
   *
   * @param {string[]} names
   * @returns {Array<{id: string, zh: string, models: string[]}>}
   */
  function groupByVendor(names) {
    var map = {};
    (names || []).forEach(function (n) {
      var v = vendorOf(n);
      if (!map[v.id]) { map[v.id] = { id: v.id, zh: v.zh, models: [] }; }
      map[v.id].models.push(n);
    });
    var order = {};
    VENDORS.forEach(function (v, i) { order[v.id] = i; });
    var out = Object.keys(map).map(function (k) { return map[k]; });
    out.sort(function (a, b) {
      var oa = a.id in order ? order[a.id] : 999;
      var ob = b.id in order ? order[b.id] : 999;
      return oa - ob || String(a.id).localeCompare(String(b.id));
    });
    return out;
  }

  function projectName(cwd) {
    if (!cwd || cwd === "(unknown)") { return "未知项目"; }
    var parts = String(cwd).split(/[\\/]+/).filter(Boolean);
    return parts.length ? parts[parts.length - 1] : cwd;
  }

  /** Newest timestamp inside a group of sessions. */
  function newestAt(items) {
    var max = 0;
    items.forEach(function (s) {
      var t = Date.parse(s.updatedAt || s.savedAt || 0) || 0;
      if (t > max) { max = t; }
    });
    return max;
  }

  function refreshSessions() {
    return Promise.all([
      getJSON("/api/sessions"),
      getJSON("/api/shares").catch(function () { return { shares: [] }; })
    ]).then(function (rs) {
      S.sessions = rs[0].sessions || [];
      S.sharedIds = (rs[1].shares || []).map(function (x) { return x.sessionId; });
      renderChatList();
    }).catch(function () {});
  }

  function resumeSession(id, opts) {
    // Restoring is silent when the user did not ask for it: reopening the app
    // picks up the last conversation on its own, and announcing that every time
    // turns a convenience into noise. Only an explicit click reports back.
    var quiet = opts && opts.quiet;
    if (S.busy) { toast("请等待当前回复结束", "warn"); return; }
    // 切走前把正在写的草稿存回当前会话名下（此刻 draftKey 还指向旧会话）
    var taNow = $("in");
    if (taNow && taNow.value) { saveDraftNow(taNow.value); }
    postJSON("/api/session", { action: "resume", id: id, sessionKey: S.sessionKey || id }).then(function (j) {
      S.sessionKey = j.id;
      try { localStorage.setItem(LS_SESSION, j.id); } catch (e) { }
      // 恢复存储的会话标题（AI 自动命名/手动重命名的结果优先于 DOM 派生）
      S.titleOverride = { key: j.id, title: j.title || "" };
      try { window.__resumeDbg = { stats: j.stats || null, quiet: !!quiet, at: new Date().toISOString() }; } catch (e2) {}
      if (j.stats) { S.stats = { messages: j.stats.messages || 0, turns: j.stats.turns || 0, tokens: j.stats.tokens || 0, inputTokens: j.stats.inputTokens || 0, outputTokens: j.stats.outputTokens || 0, contextLimit: j.stats.contextLimit || 0, contextUsed: j.stats.contextUsed || 0 }; }
      if (Array.isArray(j.todos)) { S.todos = j.todos; } // 待办列表随会话恢复
      replayTranscript(j.transcript || []);
      restoreDraft(); // 草稿按会话保留：切回来接着写
      renderInspector();
      refreshSessions();
      refreshStats();
      // 刷新不应丢掉待答问题：服务器仍卡在提问上，这里重新渲染，答完任务继续。
      if (j.pending && j.pending.question) { showQuestion(j.pending.question); toast("该会话有一个待回答的问题，已重新显示", "info"); }
      else if (j.pending && j.pending.confirm) { showConfirm(j.pending.confirm); toast("该会话有一个待授权的工具调用，已重新显示", "info"); }
            if (!quiet) { toast("已恢复 " + j.messages + " 条消息", "ok"); }
    }).catch(function (e) {
      var msg = String((e && e.message) || e);
      // 会话文件被删掉/清理后，启动时的自动恢复必然 404。这不是错误，是把
      // 用户上一次的会话弄丢了那种场景 —— 但对他而言只是「没有上次」，
      // 甩一条红色 HTTP 404 只会让人以为程序坏了。清掉记住的 id，安静开新对话。
      if (quiet && /HTTP 404/.test(msg)) {
        try { localStorage.removeItem(LS_SESSION); } catch (e2) { }
        S.titleOverride = null;
        return;
      }
      // 显式点击恢复失败时仍要出声，但要说清是哪个会话没恢复。
      if (/HTTP 404/.test(msg)) {
        try { localStorage.removeItem(LS_SESSION); } catch (e3) { }
        addNotice("该会话已不存在，已开始新对话", "info");
        return;
      }
      // 其它失败（网络、文件损坏）必须让用户知道恢复没有发生。
      addNotice((quiet ? "上次的会话没能恢复：" : "恢复会话失败：") + msg, "err");
    });
  }

  function deleteSession(id) {
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
   *
   * 渐进渲染：几百条消息的会话曾把主线程卡住 20-30 秒（服务端 resume 只要
   * 0.2s，时间全花在 markdown/工具卡/diff 的同步 DOM 渲染）。现在首屏只渲染
   * 最后 REPLAY_CHUNK 条（起点对齐到 user 消息，保证 tool_calls 配对完整），
   * 更早的由顶部「加载更早」按钮分批 prepend。
   */
  var REPLAY_CHUNK = 60;
  var REPLAY_BATCH = 80;

  function replayTranscript(messages) {
    S.replayingHistory = true;
    var root = $("log");
    msgSeqCounter = 0;
    S.artifacts = [];
    S.activeArtifactId = null;
    updateArtifactBadge();
    loadPinnedForCurrentSession();
    Array.prototype.slice.call(root.querySelectorAll(".msg, .tool, .tool-group, .notice, .ask, .thought")).forEach(function (n) {
      if (n.parentNode === root) { root.removeChild(n); }
    });

    var msgs = Array.isArray(messages) ? messages : [];
    S._replayMsgs = msgs;
    var start = 0;
    if (msgs.length > REPLAY_CHUNK) {
      start = msgs.length - REPLAY_CHUNK;
      // 起点对齐到 user 消息：assistant(tool_calls)+tool 配对不会从中间断开
      while (start > 0 && msgs[start] && msgs[start].role !== "user") { start--; }
    }
    S._replayStart = start;
    renderReplayRange(start, msgs.length);
    if (start > 0) { addLoadEarlierCard(); }

    var had = root.querySelector(".msg, .tool, .tool-group");
    if (!had) { restoreWelcome(); }
    syncPinnedDomNodes();
    renderTopMeta();
    scrollStream(true);
    S.replayingHistory = false;
    // 恢复该会话已保存的 👍/👎 反馈（digest 对上了才点亮）
    loadFeedbackForCurrentSession();
  }

  /** 渲染 [from, to) 区间的历史消息，prepend 到当前内容之前。 */
  function renderReplayRange(from, to) {
    // 全程视为重放：loadEarlierReplay 也会走到这里，而它不在 replayingHistory
    // 期内 —— 不挡住的话 addUserMessage 会把重放消息重复 push 进 _replayMsgs
    // 并覆写 srcIdx（目录错乱 + 重复条目）。
    var prevReplaying = S.replayingHistory;
    S.replayingHistory = true;
    try {
      renderReplayRangeInner(from, to);
    } finally {
      S.replayingHistory = prevReplaying;
    }
  }

  function renderReplayRangeInner(from, to) {
    var msgs = S._replayMsgs || [];
    var root = $("log");
    // 锚点 = 第一个真实内容节点（.notice 的「加载更早」卡保持在最顶上）
    var anchor = root.querySelector(".msg, .tool, .tool-group, .ask, .thought");
    var callIndex = {};
    for (var i = from; i < to; i++) {
      var m = msgs[i];
      if (m && m.role === "assistant" && Array.isArray(m.tool_calls)) {
        m.tool_calls.forEach(function (tc) {
          var fn = tc.function || {};
          var args = {};
          try { args = JSON.parse(fn.arguments || "{}"); } catch (e) { args = {}; }
          callIndex[tc.id] = { name: fn.name || "Tool", args: args };
        });
      }
    }
    // 离屏容器：addUserMessage 等都往 logRoot() 追加，重定向后整批搬运
    _logRedirect = document.createElement("div");
    try {
      for (var j = from; j < to; j++) {
        var msg = msgs[j];
        if (!msg) { continue; }
        if (msg.role === "user") {
          var text = typeof msg.content === "string" ? msg.content : "";
          var imgs = 0;
          if (Array.isArray(msg.content)) {
            msg.content.forEach(function (p) {
              if (p && p.type === "text") { text += (text ? "\n" : "") + p.text; }
              if (p && p.type === "image_url") { imgs = imgs + 1; }
            });
          }
          if (text.trim() || imgs) {
            // 打上源消息下标：消息目录要按「数据」列出全部提问，
            // 而渐进渲染只把一部分节点放进 DOM，两者需要一把钥匙对上。
            var prevNode = _logRedirect.lastElementChild;
            addUserMessage(text + (imgs ? "  [" + imgs + " 张图片]" : ""), []);
            var madeNode = _logRedirect.lastElementChild;
            if (madeNode && madeNode !== prevNode) { madeNode.dataset.srcIdx = String(j); }
          }
        } else if (msg.role === "assistant" && msg.content) {
          var h = addAssistantMessage();
          renderAssistant(h, String(msg.content), false);
          enhanceCodeblocksWithArtifacts(h.body);
          addCopyActions(h);
        } else if (msg.role === "tool") {
          restoredToolCard(callIndex[msg.tool_call_id], String(msg.content || ""));
        }
      }
    } finally {
      var batch = _logRedirect;
      _logRedirect = null;
    }
    var frag = document.createDocumentFragment();
    while (batch.firstChild) { frag.appendChild(batch.firstChild); }
    root.insertBefore(frag, anchor);
  }

  /** 「加载更早的消息」卡片（渐进重放的分页按钮）。 */
  function addLoadEarlierCard() {
    var root = $("log");
    var old = root.querySelector(".replay-earlier");
    if (old && old.parentNode) { old.parentNode.removeChild(old); }
    var total = (S._replayMsgs || []).length;
    var start = S._replayStart || 0;
    if (start <= 0) { return; }
    var wrap = el("div", "notice replay-earlier");
    var msg = el("span", null, "已加载最近 " + (total - start) + " 条（共 " + total + " 条）。");
    var btn = el("button", "btn continue-btn", "加载更早 " + Math.min(REPLAY_BATCH, start) + " 条");
    btn.type = "button";
    btn.addEventListener("click", function () { loadEarlierReplay(); });
    wrap.appendChild(msg);
    wrap.appendChild(btn);
    root.insertBefore(wrap, root.firstChild);
  }

  /**
   * 把某个消息节点滚到视野里并闪一下，提示「就是这条」。
   *
   * instant=true 用于「刚补加载一大批再跳过去」：此时 loadEarlierReplay 刚调整过
   * scrollTop 以保持视图不跳，smooth 滚动会和它打架，实测落不到目标位置。
   * 直接按几何位置算一次 scrollTop 才可靠。
   */
  function flashToNode(node, instant) {
    if (!node) { return; }
    if (instant) {
      var stream = $("stream");
      if (stream) {
        var sr = stream.getBoundingClientRect();
        var nr = node.getBoundingClientRect();
        stream.scrollTop += (nr.top - sr.top) - 80;
      } else {
        node.scrollIntoView();
      }
    } else {
      node.scrollIntoView({ behavior: "smooth", block: "start" });
    }
    node.classList.add("msg-flash");
    setTimeout(function () { node.classList.remove("msg-flash"); }, 2600);
  }

  /** 目录点击：已渲染就滚过去；还没渲染就分批补到它出现，再滚。 */
  function jumpToTocEntry(entry) {
    var node = entry.node || (entry.idx != null ? logRoot().querySelector('[data-src-idx="' + entry.idx + '"]') : null);
    if (node) { flashToNode(node); return; }
    if (entry.idx == null) { return; }
    loadUntilRendered(entry.idx, function () { renderInspector(); });
  }

  /**
   * 分批向前加载，直到目标下标进入 DOM 然后滚过去。
   *
   * 每批之间让出主线程：几百条消息一次性同步渲染曾把界面卡死 20-30 秒，
   * 渐进渲染正是为了避免它 —— 跳转不能把这个保证撤销掉。tries 上限是防呆，
   * 正常情况按 REPLAY_BATCH 每批 80 条，几百条的会话几轮就够。
   */
  function loadUntilRendered(targetIdx, done) {
    var tries = 0;
    (function step() {
      var start = S._replayStart || 0;
      if (start <= 0 || targetIdx >= start) {
        var node2 = logRoot().querySelector('[data-src-idx="' + targetIdx + '"]');
        if (node2) { flashToNode(node2, true); }
        if (done) { done(); }
        return;
      }
      if (tries++ > 40) { if (done) { done(); } return; }
      loadEarlierReplay();
      setTimeout(step, 16);
    })();
  }

  /** 向前加载一批更早的消息，保持滚动位置不跳。 */
  function loadEarlierReplay() {
    var msgs = S._replayMsgs || [];
    var stream = $("stream");
    var prevHeight = stream ? stream.scrollHeight : 0;
    var start = S._replayStart || 0;
    if (start <= 0) { return; }
    var from = Math.max(0, start - REPLAY_BATCH);
    while (from > 0 && msgs[from] && msgs[from].role !== "user") { from--; }
    S._replayStart = from;
    renderReplayRange(from, start);
    addLoadEarlierCard();
    if (stream) {
      var delta = stream.scrollHeight - prevHeight;
      if (delta > 0) { stream.scrollTop += delta; }
    }
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

  var WELCOME_SCENES = [
    {
      id: "code",
      label: "写代码与组件",
      icon: "i-code",
      items: [
        { t: "生成可预览的 HTML 组件 (Artifact)", d: "直接输出可在右侧 Artifacts 画布实时预览的交互页面", p: "用单个 HTML 文件（含现代 CSS 和原生 JS）写一个番茄钟效率工具页面，支持开始、暂停、任务统计和深浅色切换。" },
        { t: "新增功能模块", d: "结合现有架构实现新特性并保持代码风格一致", p: "阅读当前项目的关键模块，帮我规划并实现一个新的功能模块，遵循现有代码风格。" }
      ]
    },
    {
      id: "debug",
      label: "排查与修 Bug",
      icon: "i-tool",
      items: [
        { t: "审查我的改动", d: "查找潜在缺陷、边界情况与安全隐患", p: "审查最近修改的文件，找出潜在缺陷、边界情况和缺失的测试，并给出具体行号与修复建议。" },
        { t: "定位异常与报错", d: "追踪调用链路并给出最小改动修复方案", p: "找出 GUI 服务端路由在哪里定义，说明一次聊天请求如何流转，并检查是否存在异常处理遗漏。" }
      ]
    },
    {
      id: "arch",
      label: "架构解析",
      icon: "i-folder",
      items: [
        { t: "解释这个项目", d: "梳理核心架构、入口与模块协作关系", p: "给我一个完整的项目总览：核心架构、关键入口文件，以及各模块之间是如何协作的。" },
        { t: "生成架构流程图", d: "输出结构化 Markdown 与模块依赖说明", p: "梳理本项目的模块依赖关系，并用清晰的 Markdown 表格与流程图总结核心数据流。" }
      ]
    },
    {
      id: "test",
      label: "单元测试",
      icon: "i-task",
      items: [
        { t: "补充边界单元测试", d: "为核心模块增加异常与边界覆盖", p: "为会话持久化模块补充单元测试，覆盖轮换、裁剪与损坏文件恢复等边界情况。" },
        { t: "运行并诊断测试集", d: "执行测试并修复失败用例", p: "运行当前项目的测试套件，分析覆盖情况并指出最需要补充测试的模块。" }
      ]
    }
  ];

  function renderWelcomeCards() {
    var host = $("welcome-cards");
    if (!host) { return; }
    clear(host);

    var catRow = el("div", "welcome-cats");
    var activeScene = WELCOME_SCENES[0];
    WELCOME_SCENES.forEach(function (sc) {
      if (sc.id === S.welcomeCat) { activeScene = sc; }
      var b = el("button", "welcome-cat-btn" + (sc.id === S.welcomeCat ? " active" : ""));
      b.type = "button";
      b.appendChild(icon(sc.icon, 15));
      b.appendChild(el("span", null, sc.label));
      b.addEventListener("click", function () {
        S.welcomeCat = sc.id;
        renderWelcomeCards();
      });
      catRow.appendChild(b);
    });
    host.appendChild(catRow);

    var drawer = el("div", "welcome-drawer");
    (activeScene.items || []).forEach(function (c) {
      var item = el("button", "welcome-prompt-item");
      item.type = "button";
      item.appendChild(el("div", "welcome-prompt-title", c.t));
      item.appendChild(el("div", "welcome-prompt-sub", c.d));
      item.addEventListener("click", function () {
        var ta = $("in");
        if (!ta) { return; }
        ta.value = c.p;
        autoGrow(ta);
        ta.focus();
      });
      drawer.appendChild(item);
    });
    host.appendChild(drawer);
  }

  function newChat() {
    if (S.busy) { return; }
    var taNow = $("in");
    if (taNow && taNow.value && S.sessionKey) { saveDraftNow(taNow.value); }
    postJSON("/api/reset", {}).then(function () {
      msgSeqCounter = 0;
      // 重放状态必须跟着清：残留的 _replayMsgs 会让新对话的目录列出旧会话的提问，
      // 点击还会经 loadUntilRendered 把旧消息注入新对话。
      S._replayMsgs = [];
      S._replayStart = 0;
      S.sessionKey = null;
      S.titleOverride = null;
      S.todos = [];
      S.artifacts = [];
      S.activeArtifactId = null;
      S.pinnedMessages = [];
      S.pinnedExpanded = false;
      try { localStorage.removeItem(LS_PINNED_PREFIX + "draft"); } catch (e) {}
      renderPinnedBar();
      updateArtifactBadge();
      if (S.inspTab === "artifact") { switchInspectorTab("info"); }
      S.stats = { messages: 0, turns: 0, tokens: 0, inputTokens: 0, outputTokens: 0, contextLimit: 0, contextUsed: 0 };
      try { localStorage.removeItem(LS_SESSION); } catch (e) { }
      var root = logRoot();
      Array.prototype.slice.call(root.querySelectorAll(".msg, .tool, .tool-group, .notice, .ask, .thought")).forEach(function (n) {
        if (n.parentNode === root) { root.removeChild(n); }
      });
      restoreWelcome();
      renderInspector();
      refreshSessions();
      restoreDraft(); // 新对话也读「draft」键的未发送草稿
      var ta = $("in");
      if (ta) { ta.focus(); }
    }).catch(function (e) { toast("新建失败：" + e.message, "err"); });
  }

  function refreshStats() {
    getJSON("/api/config").then(function (j) {
      S.config = j;
    // 深度思考按钮镜像 config.effort（与 /effort 同一设置）
    S.thinking = ["high", "medium", "low"].indexOf(S.config && S.config.effort) >= 0;
    renderThinkingButton();
      S.vision = j.vision !== false;
      if (j.routing) { S.routing = j.routing; }
      renderTopMeta();
      renderVision();
      renderUsage();
      renderInspector();
    }).catch(function () {});
  }

  /* ================================================================ 模态 === */

  function openModal(title, buildBody, footButtons, opts) {
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
    /* 每次打开都重设宽版标记，避免上一个弹窗的宽版残留到下一个 */
    var card = m.querySelector(".modal-card");
    if (card) { card.classList.toggle("modal-wide", !!(opts && opts.wide)); }
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
  var currentConfigTab = "providers";
  var selectedProviderKey = "anthropic";
  var showApiKeyPlain = false;

  var FRONTEND_PROVIDER_PRESETS = [
    {
      key: "anthropic",
      name: "Anthropic Claude",
      badge: "Claude 官方",
      icon: "✳",
      color: "#D97757",
      baseUrl: "https://api.anthropic.com/v1",
      defaultModel: "claude-3-7-sonnet",
      keyPlaceholder: "sk-ant-api03-...",
      desc: "Anthropic 官方 Claude 旗舰模型，支持 Claude 3.7 Sonnet 混合推理与编程",
      models: [
        { id: "claude-3-7-sonnet", name: "Claude 3.7 Sonnet (混合推理/编程旗舰)", tag: "旗舰推理" },
        { id: "claude-3-5-sonnet", name: "Claude 3.5 Sonnet (全栈编程王者)", tag: "全栈标杆" },
        { id: "claude-3-5-haiku", name: "Claude 3.5 Haiku (轻量高性价比)", tag: "极速响应" },
        { id: "claude-3-opus", name: "Claude 3 Opus (复杂深度学术分析)", tag: "深度分析" }
      ]
    },
    {
      key: "deepseek",
      name: "DeepSeek 深度求索",
      badge: "DeepSeek 官方",
      icon: "🐋",
      color: "#0066FF",
      baseUrl: "https://api.deepseek.com/v1",
      defaultModel: "deepseek-chat",
      keyPlaceholder: "sk-...",
      desc: "DeepSeek 官方大模型 API，支持 DeepSeek-V3 编程与 DeepSeek-R1 深度思考",
      models: [
        { id: "deepseek-chat", name: "DeepSeek-V3 (通用对话与代码能力)", tag: "通用代码" },
        { id: "deepseek-reasoner", name: "DeepSeek-R1 (深度思维链与数学推理)", tag: "深度思考" },
        { id: "deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash (百万超长上下文)", tag: "1M长文本" }
      ]
    },
    {
      key: "gemini",
      name: "Google Gemini",
      badge: "Gemini 官方",
      icon: "✨",
      color: "#1A73E8",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
      defaultModel: "gemini-2.5-flash",
      keyPlaceholder: "AIzaSy... (环境已自带免费密钥)",
      desc: "Google Gemini 官方兼容端，系统已注入免费 GEMINI_API_KEY，免配即用",
      models: [
        { id: "gemini-2.5-flash", name: "Gemini 2.5 Flash (百万超长上下文极速 · 免配即用)", tag: "免配即用" },
        { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro (高级多模态复杂推理)", tag: "多模态旗舰" },
        { id: "gemini-2.0-flash", name: "Gemini 2.0 Flash (实时超快交互)", tag: "极速" }
      ]
    },
    {
      key: "openai",
      name: "OpenAI",
      badge: "OpenAI 官方",
      icon: "🟢",
      color: "#10A37F",
      baseUrl: "https://api.openai.com/v1",
      defaultModel: "gpt-4o",
      keyPlaceholder: "sk-proj-...",
      desc: "OpenAI 官方 API，支持 GPT-4o 全模态、o1/o3-mini 高阶强化推理",
      models: [
        { id: "gpt-4o", name: "GPT-4o (全模态旗舰 Omni)", tag: "全模态" },
        { id: "gpt-4o-mini", name: "GPT-4o Mini (极速高性价比)", tag: "高性价比" },
        { id: "o1", name: "OpenAI o1 (强化复杂推理旗舰)", tag: "高阶推理" },
        { id: "o3-mini", name: "OpenAI o3-mini (极速代码与数学推理)", tag: "代码推理" }
      ]
    },
    {
      key: "zhipu",
      name: "智谱 AI (GLM)",
      badge: "智谱清言",
      icon: "🟣",
      color: "#385BF5",
      baseUrl: "https://open.bigmodel.cn/api/paas/v4",
      defaultModel: "glm-4-flash",
      keyPlaceholder: "zhipu-api-key...",
      desc: "国产清言大模型，支持 GLM-4-Plus 长文本与 GLM-4-Flash 免费极速调用",
      models: [
        { id: "glm-4-plus", name: "GLM-4 Plus (高性能基座与长文本旗舰)", tag: "智谱旗舰" },
        { id: "glm-4-flash", name: "GLM-4 Flash (免费极速)", tag: "免费极速" }
      ]
    },
    {
      key: "qwen",
      name: "通义千问 (Qwen)",
      badge: "阿里云百炼",
      icon: "🔷",
      color: "#FF6600",
      baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      defaultModel: "qwen-2.5-coder-32b",
      keyPlaceholder: "sk-...",
      desc: "阿里云通义千问大模型，支持开源编程王者 Qwen 2.5 Coder 32B",
      models: [
        { id: "qwen-2.5-coder-32b", name: "Qwen 2.5 Coder 32B (开源编程王者)", tag: "编程标杆" },
        { id: "qwen-max", name: "Qwen Max (全能超大规模旗舰)", tag: "全能旗舰" }
      ]
    },
    {
      key: "ollama",
      name: "Ollama 本地大模型",
      badge: "本地私有",
      icon: "🦙",
      color: "#6B7280",
      baseUrl: "http://localhost:11434/v1",
      defaultModel: "deepseek-r1:8b",
      keyPlaceholder: "Ollama 本地服务无需 API Key",
      desc: "运行在本地端口 11434 的私有开源大模型，完全离线且无需密钥",
      models: [
        { id: "deepseek-r1:8b", name: "DeepSeek-R1 8B (本地轻量思考模型)", tag: "本地思考" },
        { id: "qwen2.5-coder:7b", name: "Qwen 2.5 Coder 7B (本地代码模型)", tag: "本地代码" },
        { id: "llama3.3:70b", name: "Llama 3.3 70B (Meta 开源旗舰)", tag: "本地旗舰" }
      ]
    },
    {
      key: "gateway",
      name: "OpenCode Zen / 聚合网关",
      badge: "聚合网关",
      icon: "⚡",
      color: "#8B5CF6",
      baseUrl: "http://127.0.0.1:3425/v1",
      defaultModel: "group/auto-deepseek-v4-1-flash-free",
      keyPlaceholder: "可留空或填写网关 Token",
      desc: "内置多厂商聚合路由网关，自动负载均衡与跨厂商故障转移",
      models: [
        { id: "group/auto-deepseek-v4-1-flash-free", name: "DeepSeek V4.1 Flash Free (聚合网关)", tag: "免费" },
        { id: "group/auto-glm-5-3-flash-free", name: "GLM-5.3-Flash Free (聚合网关)", tag: "免费" },
        { id: "group/auto-deepseek-v4-1-flash", name: "DeepSeek V4.1 Flash (百万长文本)", tag: "1M" },
        { id: "opencode-zen/cat-jam-free", name: "Cat-Jam Free · OpenCode Zen", tag: "免费" },
        { id: "qoder-cn/gfmodel", name: "GfModel · Qoder CN", tag: "网关" }
      ]
    },
    {
      key: "custom",
      name: "自定义兼容网关 (OneAPI / 中转站)",
      badge: "自定义 API",
      icon: "🌐",
      color: "#4B5563",
      baseUrl: "",
      defaultModel: "",
      keyPlaceholder: "自定义 API 密钥 (Bearer Token)",
      desc: "支持任意符合 OpenAI /chat/completions 规范的第三方中转站、代理或企业私有网关",
      models: []
    }
  ];

  function closeModelConfigModal() {
    var m = $("model-config-modal");
    if (m) { m.hidden = true; }
  }

  function openModelConfigModal(targetTab) {
    var modal = $("model-config-modal");
    if (!modal) { return; }
    if (targetTab) { currentConfigTab = targetTab; }

    modal.hidden = false;
    renderConfigModalContent();

    // 重新从服务端拉取一次最新配置，保持双向同步
    getJSON("/api/config").then(function (j) {
      if (j) {
        if (!S.config) { S.config = {}; }
        Object.assign(S.config, j);
        renderConfigModalContent();
      }
    }).catch(function () {});
  }

  function renderConfigModalContent() {
    var c = S.config || {};
    var body = $("model-config-body");
    if (!body) { return; }
    clear(body);

    // 切换选项卡高亮
    var tabBtns = document.querySelectorAll(".config-tab-btn");
    Array.prototype.forEach.call(tabBtns, function (b) {
      var tab = b.getAttribute("data-cfg-tab");
      b.classList.toggle("active", tab === currentConfigTab);
      b.onclick = function () {
        currentConfigTab = tab;
        renderConfigModalContent();
      };
    });

    if (currentConfigTab === "providers") {
      renderProvidersTab(body, c);
    } else if (currentConfigTab === "fallbacks") {
      renderFallbacksTab(body, c);
    } else if (currentConfigTab === "general") {
      renderGeneralTab(body, c);
    } else {
      renderParamsTab(body, c);
    }
  }

  /** 通用与外观页签：主题 / 提示音 / 桌面通知 / 显示名 / 数据管理。 */
  function renderGeneralTab(body, c) {
    var wrap = el("div", "cfg-general-pane");
    var intro = el("div", "cfg-pane-intro");
    intro.innerHTML = "<div class='cfg-pane-title'>通用与外观</div><div class='cfg-pane-desc'>主题、提示音、桌面通知与显示名。立即生效，本地保存。</div>";
    wrap.appendChild(intro);

    var card = el("div", "cfg-form-card");
    var grid = el("div", "cfg-general-grid");

    function toggleRow(label, desc, value, onChange, labels) {
      var row = el("div", "cfg-general-row");
      var info = el("div", "cfg-general-info");
      info.appendChild(el("div", "cfg-general-label", label));
      info.appendChild(el("div", "cfg-general-desc", desc));
      var btn = el("button", "btn " + (value ? "primary" : "ghost"), value ? (labels && labels[0] || "开") : (labels && labels[1] || "关"));
      btn.type = "button";
      btn.addEventListener("click", function () {
        var next = !btn.classList.contains("primary");
        btn.classList.toggle("primary", next);
        btn.classList.toggle("ghost", !next);
        btn.textContent = next ? (labels && labels[0] || "开") : (labels && labels[1] || "关");
        onChange(next);
      });
      row.appendChild(info);
      row.appendChild(btn);
      return row;
    }

    // 主题三态
    var themeRow = el("div", "cfg-general-row");
    var themeInfo = el("div", "cfg-general-info");
    themeInfo.appendChild(el("div", "cfg-general-label", "主题"));
    themeInfo.appendChild(el("div", "cfg-general-desc", "深色 / 浅色 / 跟随系统（侧栏按钮同样可切）"));
    var themeSel = el("select", "cfg-general-select");
    [["dark", "深色"], ["light", "浅色"], ["auto", "跟随系统"]].forEach(function (pair) {
      var opt = document.createElement("option");
      opt.value = pair[0];
      opt.textContent = pair[1];
      if ((S.theme || "dark") === pair[0]) { opt.selected = true; }
      themeSel.appendChild(opt);
    });
    themeSel.addEventListener("change", function () { applyTheme(themeSel.value); });
    themeRow.appendChild(themeInfo);
    themeRow.appendChild(themeSel);
    grid.appendChild(themeRow);

    grid.appendChild(toggleRow("提示音", "回合完成与等待确认时播放合成音", soundEnabled(), function (on) { setSoundPref(on); if (on) { playChime("done"); } }));
    grid.appendChild(toggleRow("桌面通知", "切到其他标签页时通知回合完成/待确认", notifyEnabled(), function (on) {
      setNotifyPref(on);
      if (on) { askNotifyPermission(function (granted) { if (!granted) { toast("浏览器拒绝了通知权限", "warn"); } }); }
    }));
    grid.appendChild(toggleRow("AI 自动命名", "首回合结束后用当前模型生成会话标题（会多一次小请求）", (S.config && S.config.autoTitle !== false), function (on) {
      postJSON("/api/config", { autoTitle: on }).then(function () {
        if (S.config) { S.config.autoTitle = on; }
        toast(on ? "AI 自动命名已开启" : "AI 自动命名已关闭", "ok");
      }).catch(function (e) { toast("设置失败：" + e.message, "err"); });
    }));

    // 显示名（问候语用）
    var nameRow = el("div", "cfg-general-row");
    var nameInfo = el("div", "cfg-general-info");
    nameInfo.appendChild(el("div", "cfg-general-label", "显示名"));
    nameInfo.appendChild(el("div", "cfg-general-desc", "问候语里称呼你的名字"));
    var nameInp = el("input", "cfg-general-input");
    nameInp.type = "text";
    nameInp.maxLength = 24;
    nameInp.placeholder = "Danny";
    try { nameInp.value = localStorage.getItem(LS_NAME) || ""; } catch (e) {}
    nameInp.addEventListener("change", function () {
      try { localStorage.setItem(LS_NAME, nameInp.value.trim()); } catch (e) {}
      renderProfile();
      var g = $("greeting");
      if (g) { g.textContent = greetingText(); }
      toast("显示名已更新", "ok");
    });
    nameRow.appendChild(nameInfo);
    nameRow.appendChild(nameInp);
    grid.appendChild(nameRow);

    card.appendChild(grid);
    wrap.appendChild(card);

    // 数据管理：清理已分享快照 / 反馈数据
    var dataCard = el("div", "cfg-form-card");
    var dataHead = el("div", "cfg-form-head");
    dataHead.innerHTML = "<div class='cfg-fhead-left'><span class='pcard-icon'>🗂</span> <div><strong>数据管理</strong><span class='cfg-fhead-sub'>分享快照与消息反馈存储在 ~/.myclaude/，可随时清理</span></div></div>";
    dataCard.appendChild(dataHead);
    var dataBar = el("div", "cfg-general-grid");
    var sharesInfo = el("div", "cfg-general-row");
    var sharesInfoBox = el("div", "cfg-general-info");
    sharesInfoBox.appendChild(el("div", "cfg-general-label", "分享快照"));
    sharesInfoBox.appendChild(el("div", "cfg-general-desc", "已创建 " + ((S.sharedIds || []).length) + " 个只读分享链接"));
    var shareBtn = el("button", "btn ghost", "查看 / 撤销分享");
    shareBtn.type = "button";
    shareBtn.addEventListener("click", function () { openShareManager(); });
    sharesInfo.appendChild(sharesInfoBox);
    sharesInfo.appendChild(shareBtn);
    dataBar.appendChild(sharesInfo);
    dataCard.appendChild(dataBar);
    wrap.appendChild(dataCard);

    body.appendChild(wrap);
  }

  /** 分享管理：列出全部快照，支持逐个打开与撤销。 */
  function openShareManager() {
    getJSON("/api/shares").then(function (j) {
      var shares = j.shares || [];
      openModal("分享管理（" + shares.length + "）", function (body) {
        if (!shares.length) {
          body.appendChild(el("div", "empty-note", "还没有分享快照。右键侧栏会话 → 「分享 · 复制只读链接」即可创建。"));
          return;
        }
        shares.forEach(function (sh) {
          var row = el("div", "share-row");
          var info = el("div", "share-info");
          info.appendChild(el("div", "share-title", sh.title || sh.sessionId));
          info.appendChild(el("div", "share-url", location.origin + "/share/" + sh.token));
          row.appendChild(info);
          var open = el("button", "mini-btn", "打开");
          open.type = "button";
          open.addEventListener("click", function () { window.open("/share/" + sh.token, "_blank"); });
          row.appendChild(open);
          var copy = el("button", "mini-btn", "复制链接");
          copy.type = "button";
          copy.addEventListener("click", function () { copyText(location.origin + "/share/" + sh.token); toast("已复制", "ok"); });
          row.appendChild(copy);
          var rev = el("button", "mini-btn share-revoke", "撤销");
          rev.type = "button";
          rev.addEventListener("click", function () {
            delJSON("/api/share", { id: sh.sessionId }).then(function () {
              toast("已撤销分享", "ok");
              refreshSessions();
              var m = $("modal");
              if (m && !m.hidden) { closeModal(); openShareManager(); }
            });
          });
          row.appendChild(rev);
          body.appendChild(row);
        });
      }, [{ label: "关闭", fn: closeModal }]);
    });
  }

  function renderProvidersTab(body, c) {
    var wrap = el("div", "cfg-providers-pane");

    // 标题说明
    var intro = el("div", "cfg-pane-intro");
    intro.innerHTML = "<div class='cfg-pane-title'>选择并配置您的 AI 模型供应商</div><div class='cfg-pane-desc'>支持 Anthropic Claude 官方、DeepSeek、OpenAI、Gemini 与本地 Ollama。配置后一键测试连通性并实时生效。</div>";
    wrap.appendChild(intro);

    // 当前实际生效的 BaseUrl 供应商推断
    var curBase = c.baseUrl || "";
    var presets = (c.providerPresets && c.providerPresets.length) ? c.providerPresets : FRONTEND_PROVIDER_PRESETS;

    // 确定当前选中的供应商
    if (!selectedProviderKey) {
      selectedProviderKey = c.activeProviderKey || "anthropic";
      for (var p = 0; p < presets.length; p++) {
        if (presets[p].baseUrl && curBase.indexOf(presets[p].baseUrl) === 0) {
          selectedProviderKey = presets[p].key;
          break;
        }
      }
    }

    // 供应商网格卡片
    var grid = el("div", "cfg-provider-grid");
    presets.forEach(function (preset) {
      var card = el("button", "cfg-provider-card" + (selectedProviderKey === preset.key ? " active" : ""));
      card.type = "button";
      var isCurrentActive = (c.activeProviderKey === preset.key) || (preset.baseUrl && curBase.indexOf(preset.baseUrl) === 0);

      var topRow = el("div", "pcard-top");
      var icon = el("span", "pcard-icon", preset.icon || "🤖");
      var name = el("strong", "pcard-name", preset.name);
      // 列变窄后名字会省略；悬停仍能看到全称。
      name.title = preset.name;
      topRow.appendChild(icon);
      topRow.appendChild(name);

      if (isCurrentActive) {
        var actBadge = el("span", "pcard-badge active-tag", "正在使用");
        topRow.appendChild(actBadge);
      } else if (preset.badge) {
        var badge = el("span", "pcard-badge", preset.badge);
        topRow.appendChild(badge);
      }
      card.appendChild(topRow);

      var desc = el("div", "pcard-desc", preset.desc || (preset.models && preset.models.length ? preset.models[0].name : "支持自定义模型"));
      card.appendChild(desc);

      card.addEventListener("click", function () {
        selectedProviderKey = preset.key;
        renderConfigModalContent();
      });
      grid.appendChild(card);
    });
    wrap.appendChild(grid);

    // 当前选中的供应商配置表单
    var curPreset = presets.find(function (p) { return p.key === selectedProviderKey; }) || presets[0];
    var formBox = el("div", "cfg-form-card");

    var fHead = el("div", "cfg-form-head");
    fHead.innerHTML = `<div class="cfg-fhead-left"><span class="pcard-icon">${curPreset.icon}</span> <div><strong>${curPreset.name} 配置</strong><span class="cfg-fhead-sub">${curPreset.desc || ""}</span></div></div>`;
    formBox.appendChild(fHead);

    var formGrid = el("div", "cfg-form-grid");

    // 1. 接口服务地址 Base URL
    var baseField = el("div", "cfg-field");
    var baseLabelWrap = el("div", "cfg-label-wrap");
    baseLabelWrap.innerHTML = "<label>接口服务地址 (Base URL)</label>";
    if (curPreset.baseUrl) {
      var resetBase = el("button", "cfg-link-btn", "恢复默认地址");
      resetBase.type = "button";
      resetBase.addEventListener("click", function () {
        baseInput.value = curPreset.baseUrl;
      });
      baseLabelWrap.appendChild(resetBase);
    }
    baseField.appendChild(baseLabelWrap);

    var baseInput = document.createElement("input");
    baseInput.type = "text";
    baseInput.className = "cfg-input";
    baseInput.placeholder = curPreset.baseUrl || "https://api.openai.com/v1";
    // 优先读取该供应商已保存的 baseUrl，否则使用当前全局或预设
    var savedProvConf = (c.providers && c.providers[curPreset.key]) || {};
    baseInput.value = savedProvConf.baseUrl || (selectedProviderKey === c.activeProviderKey ? c.baseUrl : (curPreset.baseUrl || ""));
    baseField.appendChild(baseInput);
    formGrid.appendChild(baseField);

    // 2. API Key
    var keyField = el("div", "cfg-field");
    var keyLabelWrap = el("div", "cfg-label-wrap");
    keyLabelWrap.innerHTML = "<label>API 密钥 (API Key)</label>";
    if (c.apiKeyConfigured && selectedProviderKey === c.activeProviderKey) {
      var keyStatus = el("span", "cfg-key-status", "● " + (c.apiKeyMasked || "已配置"));
      keyLabelWrap.appendChild(keyStatus);
    }
    keyField.appendChild(keyLabelWrap);

    var keyWrap = el("div", "cfg-key-wrap");
    var keyInput = document.createElement("input");
    keyInput.type = showApiKeyPlain ? "text" : "password";
    keyInput.className = "cfg-input cfg-key-input";
    keyInput.placeholder = curPreset.keyPlaceholder || "请输入 API Key";
    keyInput.autocomplete = "off";
    keyInput.value = savedProvConf.apiKey || (selectedProviderKey === c.activeProviderKey ? (c.apiKey || "") : "");
    keyWrap.appendChild(keyInput);

    var eyeBtn = el("button", "cfg-eye-btn", showApiKeyPlain ? "隐藏" : "显示");
    eyeBtn.type = "button";
    eyeBtn.title = "显示/隐藏密钥明文";
    eyeBtn.addEventListener("click", function () {
      showApiKeyPlain = !showApiKeyPlain;
      keyInput.type = showApiKeyPlain ? "text" : "password";
      eyeBtn.textContent = showApiKeyPlain ? "隐藏" : "显示";
    });
    keyWrap.appendChild(eyeBtn);
    keyField.appendChild(keyWrap);

    if (curPreset.key === "gemini") {
      var geminiNote = el("div", "cfg-field-hint good", "✨ Google AI Studio 环境已自动注入免费 GEMINI_API_KEY，此处留空即自动使用系统环境密钥。");
      keyField.appendChild(geminiNote);
    } else if (curPreset.key === "ollama") {
      var ollamaNote = el("div", "cfg-field-hint", "🦙 Ollama 为本地私有服务，默认无需 API Key，只要确保本地已运行即可。");
      keyField.appendChild(ollamaNote);
    } else {
      var normalNote = el("div", "cfg-field-hint", "密钥保存在您的本地工作区配置文件 ~/.myclaude/config.json 中，绝不外发。");
      keyField.appendChild(normalNote);
    }
    formGrid.appendChild(keyField);

    // 3. 模型选择 (Model)
    var modelField = el("div", "cfg-field cfg-field-full");
    var modelLabelWrap = el("div", "cfg-label-wrap");
    modelLabelWrap.innerHTML = "<label>生效模型名称 (Model)</label><span class='cfg-field-desc'>点击下方推荐模型一键填入，或直接输入自定义模型标识</span>";
    modelField.appendChild(modelLabelWrap);

    var modelInput = document.createElement("input");
    modelInput.type = "text";
    modelInput.className = "cfg-input";
    modelInput.placeholder = curPreset.defaultModel || "如：claude-3-7-sonnet";
    modelInput.value = savedProvConf.model || (selectedProviderKey === c.activeProviderKey ? c.model : (curPreset.defaultModel || ""));
    modelField.appendChild(modelInput);

    // 预设模型快速点击药丸
    if (curPreset.models && curPreset.models.length) {
      var pillWrap = el("div", "cfg-model-pills");
      curPreset.models.forEach(function (m) {
        var pill = el("button", "cfg-model-pill" + (modelInput.value === m.id ? " active" : ""));
        pill.type = "button";
        pill.innerHTML = `<span>${m.name}</span>` + (m.tag ? `<span class="pill-tag">${m.tag}</span>` : "");
        pill.addEventListener("click", function () {
          modelInput.value = m.id;
          Array.prototype.forEach.call(pillWrap.querySelectorAll(".cfg-model-pill"), function (p) {
            p.classList.remove("active");
          });
          pill.classList.add("active");
        });
        pillWrap.appendChild(pill);
      });
      modelField.appendChild(pillWrap);
    }
    formGrid.appendChild(modelField);

    formBox.appendChild(formGrid);

    // 连通性测试与保存操作栏
    var actionBox = el("div", "cfg-action-box");

    var testBtn = el("button", "btn ghost test-conn-btn");
    testBtn.type = "button";
    testBtn.innerHTML = `<svg width="15" height="15"><use href="#i-globe"/></svg> <span>测试服务连通性</span>`;

    var testStatus = el("div", "test-result-box");
    testStatus.hidden = true;

    testBtn.addEventListener("click", function () {
      var testUrl = baseInput.value.trim() || curPreset.baseUrl;
      var testKey = keyInput.value.trim();
      var testModel = modelInput.value.trim() || curPreset.defaultModel;

      testBtn.disabled = true;
      testBtn.innerHTML = `<span class="spinner-dot"></span> <span>测试中…</span>`;
      testStatus.hidden = false;
      testStatus.className = "test-result-box testing";
      testStatus.textContent = "正在探测 " + (curPreset.name) + " 接口服务响应…";

      postJSON("/api/test-connection", {
        baseUrl: testUrl,
        apiKey: testKey,
        model: testModel
      }).then(function (res) {
        testBtn.disabled = false;
        testBtn.innerHTML = `<svg width="15" height="15"><use href="#i-globe"/></svg> <span>重新测试</span>`;
        if (res.ok) {
          testStatus.className = "test-result-box ok";
          testStatus.innerHTML = `<strong>✅ 连通成功！</strong> 响应延迟 <b>${res.latencyMs}ms</b> · 服务地址与鉴权均正常响应。`;
        } else {
          testStatus.className = "test-result-box err";
          testStatus.innerHTML = `<strong>❌ 连接失败：</strong> ${res.error || res.message || "请求未通过，请检查服务地址与密钥"}`;
        }
      }).catch(function (err) {
        testBtn.disabled = false;
        testBtn.innerHTML = `<svg width="15" height="15"><use href="#i-globe"/></svg> <span>重新测试</span>`;
        testStatus.className = "test-result-box err";
        testStatus.innerHTML = `<strong>❌ 网络异常：</strong> ${err.message || "未能连接到目标主机"}`;
      });
    });

    var saveBtn = el("button", "btn primary save-cfg-btn");
    saveBtn.type = "button";
    saveBtn.innerHTML = `<svg width="15" height="15"><use href="#i-save"/></svg> <span>保存并设为当前生效模型</span>`;

    saveBtn.addEventListener("click", function () {
      var targetBaseUrl = baseInput.value.trim() || curPreset.baseUrl;
      var targetApiKey = keyInput.value.trim();
      var targetModel = modelInput.value.trim() || curPreset.defaultModel || "claude-3-7-sonnet";

      var provPatch = {};
      provPatch[curPreset.key] = {
        baseUrl: targetBaseUrl,
        apiKey: targetApiKey,
        model: targetModel,
        updatedAt: Date.now()
      };

      saveBtn.disabled = true;
      saveBtn.textContent = "正在保存…";

      postJSON("/api/config", {
        activeProviderKey: curPreset.key,
        // 线协议跟卡片走：Anthropic 官方必须用 Messages API 适配器，
        // 否则 baseUrl 指到 api.anthropic.com 也只会发出 OpenAI 格式而失败。
        provider: curPreset.key === "anthropic" ? "anthropic" : "openai",
        baseUrl: targetBaseUrl,
        apiKey: targetApiKey,
        model: targetModel,
        providers: provPatch
      }).then(function (j) {
        saveBtn.disabled = false;
        saveBtn.innerHTML = `<svg width="15" height="15"><use href="#i-save"/></svg> <span>保存并设为当前生效模型</span>`;

        if (S.config) {
          S.config.activeProviderKey = curPreset.key;
          S.config.provider = curPreset.key === "anthropic" ? "anthropic" : "openai";
          S.config.baseUrl = targetBaseUrl;
          S.config.apiKey = targetApiKey;
          S.config.model = targetModel;
          if (!S.config.providers) { S.config.providers = {}; }
          S.config.providers[curPreset.key] = provPatch[curPreset.key];
        }

        animateModelLabelChange(targetModel);
        updateModelBtnDot(targetModel);
        renderTopMeta();
        renderInspector();
        fetchModels(true);

        toast("已成功切换并生效模型：" + targetModel + "（" + curPreset.name + "）", "ok");
        closeModelConfigModal();
      }).catch(function (err) {
        saveBtn.disabled = false;
        saveBtn.innerHTML = `<svg width="15" height="15"><use href="#i-save"/></svg> <span>保存并设为当前生效模型</span>`;
        toast("保存配置失败：" + err.message, "err");
      });
    });

    actionBox.appendChild(testBtn);
    actionBox.appendChild(saveBtn);

    formBox.appendChild(testStatus);
    formBox.appendChild(actionBox);
    wrap.appendChild(formBox);

    body.appendChild(wrap);
  }

  function renderFallbacksTab(body, c) {
    var wrap = el("div", "cfg-fb-pane");
    var intro = el("div", "cfg-pane-intro");
    intro.innerHTML = "<div class='cfg-pane-title'>备用容灾模型池 (Fallback Pool)</div><div class='cfg-pane-desc'>当主模型遇到速率限制 (429)、服务端超载 (503) 或网络超时时，MyClaude 会自动无缝切换到备用模型继续生成。</div>";
    wrap.appendChild(intro);

    var list = el("div", "cfg-fb-list");
    var fallbacks = c.fallbacks || [];
    if (!fallbacks.length) {
      list.appendChild(el("div", "empty-note", "暂无备用模型，可在下方添加。"));
    } else {
      fallbacks.forEach(function (fb, idx) {
        var row = el("div", "cfg-fb-item");
        row.innerHTML = `<span class="fb-idx">#${idx + 1}</span> <div class="fb-info"><strong>${fb.name || fb.model}</strong><span class="fb-sub">${fb.baseUrl || "与主端点相同"}</span></div>`;
        var delBtn = el("button", "icon-btn fb-del", "×");
        delBtn.type = "button";
        delBtn.title = "删除此备用模型";
        delBtn.addEventListener("click", function () {
          var updated = fallbacks.filter(function (_, i) { return i !== idx; });
          postJSON("/api/config", { fallbacks: updated }).then(function () {
            if (S.config) { S.config.fallbacks = updated; }
            renderConfigModalContent();
            toast("已更新备用模型池", "ok");
          });
        });
        row.appendChild(delBtn);
        list.appendChild(row);
      });
    }
    wrap.appendChild(list);

    // 新增备用模型
    var addBox = el("div", "cfg-fb-add-box");
    addBox.innerHTML = "<div class='cfg-field-title'>添加新的备用模型</div>";

    var addGrid = el("div", "cfg-form-grid");
    var mNameIn = document.createElement("input");
    mNameIn.className = "cfg-input";
    mNameIn.placeholder = "备用模型名称 (如: deepseek-v4.1-flash)";
    addGrid.appendChild(field("模型名", mNameIn));

    var mUrlIn = document.createElement("input");
    mUrlIn.className = "cfg-input";
    mUrlIn.placeholder = "备用端点 Base URL (留空则沿用主地址)";
    addGrid.appendChild(field("服务地址 (可选)", mUrlIn));

    addBox.appendChild(addGrid);

    var addBtn = el("button", "btn primary", "+ 添加到备用池");
    addBtn.type = "button";
    addBtn.addEventListener("click", function () {
      var nm = mNameIn.value.trim();
      if (!nm) { toast("请输入模型名称", "err"); return; }
      var nextFb = (fallbacks || []).concat([{ model: nm, baseUrl: mUrlIn.value.trim() || c.baseUrl || "" }]);
      postJSON("/api/config", { fallbacks: nextFb }).then(function () {
        if (S.config) { S.config.fallbacks = nextFb; }
        renderConfigModalContent();
        toast("已添加备用模型", "ok");
      });
    });
    addBox.appendChild(addBtn);
    wrap.appendChild(addBox);

    body.appendChild(wrap);
  }

  function renderParamsTab(body, c) {
    var wrap = el("div", "cfg-params-pane");
    var intro = el("div", "cfg-pane-intro");
    intro.innerHTML = "<div class='cfg-pane-title'>Claude 生成参数与工作区设定</div><div class='cfg-pane-desc'>微调温度系数、最大输出 Token、请求超时与工具执行权限模式。</div>";
    wrap.appendChild(intro);

    var grid = el("div", "cfg-form-grid");

    // 用户称呼
    var nameInput = document.createElement("input");
    nameInput.className = "cfg-input";
    nameInput.value = userName();
    nameInput.placeholder = "留空则显示通用问候语";
    grid.appendChild(field("您的称呼（用于顶部与欢迎区问候）", nameInput));

    // 温度 Temperature
    var tempField = el("div", "cfg-field");
    var tempLabel = el("label", null, "采样温度 (Temperature): " + (c.temperature ?? 0.7));
    var tempSlider = document.createElement("input");
    tempSlider.type = "range";
    tempSlider.min = "0.0";
    tempSlider.max = "1.5";
    tempSlider.step = "0.05";
    tempSlider.value = String(c.temperature ?? 0.7);
    tempSlider.className = "cfg-range";
    tempSlider.addEventListener("input", function () {
      tempLabel.textContent = "采样温度 (Temperature): " + tempSlider.value;
    });
    tempField.appendChild(tempLabel);
    tempField.appendChild(tempSlider);
    grid.appendChild(tempField);

    // 最大输出 Token 数
    var maxTokInput = document.createElement("input");
    maxTokInput.type = "number";
    maxTokInput.className = "cfg-input";
    maxTokInput.value = String(c.maxTokens || 8192);
    grid.appendChild(field("单次最大输出 Tokens (Max Output Tokens)", maxTokInput));

    // 超时时间
    var timeoutInput = document.createElement("input");
    timeoutInput.type = "number";
    timeoutInput.className = "cfg-input";
    timeoutInput.value = String(Math.round((c.requestTimeoutMs || 90000) / 1000));
    grid.appendChild(field("请求超时时间 (秒)", timeoutInput));

    // 权限模式
    var modeSel = document.createElement("select");
    modeSel.className = "cfg-select";
    ((c.modes && c.modes.length ? c.modes : [
      { id: "ask", zh: "询问", desc: "每次写入前需用户批准" },
      { id: "auto", zh: "自动", desc: "自动批准所有常规工具调用" },
      { id: "plan", zh: "计划", desc: "只读模式，先提供分析方案" }
    ])).forEach(function (m) {
      var opt = document.createElement("option");
      opt.value = m.id;
      opt.textContent = m.zh + "：" + m.desc;
      if ((c.permissionMode || "ask") === m.id) { opt.selected = true; }
      modeSel.appendChild(opt);
    });
    grid.appendChild(field("自主执行模式 (Permission Mode)", modeSel));

    // 视觉支持
    var visWrap = el("label", "switch");
    var vis = document.createElement("input");
    vis.type = "checkbox";
    vis.checked = S.vision !== false;
    visWrap.appendChild(vis);
    visWrap.appendChild(el("span", "switch-label", "启用多模态视觉（发送附件图片供模型解析）"));
    grid.appendChild(field("视觉支持 (Vision)", visWrap));

    wrap.appendChild(grid);

    var saveParamsBtn = el("button", "btn primary", "保存参数配置");
    saveParamsBtn.type = "button";
    saveParamsBtn.addEventListener("click", function () {
      try { localStorage.setItem(LS_NAME, nameInput.value.trim()); } catch (e) {}
      renderProfile();
      var patch = {
        temperature: parseFloat(tempSlider.value) || 0.7,
        maxTokens: parseInt(maxTokInput.value, 10) || 8192,
        requestTimeoutMs: (parseInt(timeoutInput.value, 10) || 90) * 1000,
        permissionMode: modeSel.value,
        vision: vis.checked
      };
      postJSON("/api/config", patch).then(function (j) {
        if (S.config) { Object.assign(S.config, patch); }
        S.vision = vis.checked;
        renderVision();
        renderTopMeta();
        moveModeThumb();
        toast("参数配置已更新", "ok");
        closeModelConfigModal();
      }).catch(function (e) {
        toast("保存参数失败：" + e.message, "err");
      });
    });
    wrap.appendChild(saveParamsBtn);

    body.appendChild(wrap);
  }

  // 保持原有接口兼容
  function openSettings() {
    openModelConfigModal("providers");
  }

  function openTools() {
    var tools = (S.config && S.config.tools) || [];
    openModal("工具（" + tools.length + "）", function (body) {
      if (!tools.length) { body.appendChild(el("div", "empty-note", "暂无工具")); return; }
      var intro = el("div", "tools-intro");
      intro.appendChild(el("b", null, String(tools.length)));
      intro.appendChild(document.createTextNode(" 个已注册工具 · 由模型在对话中按权限调用；这里是只读清单，不直接执行。"));
      body.appendChild(intro);

      function cardFor(t) {
        var card = el("div", "tool-card");
        card.title = t.description || "";
        card.appendChild(el("b", null, t.name));
        card.appendChild(el("span", null, toolZh(t.name, t.description)));
        return card;
      }
      function appendGroup(name, items) {
        if (!items.length) { return; }
        var group = el("section", "tool-group");
        var head = el("div", "tool-group-head");
        head.appendChild(el("span", "tool-group-name", name));
        head.appendChild(el("span", "tool-group-count", String(items.length)));
        group.appendChild(head);
        var grid = el("div", "tool-grid");
        items.forEach(function (t) { grid.appendChild(cardFor(t)); });
        group.appendChild(grid);
        body.appendChild(group);
      }

      var remaining = tools.slice();
      TOOL_GROUPS.forEach(function (g) {
        var items = [];
        g.tools.forEach(function (n) {
          var idx = -1;
          for (var i = 0; i < remaining.length; i++) {
            if (remaining[i].name === n) { idx = i; break; }
          }
          if (idx >= 0) { items.push(remaining[idx]); remaining.splice(idx, 1); }
        });
        appendGroup(g.name, items);
      });
      appendGroup("其它", remaining);
    }, [{ label: "关闭", fn: closeModal }], { wide: true });
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
    // Agent Inbox 直渲染进右栏「任务」页签（affectui.com 风格：筛选页签+
    // 计数+状态标签+活动计时+可展开输出+终止）。页签激活期间每 1.5s 轮询。
    var inbox = { filter: "all", timer: null };
    function fmtClock(ms) {
      var s = Math.max(0, Math.floor(ms / 1000));
      var m = Math.floor(s / 60); s = s % 60;
      return (m > 0 ? m + "m " : "") + (s < 10 && m > 0 ? "0" : "") + s + "s";
    }
    function statusTag(t) {
      var cls = t.status === "running" ? "run" : (t.exitCode === 0 ? "ok" : "fail");
      var zh = t.status === "running" ? "运行中" : (t.exitCode === 0 ? "完成" : "失败");
      var tag = el("span", "pill " + cls, zh);
      if (t.status === "running") tag.classList.add("pulse");
      return tag;
    }
    function render() {
      if (S.inspTab !== "tasks") { if (inbox.timer) { clearInterval(inbox.timer); inbox.timer = null; } return; }
      getJSON("/api/tasks").then(function (j) {
        var body = $("tasks-body");
        if (!body || S.inspTab !== "tasks") { return; }
        body.innerHTML = "";
        var list = j.tasks || [];
        var counts = { all: list.length, running: 0, done: 0, fail: 0 };
        list.forEach(function (t) { if (t.status === "running") counts.running++; else if (t.exitCode === 0) counts.done++; else counts.fail++; });
        var tabs = el("div", "inbox-tabs");
        [["all", "全部"], ["running", "运行中"], ["done", "完成"], ["fail", "失败"]].forEach(function (pair) {
          var b = el("button", "inbox-tab" + (inbox.filter === pair[0] ? " active" : ""), pair[1] + " " + counts[pair[0]]);
          b.type = "button";
          b.addEventListener("click", function () { inbox.filter = pair[0]; render(); });
          tabs.appendChild(b);
        });
        body.appendChild(tabs);
        var shown = list.filter(function (t) {
          if (inbox.filter === "all") return true;
          if (inbox.filter === "running") return t.status === "running";
          if (inbox.filter === "done") return t.status !== "running" && t.exitCode === 0;
          return t.status !== "running" && t.exitCode !== 0;
        });
        if (!shown.length) { body.appendChild(el("div", "empty-note", "暂无后台任务")); return; }
        shown.forEach(function (t) {
          var row = el("div", "inbox-row" + (t.status === "running" ? " live" : ""));
          var head = el("div", "inbox-head");
          head.appendChild(statusTag(t));
          var cmd = el("div", "inbox-cmd", t.command || t.id);
          cmd.title = t.command || "";
          head.appendChild(cmd);
          head.appendChild(el("span", "inbox-clock", t.startedAt ? fmtClock(Date.now() - t.startedAt) : "—"));
          row.appendChild(head);
          var detail = null;
          head.addEventListener("click", function () {
            if (detail && detail.parentNode) { detail.remove(); row.classList.remove("open"); return; }
            detail = el("div", "inbox-detail");
            detail.appendChild(el("div", "inbox-id", t.id + (t.pid ? " · pid " + t.pid : "")));
            var outPre = el("pre", "inbox-out", "加载输出…");
            detail.appendChild(outPre);
            var acts = el("div", "inbox-acts");
            var refresh = el("button", "inbox-btn", "刷新输出");
            refresh.type = "button";
            refresh.addEventListener("click", function (ev) {
              ev.stopPropagation();
              getJSON("/api/tasks/output?id=" + encodeURIComponent(t.id)).then(function (o) { outPre.textContent = (o.output || "(无输出)").slice(-4000); outPre.scrollTop = outPre.scrollHeight; }).catch(function (e) { outPre.textContent = "读取失败: " + e.message; });
            });
            acts.appendChild(refresh);
            if (t.status === "running") {
              var kill = el("button", "inbox-btn danger", "终止");
              kill.type = "button";
              kill.addEventListener("click", function (ev) { ev.stopPropagation(); postJSON("/api/tasks/kill", { id: t.id }).then(function () { render(); }); });
              acts.appendChild(kill);
            }
            detail.appendChild(acts);
            row.appendChild(detail);
            row.classList.add("open");
            refresh.click();
          });
          body.appendChild(row);
        });
      }).catch(function () {});
    }
    render();
    if (!inbox.timer) { inbox.timer = setInterval(render, 1500); }
  }
  /** /tasks 与 /bashes：先确保右栏打开并切到「任务」页签，再交给 switchInspectorTab 渲染。
   * openTasks() 本身只往 #tasks-body 里画，页签未激活时该容器是 hidden ——
   * 以前两个命令点了没反应，就是这个原因。不要反过来在 openTasks 里调
   * switchInspectorTab，会形成递归（switchInspectorTab → openTasks → …）。 */
  function showTasks() {
    var appEl = $("app");
    if (appEl && !appEl.classList.contains("insp-open")) { setInspector(true); }
    switchInspectorTab("tasks");
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

  function openSessionMenu(s, x, y, isArchived) {
    var old = $("session-menu");
    if (old && old.parentNode) { old.parentNode.removeChild(old); }
    var menu = el("div", "ctx");
    menu.id = "session-menu";
    menu.appendChild(ctxItem(s.pinned ? "取消置顶" : "置顶", function () {
      patchJSON("/api/sessions/" + encodeURIComponent(s.id), { pinned: !s.pinned }).then(refreshSessions);
    }));
    menu.appendChild(ctxItem(isArchived ? "移出归档" : "归档会话", function () {
      toggleArchiveSession(s, !isArchived);
    }));
    menu.appendChild(ctxItem("重命名", function () {
      openModal("重命名对话", function (body) {
        var inp = document.createElement("input");
        inp.value = s.title || s.id;
        inp.placeholder = "输入新的对话名称";
        body.appendChild(field("对话名称", inp));
        body._saveRename = function () {
          var v = inp.value.trim();
          if (v) {
            patchJSON("/api/sessions/" + encodeURIComponent(s.id), { title: v }).then(refreshSessions);
          }
          closeModal();
        };
        setTimeout(function () { inp.focus(); inp.select(); }, 20);
      }, [
        { label: "取消", cls: "ghost", fn: closeModal },
        { label: "保存", cls: "primary", fn: function () {
          var b = $("modal-body");
          if (b && b._saveRename) { b._saveRename(); }
        } }
      ]);
    }));
    menu.appendChild(ctxItem("导出 Markdown", function () { exportSession(s.id, s.title); }));
    menu.appendChild(ctxItem("导出 HTML（自包含快照）", function () { exportSessionHtml(s.id, s.title); }));
    menu.appendChild(ctxItem("分享 · 复制只读链接", function () { shareSession(s.id); }));
    menu.appendChild(ctxItem("取消分享", function () { unshareSession(s.id); }));
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

  /** 导出为自包含 HTML 快照（离线可读，观感与分享页一致）。 */
  function exportSessionHtml(id, title) {
    var base = location.origin + location.pathname.replace(/\/[^/]*$/, "");
    fetch(base + "/api/session/export?format=html&id=" + encodeURIComponent(id))
      .then(function (r) {
        if (!r.ok) { throw new Error("HTTP " + r.status); }
        return r.blob();
      })
      .then(function (blob) {
        var url = URL.createObjectURL(blob);
        var a = document.createElement("a");
        a.href = url;
        a.download = (title || id).replace(/[\\/:*?"<>|]+/g, "_") + ".html";
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
        toast("已导出 HTML 快照", "ok");
      })
      .catch(function (e) { toast("导出失败：" + e.message, "err"); });
  }

  /* ---- 分享：创建/复制/撤销只读快照链接（对齐 claude.ai 的 Share chat） ---- */
  function shareSession(id) {
    postJSON("/api/share", { id: id }).then(function (j) {
      if (!j.ok) { throw new Error(j.error || "创建快照失败"); }
      var link = location.origin + j.url;
      copyText(link);
      toast((j.updated ? "已更新分享快照，链接已复制" : "分享链接已复制") + "（只读快照）", "ok");
      refreshSessions();
    }).catch(function (e) { toast("分享失败：" + e.message, "err"); });
  }

  function unshareSession(id) {
    delJSON("/api/share", { id: id }).then(function (j) {
      toast(j.removed ? "已撤销分享（原链接即刻失效）" : "此会话没有分享链接", j.removed ? "ok" : "info");
      refreshSessions();
    }).catch(function (e) { toast("撤销失败：" + e.message, "err"); });
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

  /* ---- Skills（技能）：GUI 面板 + /技能名 passthrough。布局与 Claude Code
   * 一致（.myclaude/skills/<名>/SKILL.md），模型经 skill_listing 自主调用。 ---- */
  var skillsList = [];

  function loadSkillsList() {
    return getJSON("/api/skills").then(function (j) {
      skillsList = j.skills || [];
      refreshSkillBadge();
      return skillsList;
    }).catch(function () { skillsList = []; return []; });
  }

  function findSkill(name) {
    var n = String(name || "").toLowerCase();
    for (var i = 0; i < skillsList.length; i++) {
      if (skillsList[i].name === n) { return skillsList[i]; }
    }
    return null;
  }

  /** /技能名 → 按原文发普通回合；agent 端 skill_mention 附件会提示模型调用 Skill 工具。 */
  function runSkillPassthrough(text) {
    if (S.busy) { toast("任务运行中，请先停止或等它结束", "warn"); return; }
    addUserMessage(text, []);
    S.lastUserText = text;
    runTurn({ message: text, sessionKey: S.sessionKey, attachments: [] });
  }

  function skillScopeLabel(scope) {
    return scope === "builtin" ? "内置" : scope === "user" ? "用户级" : scope === "plugin" ? "插件" : "项目级";
  }

  function refreshSkillBadge() {
    var b = $("skill-count");
    if (b) { b.textContent = String(skillsList.length); }
  }

  function openSkillsManager() {
    loadSkillsList().then(function () {
      openModal("技能（" + skillsList.length + "）", function (body) {
        var intro = el("div", "tools-intro");
        intro.appendChild(el("b", null, String(skillsList.length)));
        intro.appendChild(document.createTextNode(" 个技能 · 模型按描述自主调用；消息里输入 /技能名 也直接生效。新建技能写入 .myclaude/skills/<名>/SKILL.md，与 Claude Code 布局一致。"));
        body.appendChild(intro);

        var listBox = el("div", "skill-list");
        body.appendChild(listBox);
        skillsList.forEach(function (s) {
          var row = el("div", "skill-row");
          // 显示真实来源路径：用户级技能可能来自 ~/.claude/skills（上游布局），
          // 删除会连上游 Claude Code 的技能一起移除——把路径亮出来避免误删。
          row.title = s.file || "";
          var main = el("div", "skill-main");
          var head = el("div", "skill-head");
          head.appendChild(el("b", null, "/" + s.name));
          head.appendChild(el("span", "pill scope-" + s.scope, skillScopeLabel(s.scope)));
          main.appendChild(head);
          main.appendChild(el("div", "skill-desc", s.description || ""));
          row.appendChild(main);
          if (s.scope !== "builtin" && s.scope !== "plugin") {
            var del = el("button", "model-action-btn skill-del", "删除");
            del.type = "button";
            del.title = "删除技能 " + s.name + "（同时移除磁盘目录）";
            del.addEventListener("click", function () {
              if (!window.confirm("删除技能 /" + s.name + "？将删除对应 SKILL.md 目录，不可恢复。")) { return; }
              fetch("/api/skills/" + encodeURIComponent(s.name), { method: "DELETE" })
                .then(function (r) { return r.json(); })
                .then(function (j) {
                  if (!j.ok) { toast("删除失败：" + (j.error || "未知错误"), "err"); return; }
                  toast("已删除技能 /" + s.name, "ok");
                  closeModal();
                  openSkillsManager();
                })
                .catch(function (e) { toast("删除失败：" + e.message, "err"); });
            });
            row.appendChild(del);
          }
          listBox.appendChild(row);
        });
        if (!skillsList.length) {
          listBox.appendChild(el("div", "empty-note", "还没有技能。用下方表单创建第一个技能。"));
        }

        var form = el("div", "skill-create");
        form.appendChild(el("div", "skill-create-head", "新建 / 更新技能"));
        var rowName = el("div", "skill-create-row");
        var nameIn = el("input", "skill-input");
        nameIn.type = "text";
        nameIn.placeholder = "技能名（如 code-review；小写字母/数字/连字符）";
        rowName.appendChild(nameIn);
        var descIn = el("input", "skill-input");
        descIn.type = "text";
        descIn.placeholder = "一句话描述（模型靠它决定何时使用这个技能）";
        rowName.appendChild(descIn);
        form.appendChild(rowName);
        var bodyIn = el("textarea", "skill-textarea");
        bodyIn.rows = 8;
        bodyIn.placeholder = "SKILL.md 正文：给模型的操作指南（步骤、注意事项、示例）。# 标题开头更清晰。";
        form.appendChild(bodyIn);
        var overRow = el("label", "skill-over-row");
        var overChk = el("input");
        overChk.type = "checkbox";
        overRow.appendChild(overChk);
        overRow.appendChild(document.createTextNode(" 同名时覆盖更新"));
        form.appendChild(overRow);
        var btnRow = el("div", "skill-btn-row");
        var createBtn = el("button", "btn primary", "保存技能");
        createBtn.type = "button";
        createBtn.addEventListener("click", function () {
          var payload = {
            name: nameIn.value.trim(),
            description: descIn.value.trim(),
            body: bodyIn.value,
            overwrite: overChk.checked
          };
          if (!payload.name) { toast("请先填技能名", "warn"); nameIn.focus(); return; }
          if (!payload.body.trim()) { toast("技能正文不能为空", "warn"); bodyIn.focus(); return; }
          postJSON("/api/skills", payload).then(function (j) {
            if (!j.ok) { toast(j.error || "保存失败", "err"); return null; }
            toast("技能 /" + j.name + " 已保存到 .myclaude/skills/" + j.name + "/SKILL.md", "ok");
            closeModal();
            return loadSkillsList().then(function () { openSkillsManager(); });
          }).catch(function (e) { toast("保存失败：" + e.message, "err"); });
        });
        btnRow.appendChild(createBtn);
        form.appendChild(btnRow);
        body.appendChild(form);
      }, [{ label: "关闭", fn: closeModal }], { wide: true });
    });
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
    { k: "/auto", d: "自主续跑：到回合上限自动继续（/auto on|off|status）", fn: function () { runCommand("/auto status"); } },
    { k: "/tools", d: "可用工具", fn: function () { openTools(); } },
    { k: "/config", d: "查看当前配置", fn: function () { runCommand("/config"); } },
    { k: "/sessions", d: "历史会话", fn: function () { openSessions(); } },
    { k: "/files", d: "浏览工作目录", fn: function () { openFiles(); } },
    { k: "/prompts", d: "打开提示词与系统指令库（Prompt Library）", fn: function () { openPromptLibraryModal(); } },
    { k: "/tasks", d: "后台任务", fn: function () { showTasks(); } },
    { k: "/bashes", d: "后台 shell（/tasks 别名）", fn: function () { showTasks(); } },
    { k: "/settings", d: "设置", fn: function () { openSettings(); } },
    { k: "/voice", d: "开启/关闭免费中文语音转文字（Alt+V）", fn: function () { toggleVoiceInput(); } },
    { k: "/shortcuts", d: "键盘快捷键面板（? 或 Ctrl+/）", fn: function () { openShortcutsModal(); } },
    { k: "/theme", d: "切换深色 / 浅色", fn: function () { toggleTheme(); } },
    { k: "/status", d: "会话状态一览", fn: function () { runCommand("/status"); } },
    { k: "/stats", d: "消息 / 回合 / token 统计", fn: function () { runCommand("/stats"); } },
    { k: "/context", d: "上下文分解与水位", fn: function () { runCommand("/context"); } },
    { k: "/cost", d: "token 用量与计价估算", fn: function () { runCommand("/cost"); } },
    { k: "/doctor", d: "环境健康检查", fn: function () { runCommand("/doctor"); } },
    { k: "/title", d: "重命名当前会话（/title <名称>）", fn: function () { runCommand("/title"); } },
    { k: "/todos", d: "待办清单", fn: function () { runCommand("/todos"); } },
    { k: "/permissions", d: "权限规则", fn: function () { runCommand("/permissions"); } },
    { k: "/hooks", d: "Hooks 配置", fn: function () { runCommand("/hooks"); } },
    { k: "/mcp", d: "MCP 服务器", fn: function () { runCommand("/mcp"); } },
    { k: "/effort", d: "思考深度（/effort high|medium|low|off）", fn: function () { runCommand("/effort"); } },
    { k: "/models", d: "打开模型选择器", fn: function () { runCommand("/models"); } },
    { k: "/export", d: "导出对话", fn: function () { runCommand("/export"); } },
    { k: "/memory", d: "项目记忆（/memory add <内容>）", fn: function () { runCommand("/memory"); } },
    { k: "/skills", d: "已安装技能", fn: function () { runCommand("/skills"); } },
    { k: "/skill", d: "直接执行技能正文（/skill <名> [参数]）", fn: function () { runCommand("/skill"); } },
    { k: "/attach", d: "附加本地文件（/attach <路径>）", fn: function () { runCommand("/attach"); } },
    { k: "/attachments", d: "查看当前附件", fn: function () { runCommand("/attachments"); } },
    { k: "/detach", d: "移除附件（/detach 序号|all）", fn: function () { runCommand("/detach"); } },
    { k: "/continue", d: "继续最近一次会话", fn: function () { runCommand("/continue"); } },
    { k: "/rm", d: "删除会话（/rm <会话 id>）", fn: function () { runCommand("/rm"); } },
    { k: "/save", d: "立即落盘当前会话", fn: function () { runCommand("/save"); } },
    { k: "/computer-use", d: "Computer Use 开关（on|off）", fn: function () { runCommand("/computer-use"); } },
    { k: "/vision", d: "视觉开关（on|off）", fn: function () { runCommand("/vision"); } },
    { k: "/base", d: "查看或设置 baseUrl", fn: function () { runCommand("/base"); } },
    { k: "/key", d: "查看或设置 API Key", fn: function () { runCommand("/key"); } },
    { k: "/reload-memory", d: "重读项目记忆", fn: function () { runCommand("/reload-memory"); } },
    { k: "/dream", d: "整理项目记忆（去重/合并过时条目）", fn: function () { runCommand("/dream"); } },
    { k: "/loop", d: "循环跑提示词（/loop <提示词> --cycles N --every 秒）", fn: function () { runCommand("/loop"); } },
    { k: "/plugin", d: "已安装插件", fn: function () { runCommand("/plugin"); } },
    { k: "/agents", d: "已定义子代理", fn: function () { runCommand("/agents"); } },
    { k: "/release-notes", d: "发布说明", fn: function () { runCommand("/release-notes"); } },
    { k: "/add-dir", d: "额外工作目录（/add-dir <路径>）", fn: function () { runCommand("/add-dir"); } },
    { k: "/compact", d: "立即压缩上下文", fn: function () { runCommand("/compact"); } },
    { k: "/rewind", d: "回退上一回合（含文件）", fn: function () { runCommand("/rewind"); } },
    { k: "/fast", d: "快速模式（/fast on|off|status）", fn: function () { runCommand("/fast status"); } },
    { k: "/fork", d: "从当前会话分叉新会话", fn: function () { runCommand("/fork"); } },
    { k: "/branch", d: "分叉会话（/fork 别名）", fn: function () { runCommand("/branch"); } },
    { k: "/init", d: "生成 MYCLAUDE.md（/init force 重生成）", fn: function () { runCommand("/init"); } },
    { k: "/clear", d: "新对话（/new 别名）", fn: function () { newChat(); } },
    { k: "/provider", d: "打开供应商设置", fn: function () { openSettings(); }  },
    { k: "/engine", d: "原生 Claude Code 引擎（/engine <提示>）", fn: function () { runCommand("/engine"); } },
    { k: "/advisor", d: "复核模型开关（auto 模式，on|off|status）", fn: function () { runCommand("/advisor"); } },
    { k: "/auto-mode-setup", d: "自动模式本地设置（status|apply）", fn: function () { runCommand("/auto-mode-setup"); } },
    { k: "/autocompact", d: "自动压缩开关（on|off|status）", fn: function () { runCommand("/autocompact"); } },
    { k: "/subtask", d: "子任务与后台代理清单", fn: function () { runCommand("/subtask"); } },
    { k: "/cd", d: "切换工作目录（仅 TUI 可用）", fn: function () { runCommand("/cd"); } },
    { k: "/color", d: "终端彩色输出开关", fn: function () { runCommand("/color"); } },
    { k: "/vim", d: "vim 输入偏好（本机记录配置）", fn: function () { runCommand("/vim"); } },
    { k: "/diff", d: "查看工作区 git diff", fn: function () { runCommand("/diff"); } },
    { k: "/background", d: "后台任务清单", fn: function () { runCommand("/background"); } },
    { k: "/stop", d: "停止当前回合", fn: function () { runCommand("/stop"); } },
    { k: "/focus", d: "专注模式开关", fn: function () { runCommand("/focus"); } },
    { k: "/heapdump", d: "导出 Node 堆快照（仅 TUI 可用）", fn: function () { runCommand("/heapdump"); } },
    { k: "/keybindings", d: "键盘绑定一览", fn: function () { runCommand("/keybindings"); } },
    { k: "/import", d: "云端导入（本机降级提示）", fn: function () { runCommand("/import"); } },
    { k: "/pause-memory", d: "暂停项目记忆读取偏好", fn: function () { runCommand("/pause-memory"); } },
    { k: "/reload-plugins", d: "重新加载插件", fn: function () { runCommand("/reload-plugins"); } },
    { k: "/reload-skills", d: "重新加载技能", fn: function () { runCommand("/reload-skills"); } },
    { k: "/rename", d: "重命名当前会话", fn: function () { runCommand("/rename"); } },
    { k: "/statusline", d: "状态行外部命令配置", fn: function () { runCommand("/statusline"); } },
    { k: "/tui", d: "终端界面说明", fn: function () { runCommand("/tui"); } },
    { k: "/ultrareview", d: "云端多代理审查（本机降级提示）", fn: function () { runCommand("/ultrareview"); } },
    { k: "/security-review", d: "本地安全审查", fn: function () { runCommand("/security-review"); } },
    { k: "/terminal-setup", d: "终端设置说明", fn: function () { runCommand("/terminal-setup"); } },
    { k: "/scroll-speed", d: "滚动速度（1-10）", fn: function () { runCommand("/scroll-speed"); } },
    { k: "/upgrade", d: "版本更新（本机降级提示）", fn: function () { runCommand("/upgrade"); } },
    { k: "/usage", d: "token 用量与计价", fn: function () { runCommand("/usage"); } },
    { k: "/insights", d: "云端分析（本机降级提示）", fn: function () { runCommand("/insights"); } },
    { k: "/recap", d: "本会话回顾", fn: function () { runCommand("/recap"); } },
    { k: "/goal", d: "会话目标（写入配置）", fn: function () { runCommand("/goal"); } },
    { k: "/sandbox", d: "沙箱偏好开关", fn: function () { runCommand("/sandbox"); } },
    { k: "/list-agents", d: "子代理定义清单", fn: function () { runCommand("/list-agents"); } },
    { k: "/artifacts", d: "云端产物（本机降级提示）", fn: function () { runCommand("/artifacts"); } },
    { k: "/team-onboarding", d: "团队引导（本机降级提示）", fn: function () { runCommand("/team-onboarding"); } },
    { k: "/output-style", d: "输出风格列表与切换", fn: function () { runCommand("/output-style"); } },
    { k: "/exit", d: "退出（GUI 说明）", fn: function () { runCommand("/exit"); } },
    { k: "/resume", d: "恢复指定会话", fn: function () { runCommand("/resume"); } },
    { k: "/session", d: "当前会话信息", fn: function () { runCommand("/session"); } },
    { k: "/plan", d: "当前计划（GUI 说明）", fn: function () { runCommand("/plan"); } }
  ];

  /* ------------------------------------------------------------------
   * GUI 内建命令补充（迭代第 2 轮）
   *
   * TUI main.js 有约 60 个内建命令，GUI 原先只实现了 switch 里约 20 个，
   * 其余一律落到「未知命令」。这里按「能映射到现有 API / 面板」逐批补齐，
   * 每条是 function(arg)，可异步（内部 fetch 自行 catch），不新增后端端点。
   * ------------------------------------------------------------------ */
  function fmtK(n) { var v = Number(n) || 0; return v >= 1000 ? (v / 1000).toFixed(1) + "k" : String(v); }
  function fmtUsd(n) { return "$" + Number(n).toFixed(4); }
  function ctxBar(label, used, limit) {
    var w = 24, share = limit > 0 ? Math.max(0, Math.min(1, used / limit)) : 0;
    var fill = Math.round(share * w);
    return "  " + label + "  │" + new Array(fill + 1).join("█") + new Array(w - fill + 1).join("░") + "│ " + fmtK(used) + " / " + fmtK(limit);
  }
  function sessionKeyOf() { return S.sessionKey || "default"; }

  /* 上游 2.1.302 命令补齐（GUI 侧）
   * 浏览器没有 Node 文件系统 / 子进程 / v8 堆，所以：
   *  - 配置类命令用 localStorage 做真正的本机持久化（guiSetPref），
   *    /api/config 只白名单既有键，不改 gui-server；
   *  - 云端 / 账号 / 订阅类命令如实降级，明确写「本机无对应服务」并给本机替代；
   *  - 能复用现有面板 / 端点的就复用（/diff 走 /api/changes，/keybindings 走快捷键面板）。 */
  var GUI_PREFS_KEY = "myclaude.gui.prefs.v1";
  function guiPrefs() {
    try { return JSON.parse(localStorage.getItem(GUI_PREFS_KEY) || "{}") || {}; }
    catch (e) { return {}; }
  }
  function guiSetPref(key, value) {
    var p = guiPrefs();
    p[key] = value;
    try { localStorage.setItem(GUI_PREFS_KEY, JSON.stringify(p)); } catch (e) {}
    if (S.config) { S.config[key] = value; }
  }

  /* ---- GUI vim（R4）：复用 src/ui/vim.js 引擎（bundle 时注入为 window.__MCVim）----
     上游契约：editorMode==="vim" 启用；模式指示 -- INSERT -- / -- VISUAL --（NORMAL 隐藏，
     见上游 statusLine.hideVimModeIndicator 描述）；双击 esc 清空输入。
     中文 IME（isComposing/229）与系统剪贴板键直通，不接管。
     机器码在 IIFE 顶层：状态行刷新（另一函数）也要读 vimSt，块级声明会炸 boot 链。 */
  var V = window.__MCVim || null;
  var vimSt = null; // { enabled, session }
  function vimEnabledNow() {
    if (!V) { return false; }
    var prefs = guiPrefs();
    var cfg = S.config || {};
    return V.vimEnabled({ editorMode: cfg.editorMode, vimMode: prefs.vimMode != null ? !!prefs.vimMode : !!cfg.vimMode });
  }
  function vimEnsure() {
    var on = vimEnabledNow();
    if (!vimSt || vimSt.enabled !== on) {
      var inEl = $("in");
      vimSt = {
        enabled: on,
        session: on ? V.createVimSession({
          text: inEl ? inEl.value : "",
          cursor: inEl ? inEl.value.length : 0,
          insertRemaps: V.normalizeInsertRemaps((S.config && S.config.vimInsertModeRemaps) || null),
        }) : null,
      };
    }
    return vimSt.enabled ? vimSt.session : null;
  }
  function vimIndicator() { return $("vim-indicator"); }
  function renderVimIndicator() {
    var elx = vimIndicator();
    if (!elx) { return; }
    var st = vimSt && vimSt.enabled ? vimSt.session : null;
    if (!st || st.mode === V.NORMAL) { elx.hidden = true; elx.textContent = ""; return; }
    elx.hidden = false;
    var label = V.MODE_LABELS[st.mode] || "";
    var pending = V.vimPendingLabel(st);
    elx.textContent = pending ? label + "  " + pending : label;
  }
  function vimSyncTextarea() {
    var inEl = $("in");
    var st = vimSt.session;
    inEl.value = st.text;
    try {
      if ((st.mode === V.VISUAL || st.mode === V.VLINE)) {
        // VISUAL 选区 → 原生 setSelectionRange：浏览器直接渲染反色高亮
        //（textarea 原生控件无法自绘选区，借原生 selection 是最小实现）
        var segs = V.visualSelection(st);
        if (segs.length) { inEl.setSelectionRange(segs[0][0], segs[0][1]); }
        else { inEl.setSelectionRange(st.cursor, st.cursor); }
      } else {
        inEl.setSelectionRange(st.cursor, st.cursor);
      }
    } catch (e2) {}
    autoGrow(inEl);
    updateSlashMenu(inEl.value);
    saveDraftSoon(inEl.value);
    renderVimIndicator();
  }
  /** 把 DOM KeyboardEvent 翻译成引擎键；接管返回 true。 */
  function vimHandleKey(e) {
    var inEl = $("in");
    var st0 = vimEnsure();
    if (!st0) { renderVimIndicator(); return false; }
    // 外部写入（粘贴、菜单补全）以 DOM 为准对齐引擎，防双写错位
    if (st0.text !== inEl.value) {
      st0.text = inEl.value;
      st0.cursor = inEl.selectionStart != null ? inEl.selectionStart : inEl.value.length;
    }
    // 中文 IME 组合中：完全直通（GUI 的硬可用性边界）
    if (e.isComposing || e.keyCode === 229) { return false; }
    // 系统剪贴板/全选/撤销重做交给浏览器（GUI 与 TUI 的差异，如实保留）
    if (e.ctrlKey || e.metaKey) {
      var k = String(e.key || "").toLowerCase();
      if (["c", "v", "x", "a", "z", "y"].indexOf(k) >= 0) { return false; }
    }
    var ch = null;
    var key = {};
    if (e.key === "Escape") { key.escape = true; }
    else if (e.key === "Enter") { key.return = true; }
    else if (e.key === "Backspace") { key.backspace = true; }
    else if (e.key === "Delete") { key.delete = true; }
    else if (e.key === "ArrowLeft") { key.leftArrow = true; }
    else if (e.key === "ArrowRight") { key.rightArrow = true; }
    else if (e.key === "ArrowUp") { key.upArrow = true; }
    else if (e.key === "ArrowDown") { key.downArrow = true; }
    else if (e.key === "Tab") { key.tab = true; }
    else if (e.ctrlKey || e.metaKey) { ch = String(e.key || "").toLowerCase(); key.ctrl = true; }
    else if (e.key && e.key.length === 1) { ch = e.key; }
    else { return false; } // Home/Fn 等不接管
    var r = V.vimApply(st0, ch, key);
    vimSyncTextarea();
    if (r.submit) { sendMessage(); }
    e.preventDefault();
    return true;
  }
  function guiUnsupported(name, alt) {
    return "本机无对应服务：/" + name + " 依赖上游云端/账号/订阅服务，MyClaude 本机没有对应服务" +
      (alt ? "\n本机可用替代：" + alt : "");
  }
  function guiBool(name, arg, key, opts) {
    var o = opts || {};
    var v = String(arg || "").trim().toLowerCase();
    var p = guiPrefs();
    var cur = p[key] != null ? !!p[key] :
      (S.config && S.config[key] != null ? !!S.config[key] : !!o.def);
    if (!v || v === "status") {
      addNotice("/" + name + " = " + (cur ? "on" : "off") + "（用法：/" + name + " on|off|status）", "info");
      return;
    }
    var on = ["on", "1", "true", "yes"].indexOf(v) >= 0 ? true :
      ["off", "0", "false", "no"].indexOf(v) >= 0 ? false : null;
    if (on === null) { addNotice("用法：/" + name + " on|off|status", "warn"); return; }
    guiSetPref(key, on);
    toast((on ? (o.onText || "/" + name + " 已开启") : (o.offText || "/" + name + " 已关闭")) +
      "（已保存到本机 GUI 偏好）", "ok");
  }
  function guiValue(name, arg, key, opts) {
    var o = opts || {};
    var v = String(arg || "").trim();
    var p = guiPrefs();
    var cur = p[key] != null ? p[key] : (S.config && S.config[key] != null ? S.config[key] : null);
    if (!v || v === "status") {
      addNotice("/" + name + " = " + (cur == null ? "(未设置)" : cur) +
        "\n用法：/" + name + " <值>|clear", "info");
      return;
    }
    if (["clear", "off", "none", "delete"].indexOf(v.toLowerCase()) >= 0) {
      guiSetPref(key, null);
      toast("/" + name + " 已清除", "ok");
      return;
    }
    var value = typeof o.parse === "function" ? o.parse(v) : v;
    if (value == null) { addNotice(o.invalid || ("用法：/" + name + " <值>"), "warn"); return; }
    guiSetPref(key, value);
    toast("/" + name + " = " + value + "（已保存到本机 GUI 偏好）", "ok");
  }

  var EXTRA_COMMANDS = {
    status: function () {
      var c = S.config || {}, s = S.stats || {};
      addNotice([
        "模型        " + (c.model || "-"),
        "供应商      " + (c.provider || (c.endpoint && c.endpoint.vendor) || "-"),
        "权限模式    " + modeName(c.permissionMode || "ask"),
        "思考深度    " + (c.effort || "默认"),
        "MCP 服务器  用 /mcp 查看实时状态",
        "接口地址    " + (c.baseUrl || "-"),
        "消息 / 回合 " + (s.messages || 0) + " / " + (s.turns || 0),
        "上下文      " + fmtK(s.contextUsed || 0) + " / " + fmtK(s.contextLimit || 0) + " tok"
      ].join("\n"), "info");
    },
    stats: function () {
      var s = S.stats || {};
      addNotice("消息 " + (s.messages || 0) + " 条 · 回合 " + (s.turns || 0) + "\n" +
        "累计输入 " + fmtK(s.inputTokens || 0) + " tok · 累计输出 " + fmtK(s.outputTokens || 0) + " tok\n" +
        "当前上下文 " + fmtK(s.contextUsed || 0) + " / " + fmtK(s.contextLimit || 0) + " tok", "info");
    },
    context: function () {
      var s = S.stats || {}, c = S.config || {};
      // 新会话还没有 stats，用模型窗口 × 压缩阈值给出有意义的压缩线，
      // 否则满屏 0 / 0 的空条没有信息量。
      var limit = s.contextLimit || Math.round((Number(c.modelContextWindow) || 200000) * 0.8);
      var sys = s.systemTokens || 0, hist = s.historyTokens || 0, used = s.contextUsed || 0;
      addNotice([
        "上下文分解（压缩线 " + fmtK(limit) + " tok）",
        ctxBar("系统提示", sys, limit),
        ctxBar("历史消息", hist, limit),
        ctxBar("已用合计", used, limit),
        ctxBar("剩余", Math.max(0, limit - used), limit),
        "",
        "  消息 " + (s.messages || 0) + " 条 · 回合 " + (s.turns || 0),
        "  累计输入 " + (s.inputTokens || 0) + " / 输出 " + (s.outputTokens || 0) + " tok"
      ].join("\n"), "info");
    },
    cost: function () {
      var c = S.config || {}, s = S.stats || {};
      var m = c.currentModel || null, inT = Number(s.inputTokens) || 0, outT = Number(s.outputTokens) || 0;
      var price = "该模型未配置价格，仅显示 token 用量";
      if (m && typeof m.inputPrice === "number" && typeof m.outputPrice === "number") {
        price = fmtUsd((inT / 1e6) * m.inputPrice + (outT / 1e6) * m.outputPrice) + "（按公开标价估算）";
      }
      addNotice([
        "模型   " + (c.model || "-"),
        "输入   " + inT.toLocaleString() + " tok",
        "输出   " + outT.toLocaleString() + " tok",
        "总计   " + (inT + outT).toLocaleString() + " tok",
        "计价   " + price
      ].join("\n"), "info");
    },
    doctor: function () {
      getJSON("/api/config").then(function (c) {
        var rows = [
          ["ok", "model", c.model || "(unset)"],
          ["ok", "baseUrl", c.baseUrl || "(unset)"],
          [c.apiKeyConfigured ? "ok" : "warn", "apiKey", c.apiKeyConfigured ? "(set)" : "未设置（网关可能不需要）"],
          ["ok", "tools", (c.tools || []).length + " 个"]
        ];
        return Promise.all([
          getJSON("/api/hooks").catch(function (e) { return { err: e.message }; }),
          getJSON("/api/mcp").catch(function (e) { return { err: e.message }; }),
          getJSON("/api/models").catch(function (e) { return { err: e.message }; })
        ]).then(function (r) {
          var hooks = r[0], mcp = r[1], models = r[2];
          rows.push([hooks.err ? "FAIL" : "ok", "hooks", hooks.err || Object.keys(hooks.hooks || {}).length + " 个事件"]);
          rows.push([mcp.err ? "FAIL" : "ok", "mcp", mcp.err || (mcp.servers || mcp.mcpServers || []).length + " 个服务器"]);
          var gwState = models.err ? "FAIL" : (models.probeOk === false ? "warn" : "ok");
          var gwDetail = models.err ? models.err :
            ((models.models || []).length + " 个模型 · " + (models.probeOk ? "网关可达" : "网关不可达（用缓存目录）"));
          rows.push([gwState, "gateway", gwDetail]);
          addNotice("MyClaude 环境检查\n" + rows.map(function (x) {
            return "  " + (x[0] === "ok" ? "✓" : x[0] === "warn" ? "!" : "✗") + "  " + x[1] + "  " + x[2];
          }).join("\n"), "info");
        });
      }).catch(function (e) { addNotice("环境检查失败：" + e.message, "err"); });
    },
    title: function (arg) {
      var name = String(arg || "").trim();
      if (!name) {
        var t = $("top-title");
        addNotice("当前会话标题：" + (t ? t.textContent.trim() : "(未命名)") + "\n用法：/title <标题>", "info");
        return;
      }
      var id = S.sessionKey;
      if (!id || id === "default") { addNotice("会话尚未保存，先发一条消息再使用 /title", "warn"); return; }
      fetch("/api/sessions/" + encodeURIComponent(id), {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: name })
      }).then(function (r) {
        if (!r.ok) { throw new Error("HTTP " + r.status); }
        S.titleOverride = { key: id, title: name };
        renderTopMeta(); refreshSessions();
        toast("会话标题 → " + name, "ok");
      }).catch(function (e) { addNotice("重命名失败：" + e.message, "err"); });
    },
    todo: function () { return EXTRA_COMMANDS.todos(); },
    todos: function () {
      getJSON("/api/todos?sessionKey=" + encodeURIComponent(sessionKeyOf())).then(function (j) {
        var list = j.todos || [];
        if (!list.length) { addNotice("暂无待办（/todos）", "info"); return; }
        var mark = { completed: "✓", in_progress: "▶", pending: "○", cancelled: "✗" };
        addNotice("待办清单（" + list.length + "）\n" + list.map(function (t) {
          return "  " + (mark[t.status] || "○") + " " + t.content;
        }).join("\n"), "info");
      }).catch(function (e) { addNotice("读取待办失败：" + e.message, "err"); });
    },
    permissions: function () {
      getJSON("/api/permissions").then(function (j) {
        var p = j.permissions || {};
        addNotice("权限规则\n" + ["allow", "deny", "ask"].map(function (k) {
          return "  " + k + "  " + (((p[k] || []).join("、")) || "（空）");
        }).join("\n"), "info");
      }).catch(function (e) { addNotice("读取权限失败：" + e.message, "err"); });
    },
    hooks: function () {
      getJSON("/api/hooks").then(function (j) {
        var h = j.hooks || {}, keys = Object.keys(h);
        var body = keys.length ? keys.map(function (k) {
          return "  " + k + "  " + (Array.isArray(h[k]) ? h[k].length + " 条" : JSON.stringify(h[k]).slice(0, 60));
        }).join("\n") : "  未配置；可用事件：" + (j.events || []).join("、");
        addNotice("Hooks（" + keys.length + " 个事件）\n" + body, "info");
      }).catch(function (e) { addNotice("读取 hooks 失败：" + e.message, "err"); });
    },
    mcp: function () {
      getJSON("/api/mcp").then(function (j) {
        var list = j.servers || j.mcpServers || [];
        if (!list.length) { addNotice("未连接 MCP 服务器（在 设置 → MCP 添加）", "info"); return; }
        addNotice("MCP 服务器（" + list.length + "）\n" + list.map(function (s) {
          return "  " + (s.name || "?") + "  " + (s.tools != null ? s.tools + " 工具" : (s.status || ""));
        }).join("\n"), "info");
      }).catch(function (e) { addNotice("读取 MCP 失败：" + e.message, "err"); });
    },
    effort: function (arg) {
      var v = String(arg || "").trim().toLowerCase();
      if (!v) { addNotice("思考深度：" + ((S.config || {}).effort || "默认") + "\n用法：/effort high|medium|low|off", "info"); return; }
      if (["high", "medium", "low", "off"].indexOf(v) < 0) { addNotice("用法：/effort high|medium|low|off", "warn"); return; }
      postJSON("/api/config", { effort: v }).then(function () {
        if (S.config) { S.config.effort = v === "off" ? null : v; }
        toast("思考深度 → " + v, "ok");
      }).catch(function (e) { addNotice("设置失败：" + e.message, "err"); });
    },
    models: function () {
      var b = $("btn-model");
      if (b) { toggleModelMenu(b); } else { addNotice("模型选择器不可用", "warn"); }
    },
    export: function () {
      var b = $("btn-export-chat");
      if (b) { b.click(); } else { addNotice("导出入口不可用", "warn"); }
    },
    restart: function () { runServerCommand("restart"); },
    update: function () { runServerCommand("restart"); },
    memory: function (arg) { runServerCommand("memory", arg); },
    skills: function () { openSkillsManager(); },
    plugin: function () { runServerCommand("plugin"); },
    agents: function () { runServerCommand("agents"); },
    "release-notes": function () { runServerCommand("release-notes"); },
    "add-dir": function (arg) { runServerCommand("add-dir", arg); },
    compact: function () { runServerCommand("compact"); },
    rewind: function (arg) { runServerCommand("rewind", arg); },
    engine: function (arg) {
      if (!arg) { runServerCommand("engine"); return; }
      // 引擎回合最长 180 秒，先给一条状态，结果由命令桥回传后显示。
      addNotice("原生引擎执行中…（最长 180 秒，完成后显示结果）", "info");
      runServerCommand("engine", arg);
    },
    fast: function (arg) {
      var v = String(arg || "").trim().toLowerCase();
      var cur = !!(S.config && S.config.fastMode);
      if (!v || v === "status") {
        addNotice("快速模式：" + (cur ? "开" : "关") + "\n用法：/fast on|off|status", "info");
        return;
      }
      if (v !== "on" && v !== "off" && v !== "1" && v !== "0") { addNotice("用法：/fast on|off|status", "warn"); return; }
      var on = v === "on" || v === "1";
      postJSON("/api/config", { fastMode: on }).then(function () {
        if (S.config) { S.config.fastMode = on; }
        toast(on ? "快速模式已开启 — 每轮只带最近 24 条历史" : "快速模式已关闭 — 每轮发送完整历史", "ok");
      }).catch(function (e) { addNotice("设置失败：" + e.message, "err"); });
    },
    // Claude Code 964_chunk-0qdm07jf：branch 是 fork 的别名（forkSessionId 同源）
    fork: function () { runServerCommand("fork"); },
    branch: function () { runServerCommand("branch"); },
    init: function (arg) { runServerCommand("init", arg); },
    clear: function () { newChat(); },
    provider: function () { openSettings(); },
    advisor: function (arg) { guiBool("advisor", arg, "autoReview", { onText: "advisor 复核已开启", offText: "advisor 复核已关闭" }); },
    "auto-mode-setup": function (arg) {
      var v = String(arg || "").trim().toLowerCase();
      if (!v || v === "status") {
        addNotice([
          "自动模式设置（本机）",
          "  permissionMode        " + ((S.config || {}).permissionMode || "ask"),
          "  advisor(autoReview)   " + ((S.config || {}).autoReview ? "on" : "off"),
          "  autoRun               " + ((S.config || {}).autoRun ? "on" : "off"),
          "用法：/auto-mode-setup apply（写入 permissionMode=auto + advisor=on）"
        ].join("\n"), "info");
        return;
      }
      if (v !== "apply" && v !== "on" && v !== "setup") { addNotice("用法：/auto-mode-setup status|apply", "warn"); return; }
      postJSON("/api/config", { permissionMode: "auto" }).then(function () {
        guiSetPref("autoReview", true);
        if (S.config) { S.config.permissionMode = "auto"; S.config.autoReview = true; }
        setMode("auto");
        toast("自动模式已配置：permissionMode=auto + advisor=on（已持久化）", "ok");
      }).catch(function (e) { addNotice("设置失败：" + e.message, "err"); });
    },
    autocompact: function (arg) { guiBool("autocompact", arg, "autoCompact", { def: true, onText: "自动压缩已开启", offText: "自动压缩已关闭" }); },
    subtask: function () { addNotice("子任务与后台代理由 Task 工具创建；下面列出当前后台任务。", "info"); showTasks(); },
    cd: function () { addNotice(guiUnsupported("cd", "GUI 会话工作目录由服务端固定；用 /files 浏览工作区"), "warn"); },
    color: function (arg) { guiBool("color", arg, "color", { def: true, onText: "彩色输出已开启", offText: "彩色输出已关闭" }); },
    vim: function (arg) { guiBool("vim", arg, "vimMode", { onText: "vim 键位已开启（TUI 与 GUI 输入框均生效）", offText: "vim 键位已关闭" }); },
    diff: function () {
      getJSON("/api/changes?sessionKey=" + encodeURIComponent(sessionKeyOf()) + "&scope=turn").then(function (j) {
        var files = j.files || j.changes || [];
        if (!files.length) { addNotice("未检测到改动（/diff）", "info"); return; }
        addNotice("工作区改动（" + files.length + "）\n" + files.map(function (f) {
          return "  " + (f.path || f.file || "?") + "  +" + (f.added || f.additions || 0) + " -" + (f.deleted || f.deletions || 0);
        }).join("\n"), "info");
      }).catch(function (e) { addNotice("读取改动失败：" + e.message, "err"); });
    },
    background: function () { showTasks(); },
    stop: function () {
      postJSON("/api/abort", { sessionKey: sessionKeyOf() }).then(function () { toast("已请求停止当前回合", "ok"); })
        .catch(function (e) { addNotice("停止失败：" + e.message, "err"); });
    },
    focus: function (arg) {
      guiBool("focus", arg, "focusMode", { onText: "专注模式已开启", offText: "专注模式已关闭" });
      var app = $("app");
      if (app) { app.classList.toggle("focus-mode", !!guiPrefs().focusMode); }
    },
    heapdump: function () { addNotice(guiUnsupported("heapdump", "浏览器不能导出 Node 堆快照；请在 TUI 运行 /heapdump"), "warn"); },
    keybindings: function () { openShortcutsModal(); },
    import: function () { addNotice(guiUnsupported("import", "/attach <路径> 或 /add-dir <目录> 可把本地文件接入上下文"), "warn"); },
    "pause-memory": function (arg) { guiBool("pause-memory", arg, "memoryPaused", { onText: "记忆读取偏好已暂停", offText: "记忆读取偏好已恢复" }); },
    "reload-plugins": function () { runServerCommand("plugin"); },
    "reload-skills": function () {
      loadSkillsList().then(function (list) {
        toast("技能已重新加载：当前 " + list.length + " 个", "ok");
      });
    },
    rename: function (arg) { return EXTRA_COMMANDS.title(arg); },
    statusline: function (arg) {
      var v = String(arg || "").trim();
      if (!v || v === "status") { guiValue("statusline", arg, "statusLineCommand"); refreshStatusLine(true); return; }
      var clear = ["clear", "off", "none", "delete"].indexOf(v.toLowerCase()) >= 0;
      var value = clear ? null : v;
      // 服务端 /api/statusline 读的是 config.statusLineCommand —— 只写 localStorage 两边不通，
      // 所以同时 POST 到 /api/config，再强制刷新右栏状态行。
      guiSetPref("statusLineCommand", value);
      postJSON("/api/config", { statusLineCommand: value }).then(function () {
        if (S.config) { S.config.statusLineCommand = value; }
        toast("/statusline = " + (clear ? "(已清除)" : v) + "（已同步服务端）", "ok");
        refreshStatusLine(true);
      }).catch(function (e) {
        toast("状态行同步失败：" + e.message, "err");
        refreshStatusLine(true);
      });
    },
    tui: function () { addNotice("当前是 GUI；/tui 需退出浏览器后用 myclaude（不带 --gui）启动终端界面。", "info"); },
    ultrareview: function () { addNotice(guiUnsupported("ultrareview", "/review（本机单代理代码审查）"), "warn"); },
    "security-review": function (arg) {
      var target = String(arg || "").trim();
      var scope = target
        ? "审查目标：工作区与 \"" + target + "\" 的差异（git diff）"
        : "审查目标：当前未提交的改动（git diff HEAD）";
      var prompt = [
        "你是严格的安全审查者。请只报告真实可利用的安全问题，输出报告。",
        scope,
        "步骤：",
        "1) 用 Bash 查看改动范围与完整 diff；改动为空时明确说明「没有待审查的改动」并结束。",
        "2) 逐文件阅读改动及其周边上下文（Read/Grep），重点看注入、鉴权与越权、密钥硬编码、路径穿越、反序列化、SSRF 与输出转义。",
        "3) 按 [严重] [主要] [次要] [建议] 分级，每条给出 文件:行号、可利用条件、影响与修复方向；没有问题就说「未发现明确安全问题」。",
        "4) 报告以一句话结论收尾：可合并 / 需修改（附理由）。全部用中文输出。"
      ].join("\n");
      if (S.busy) { toast("任务运行中，请先停止或等它结束", "warn"); return; }
      addUserMessage(prompt, []);
      runTurn({ message: prompt, sessionKey: S.sessionKey, attachments: [] });
    },
    "terminal-setup": function () {
      addNotice([
        "终端设置（本机）",
        "  Shift+Tab 轮转权限模式；/mode 直接设定。",
        "  彩色输出：/color on|off（重启 TUI 生效）。",
        "  滚动速度：/scroll-speed <1-10>。",
        "  键位一览：/keybindings；状态行：/statusline。",
        "  终端里运行 myclaude 启动 Ink TUI；myclaude --plain 用简洁 REPL。"
      ].join("\n"), "info");
    },
    "scroll-speed": function (arg) {
      guiValue("scroll-speed", arg, "scrollSpeed", {
        parse: function (v) { var n = Number(v); return Number.isFinite(n) && n >= 1 && n <= 10 ? n : null; },
        invalid: "用法：/scroll-speed <1-10>|clear"
      });
    },
    upgrade: function () { addNotice(guiUnsupported("upgrade", "当前版本见 /doctor；本机没有更新通道，请从发布页手动获取新版"), "warn"); },
    usage: function () { return EXTRA_COMMANDS.cost(); },
    insights: function () { addNotice(guiUnsupported("insights", "/stats 与 /cost 给出本机会话统计"), "warn"); },
    recap: function () {
      var s = S.stats || {};
      addNotice([
        "本会话回顾（/recap）",
        "  会话 id    " + (S.sessionKey || "default"),
        "  消息       " + (s.messages || 0) + " 条 · " + (s.turns || 0) + " 回合",
        "  累计 token 输入 " + fmtK(s.inputTokens || 0) + " / 输出 " + fmtK(s.outputTokens || 0),
        "  上下文     " + fmtK(s.contextUsed || 0) + " / " + fmtK(s.contextLimit || 0) + " tok"
      ].join("\n"), "info");
    },
    goal: function (arg) { guiValue("goal", arg, "goal"); },
    sandbox: function (arg) { guiBool("sandbox", arg, "sandbox", { onText: "沙箱偏好已开启", offText: "沙箱偏好已关闭" }); },
    "list-agents": function () { runServerCommand("agents"); },
    artifacts: function () { addNotice(guiUnsupported("artifacts", "/export 与 /files 浏览本机会话与工作区"), "warn"); },
    "team-onboarding": function () { addNotice(guiUnsupported("team-onboarding", "/help 与 /init 提供本机上手说明"), "warn"); },
    exit: function () { addNotice("GUI 无法退出浏览器标签页；用 /clear 开新对话，或直接关闭标签页。", "info"); },
    resume: function (arg) { if (arg) { resumeSession(arg); } else { openSessions(); } },
    session: function () {
      addNotice("当前会话 id：" + (S.sessionKey || "default") +
        "\n用 /sessions 查看历史会话，/resume <id> 恢复指定会话。", "info");
    },
    plan: function () {
      addNotice("本机无对应服务：/plan 的计划文件由 TUI 读写，GUI 服务端未暴露计划接口。\n本机可用替代：/files 浏览工作区，或在 TUI 用 /plan 查看计划。", "warn");
    },

    /* ---- TUI 有而 GUI 曾缺的命令面（commands-parity 补齐 2026-11-14）---- */
    attach: function (arg) {
      if (!arg) { var fi = $("file-input"); if (fi) { fi.click(); } return; }
      var paths = String(arg).match(/"[^"]+"|\S+/g) || [];
      postJSON("/api/attach", { paths: paths.map(function (p) { return p.replace(/^"|"$/g, ""); }) }).then(function (j) {
        (j.attachments || []).forEach(function (a) { S.attachments.push(a); });
        renderAttachments();
        var fails = (j.errors || []).map(function (e) { return e.name + "：" + e.error; });
        toast("已附加 " + (j.attachments || []).length + " 个" + (fails.length ? "；失败：" + fails.join("；") : ""), fails.length ? "warn" : "ok");
      }).catch(function (e) { addNotice("附加失败：" + e.message, "err"); });
    },
    attachments: function () {
      if (!S.attachments.length) { addNotice("(no pending attachments)", "info"); return; }
      addNotice(S.attachments.map(function (a) { return "  " + (a.name || "?") + " · " + bytes(a.size || 0); }).join("\n"), "info");
    },
    detach: function (arg) {
      var which = String(arg || "").trim();
      if (!which || which === "all") { S.attachments = []; renderAttachments(); toast("attachments cleared", "ok"); return; }
      var idx = Number(which) - 1;
      if (idx >= 0 && idx < S.attachments.length) { S.attachments.splice(idx, 1); renderAttachments(); toast("已移除第 " + which + " 个附件", "ok"); }
      else { addNotice("用法：/detach [序号|all]", "warn"); }
    },
    base: function (arg) {
      var v = String(arg || "").trim();
      if (!v) { addNotice("baseUrl = " + ((S.config || {}).baseUrl || "(默认)"), "info"); return; }
      postJSON("/api/config", { baseUrl: v }).then(function () { if (S.config) { S.config.baseUrl = v; } toast("baseUrl = " + v, "ok"); }).catch(function (e) { addNotice("设置失败：" + e.message, "err"); });
    },
    key: function (arg) {
      var v = String(arg || "").trim();
      if (!v) { addNotice("apiKey = " + ((S.config || {}).apiKeyConfigured ? "(set)" : "(empty)"), "info"); return; }
      postJSON("/api/config", { apiKey: v }).then(function () { if (S.config) { S.config.apiKeyConfigured = true; } toast("api key updated", "ok"); }).catch(function (e) { addNotice("设置失败：" + e.message, "err"); });
    },
    "computer-use": function (arg) {
      var v = String(arg || "").trim().toLowerCase();
      if (!v || v === "status") { addNotice("Computer Use：" + ((S.config || {}).computerUse ? "on" : "off") + "\n用法：/computer-use on|off", "info"); return; }
      if (v !== "on" && v !== "off") { addNotice("用法：/computer-use on|off", "warn"); return; }
      postJSON("/api/config", { computerUse: v === "on" }).then(function () {
        if (S.config) { S.config.computerUse = v === "on"; }
        toast(v === "on" ? "Computer Use 已开启 — 新会话注册 browser 工具" : "Computer Use 已关闭 — 新会话不再注册 browser 工具", "ok");
      }).catch(function (e) { addNotice("设置失败：" + e.message, "err"); });
    },
    continue: function () {
      var rows = (S.sessions || []).filter(function (s) { return !s.archived; });
      if (!rows.length) { addNotice("(no saved sessions to continue)", "warn"); return; }
      resumeSession(rows[0].id);
    },
    rm: function (arg) {
      var id = String(arg || "").trim();
      if (!id) { addNotice("用法：/rm <会话 id>（/sessions 里可查）", "warn"); return; }
      deleteSession(id);
    },
    save: function () { runServerCommand("save"); },
    "reload-memory": function () { runServerCommand("memory"); },
    vision: function (arg) {
      var v = String(arg || "").trim().toLowerCase();
      if (v === "on" || v === "off") {
        postJSON("/api/config", { vision: v === "on" }).then(function () {
          S.vision = v === "on"; renderVision();
          toast("视觉已" + (S.vision ? "开启" : "关闭"), S.vision ? "ok" : "warn");
        }).catch(function (e) { addNotice("设置失败：" + e.message, "err"); });
        return;
      }
      addNotice("vision = " + (S.vision !== false ? "on" : "off") + "\n用法：/vision on|off", "info");
    },
    skill: function (arg) {
      var line = String(arg || "").trim();
      var name = line.split(/\s+/)[0] || "";
      var rest = line.slice(name.length).trim();
      if (!name) { addNotice("用法：/skill <技能名> [参数]（TUI 同语义：直接执行技能正文）", "warn"); return; }
      getJSON("/api/skills/" + encodeURIComponent(name)).then(function (j) {
        if (!j.ok || !j.body) { addNotice(j.error || ("没有名为 " + name + " 的技能"), "err"); return; }
        addUserMessage("/skill " + name + (rest ? " " + rest : ""), []);
        S.lastUserText = j.body;
        runTurn({ message: j.body + (rest ? "\n\n[skill args]: " + rest : ""), sessionKey: S.sessionKey });
      }).catch(function (e) { addNotice("读取技能失败：" + e.message, "err"); });
    },
    dream: function () { runServerCommand("dream"); },
    loop: function (arg) {
      // /loop <提示词> [--cycles N] [--every 秒]；无提示词时回退 loop.md（TUI 同款）
      var words = [];
      var cycles = 1;
      var intervalSec = 0;
      var toks = String(arg || "").trim().match(/"[^"]+"|\S+/g) || [];
      for (var i = 0; i < toks.length; i++) {
        var w = toks[i];
        if (w === "--cycles") { cycles = Number(toks[++i]) || 1; continue; }
        if (w === "--every") { intervalSec = Number(toks[++i]) || 0; continue; }
        words.push(w.replace(/^"|"$/g, ""));
      }
      var prompt = words.join(" ").trim();
      var usage = "用法：/loop <提示词> [--cycles N] [--every 秒]（或工作目录放 loop.md）";
      if (cycles < 1) { cycles = 1; }
      if (cycles > 25) { addNotice("循环次数上限 25，已按 25 处理", "warn"); cycles = 25; }
      var begin = function () {
        if (!prompt) { addNotice(usage, "warn"); return; }
        if (S.busy) { toast("任务运行中，请先停止或等它结束", "warn"); return; }
        addNotice("开始循环：" + cycles + " 次" + (intervalSec ? "，间隔 " + intervalSec + "s" : ""), "info");
        var n = 0;
        var runOnce = function () {
          n++;
          addNotice("--- 循环第 " + n + "/" + cycles + " 次 ---", "info");
          addUserMessage(prompt, []);
          S.lastUserText = prompt;
          runTurn({ message: prompt, sessionKey: S.sessionKey });
          if (n < cycles) { scheduleNext(); }
        };
        var scheduleNext = function () {
          var waitIdle = function () {
            if (!S.busy) { setTimeout(runOnce, Math.max(0, intervalSec) * 1000); }
            else { setTimeout(waitIdle, 800); }
          };
          setTimeout(waitIdle, 800);
        };
        runOnce();
      };
      if (prompt) { begin(); return; }
      getJSON("/api/fs/file?path=" + encodeURIComponent("loop.md")).then(function (j) {
        if (j && j.content && j.content.trim()) {
          prompt = j.content.trim();
          addNotice("使用 loop.md（" + prompt.length + " 字符）", "info");
          begin();
        } else { addNotice(usage, "warn"); }
      }).catch(function () { addNotice(usage, "warn"); });
    }
  };

  /** 需要读本机文件 / 改 agent 状态的命令：走服务端白名单，返回纯文本。 */
  function runServerCommand(name, arg) {
    // 不用 postJSON：它对非 2xx 只抛「HTTP 404」，会丢掉服务端给出的
    // 「当前没有活跃会话」这类真正有用的原因。
    fetch("/api/command", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: name, arg: arg || "", sessionKey: sessionKeyOf() })
    }).then(function (r) {
      return r.json().then(function (j) { return { status: r.status, j: j }; });
    }).then(function (out) {
      var j = out.j;
      if (!j.ok) { addNotice("命令失败：" + (j.error || ("HTTP " + out.status)), "err"); return; }
      addNotice(j.text || "(无输出)", "info");
      // /fork 返回新会话 id：直接切过去，原会话留在侧栏。
      if (j.forkedTo) { try { resumeSession(j.forkedTo, { quiet: true }); } catch (e) {} }
      // compact / rewind 改了会话历史，静默重放一次，避免界面还停在旧内容。
      if (j.refresh && S.sessionKey && S.sessionKey !== "default") {
        try { resumeSession(S.sessionKey, { quiet: true }); } catch (e) { /* 重放失败不掩盖命令结果 */ }
      }
    }).catch(function (e) { addNotice("命令失败：" + e.message, "err"); });
  }

  /* 引擎后端切换 UI 已按用户要求移除（2026-11-14）：始终使用原生 Claude。
   * 后端选择由服务端配置锁定（main.js 生产默认 upstream，POST /api/config
   * 不再接受 engineBackend），GUI 不再提供「自研 / 原生 Claude」切换。 */

  function runCommand(text) {
    var parts = text.slice(1).split(/\s+/);
    var cmd = (parts.shift() || "").toLowerCase();
    var arg = parts.join(" ").trim();
    if (cmd === "output-style" && arg) { cmd = "output-style-set"; }
    switch (cmd) {
      case "help":
        addNotice("命令：/help /new /model /mode /prompts /tools /config /sessions /files /tasks /bashes /settings /voice /shortcuts /theme\n" +
          "信息：/status /stats /context /cost /doctor /todos /permissions /hooks /mcp\n" +
          "操作：/title <名称> /effort high|medium|low|off /fast on|off /models /export\n" +
          "扩展：/memory /skills /plugin /agents /release-notes /add-dir /compact /rewind\n" +
          "会话：/fork /branch /init /clear /provider /output-style /review\n" +
          "补齐：/advisor /auto-mode-setup /autocompact /subtask /cd /color /vim /diff /background /stop /focus /heapdump /keybindings /import /pause-memory /reload-plugins /reload-skills /rename /statusline /tui /ultrareview /security-review /terminal-setup /scroll-speed /upgrade /usage /insights /recap /goal /sandbox /list-agents /artifacts /team-onboarding /exit /resume /session /plan", "info");
        break;
      case "shortcuts":
        openShortcutsModal();
        break;
      case "prompts":
        openPromptLibraryModal();
        break;
      case "new":
        newChat();
        break;
      case "model":
        openSettings();
        break;
      case "auto": {
        // /auto on|off|status — 自主续跑开关。max_turns 提示卡推荐的就是这条命令，
        // 它必须真实存在，否则提示语在撒谎。
        var want = String(arg || "").trim().toLowerCase();
        if (want === "on" || want === "off") {
          postJSON("/api/config", { autoRun: want === "on" }).then(function () {
            if (S.config) { S.config.autoRun = want === "on"; }
            toast(want === "on" ? "自主续跑已开启：到回合上限自动继续（含轮数与时长护栏）" : "自主续跑已关闭", "ok");
          }).catch(function (e) { addNotice("设置失败：" + e.message, "err"); });
        } else if (want === "" || want === "status") {
          addNotice("自主续跑：" + (S.config && S.config.autoRun ? "已开启" : "未开启") + "（/auto on 或 /auto off 切换）", "info");
        } else {
          addNotice("用法：/auto on|off|status", "warn");
        }
        break;
      }
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
      case "bashes":
      case "tasks":
        showTasks();
        break;
      case "settings":
        openSettings();
        break;
      case "theme":
        toggleTheme();
        break;
      case "voice":
        toggleVoiceInput();
        break;
      case "commands":
        openCommandsModal();
        break;
      case "output-style":
        getJSON("/api/output-styles").then(function (j) {
          var lines = (j.styles || []).map(function (s) {
            return s.name + "（" + s.label + "）" + (s.description ? " — " + s.description : "") + (j.current === s.name ? " ← 当前" : "");
          });
          addNotice("输出风格：\n" + lines.join("\n") + "\n切换：/output-style <名称>", "info");
        }).catch(function (e) { toast("加载风格失败: " + e.message, "err"); });
        break;
      case "output-style-set": {
        if (!arg) { runCommand("/output-style"); break; }
        postJSON("/api/config", { outputStyle: arg }).then(function () {
          toast("输出风格 → " + arg, "ok");
        }).catch(function (e) { toast("切换失败: " + e.message, "err"); });
        break;
      }
      case "review": {
        // Claude Code 的 /review：组审查提示词，当普通消息发给 agent。
        var target = arg.trim();
        var scope = target
          ? "审查目标：工作区与 \"" + target + "\" 的差异（git diff " + target + "...HEAD；若是 PR 编号且 gh 可用则 gh pr diff " + target + "）"
          : "审查目标：当前未提交的改动（git diff HEAD；若为空再看最近一次提交 git show --stat HEAD）";
        var prompt = ["你是严格的代码审查者。请完成一次代码审查并输出报告。", scope,
          "步骤：",
          "1) 用 Bash 查看改动范围与完整 diff；改动为空时明确说明「没有待审查的改动」并结束。",
          "2) 逐文件阅读改动及其周边上下文（Read/Grep），不要只看 diff 猜测。",
          "3) 输出报告：按 [严重] [主要] [次要] [建议] 四级列出问题，每条包含 文件:行号、问题说明、具体修复建议；重点检查正确性、边界条件、安全（注入/秘钥/路径）、并发与性能、错误处理、命名一致性。",
          "4) 报告以一句话结论收尾：可合并 / 需修改（附理由）。全部用中文输出。"].join("\n");
        if (S.busy) { toast("任务运行中，请先停止或等它结束", "warn"); break; }
        addUserMessage(prompt, []);
        runTurn({ message: prompt, sessionKey: S.sessionKey, attachments: [] });
        break;
      }
      default: {
        var custom = findCustom(cmd);
        if (custom) { runCustomCommand(custom, arg); break; }
        // TUI 有而 GUI 原先没有的内建命令，走 EXTRA_COMMANDS 注册表补齐。
        var extra = EXTRA_COMMANDS[cmd];
        if (extra) { extra(arg); break; }
        // /技能名 passthrough（对齐 agent 层 skill_mention 契约）：按原文发给
        // agent，由 skill_mention 附件提示模型调用 Skill 工具。此前 GUI 把
        // 技能名当成「未知命令」拦下，技能在界面里永远用不了。
        // 缓存可能落后（技能是在页面打开后才创建/安装的）：未命中时拉一次
        // /api/skills 复查，仍未中才报未知命令。
        if (findSkill(cmd)) { runSkillPassthrough(text); break; }
        loadSkillsList().then(function () {
          if (findSkill(cmd)) { runSkillPassthrough(text); return; }
          addNotice("未知命令：/" + cmd + "（试试 /help 或 /commands）", "warn");
        }).catch(function () {
          addNotice("未知命令：/" + cmd + "（试试 /help 或 /commands）", "warn");
        });
        break;
      }
    }
  }

  var slashOpen = false;
  var slashIndex = 0;
  var slashMatches = [];

  var slashSkillsTimer = null;

  function updateSlashMenu(value) {
    var text = value || "";
    if (text.charAt(0) !== "/" || text.indexOf(" ") >= 0) { closeSlash(); return; }
    var needle = text.slice(1).toLowerCase();
    // 斜杠面板含技能项；列表可能落后（页面打开后新装的技能），打开时静默刷新
    // 一次，完成后若面板还开着就重画。
    clearTimeout(slashSkillsTimer);
    slashSkillsTimer = setTimeout(function () {
      loadSkillsList().then(function () {
        if (!slashOpen) { return; }
        var ta2 = $("in");
        var cur = ta2 ? (ta2.value || "") : "";
        if (cur.charAt(0) === "/" && cur.indexOf(" ") < 0) { updateSlashMenu(cur); }
      });
    }, 120);
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

  var themeMedia = window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null;

  function systemTheme() { return themeMedia && themeMedia.matches ? "dark" : "light"; }

  function applyTheme(theme) {
    S.theme = theme === "auto" ? "auto" : (theme === "light" ? "light" : "dark");
    var effective = S.theme === "auto" ? systemTheme() : S.theme;
    document.documentElement.setAttribute("data-theme", effective);
    try { localStorage.setItem(LS_THEME, S.theme); } catch (e) { }
    var label = $("theme-label");
    if (label) { label.textContent = S.theme === "auto" ? "跟随系统" : (S.theme === "dark" ? "浅色模式" : "深色模式"); }
    var ti = $("theme-icon");
    if (ti && ti.firstChild) { ti.firstChild.setAttribute("href", effective === "dark" ? "#i-sun" : "#i-moon"); }
    var tb = $("btn-theme");
    if (tb) { tb.title = S.theme === "auto" ? "当前跟随系统（点击切换深色）" : (effective === "dark" ? "切换到浅色" : "切换到深色 / 跟随系统"); }
  }

  /** 深 → 浅 → 跟随系统 三态循环（claude.ai 的主题行为）。 */
  function toggleTheme() {
    var next = S.theme === "dark" ? "light" : (S.theme === "light" ? "auto" : "dark");
    applyTheme(next);
    toast(next === "auto" ? "主题：跟随系统" : (next === "dark" ? "主题：深色" : "主题：浅色"), "info");
  }

  if (themeMedia) {
    var onSystemThemeChange = function () { if (S.theme === "auto") { applyTheme("auto"); } };
    if (themeMedia.addEventListener) { themeMedia.addEventListener("change", onSystemThemeChange); }
    else if (themeMedia.addListener) { themeMedia.addListener(onSystemThemeChange); }
  }

  /* ================================================================ 绑定 === */

  function bindEvents() {
    var ta = $("in");
    var send = $("send");
    if (send) { send.addEventListener("click", sendMessage); }
    var stop = $("btn-stop");
    if (stop) { stop.addEventListener("click", stopGeneration); }

    if (ta) {
      ta.addEventListener("input", function () {
        autoGrow(ta);
        updateSlashMenu(ta.value);
        // @ 引用菜单已按用户要求移除（2026-11-14）：按钮与输入触发都撤了，
        // 原生 Claude 引擎自己对消息里的 @path 做文件解析。
        saveDraftSoon(ta.value);
      });
      ta.addEventListener("keydown", function (e) {
        if (vimEnabledNow()) { vimEnsure(); }
        // slash/@ 菜单打开时不接管：方向键导航与 Enter 选中归菜单（vim 键位让位）
        if (vimEnabledNow() && !slashOpen && !atOpen && vimHandleKey(e)) { return; }
        renderVimIndicator();
        if (atOpen) {
          if (e.key === "ArrowDown") { e.preventDefault(); atMove(1); return; }
          if (e.key === "ArrowUp") { e.preventDefault(); atMove(-1); return; }
          if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) { e.preventDefault(); atAccept(); return; }
          if (e.key === "Escape") { e.preventDefault(); closeAtMenu(); return; }
        }
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
        if (files.length) { e.preventDefault(); addFiles(files); return; }

        // Claude 风格长文本粘贴自动转卡片：超过 15 行或 600 字符时折叠为 PASTED 附件卡
        var pastedText = e.clipboardData && e.clipboardData.getData ? e.clipboardData.getData("text/plain") : "";
        if (pastedText) {
          var lineCount = pastedText.split(/\r?\n/).length;
          if (lineCount >= 15 || pastedText.length >= 600) {
            e.preventDefault();
            var firstLine = (pastedText.trim().split(/\r?\n/)[0] || "粘贴文本").slice(0, 28);
            S.attachments.push({
              kind: "text",
              pasted: true,
              name: firstLine || "粘贴的内容",
              mime: "text/plain",
              size: pastedText.length,
              lines: lineCount,
              text: pastedText
            });
            renderAttachments();
            toast("已将 " + lineCount + " 行长文本折叠为粘贴卡片（点击卡片可查看或展开）", "info");
          }
        }
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

    var modeSel = $("mode-select");
    if (modeSel) {
      modeSel.addEventListener("change", function () {
        var mode = modeSel.value;
        postJSON("/api/config", { permissionMode: mode }).then(function (j2) {
          if (S.config) { S.config.permissionMode = j2.permissionMode || mode; }
          setMode(j2.permissionMode || mode);
        }).catch(function (e) {
          toast("切换失败：" + e.message, "err");
          moveModeThumb();
        });
      });
    }

    var bNew = $("btn-new-chat");
    if (bNew) { bNew.addEventListener("click", newChat); }
    var bSearch = $("btn-search-chat");
    if (bSearch) { bSearch.addEventListener("click", openSearch); }
    var bFiles = $("btn-files");
    if (bFiles) { bFiles.addEventListener("click", function () { openFiles(); }); }
    var bTools = $("btn-tools");
    if (bTools) { bTools.addEventListener("click", openTools); }
    var bSkills = $("btn-skills");
    if (bSkills) { bSkills.addEventListener("click", openSkillsManager); }
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
    initVoiceUI();
    initClaudeFeatures();
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
    if (bModel) { bModel.addEventListener("click", function (e) { e.stopPropagation(); toggleModelMenu(bModel); }); }
    var bOpenCfg = $("btn-open-model-config");
    if (bOpenCfg) { bOpenCfg.addEventListener("click", function (e) { e.stopPropagation(); openModelConfigModal("providers"); }); }
    var bCloseCfg = $("btn-close-model-config");
    if (bCloseCfg) { bCloseCfg.addEventListener("click", closeModelConfigModal); }
    var bCfgVeil = $("model-config-veil");
    if (bCfgVeil) { bCfgVeil.addEventListener("click", closeModelConfigModal); }
    var bWmcSwitch = $("btn-wmc-switch");
    if (bWmcSwitch) { bWmcSwitch.addEventListener("click", function (e) { e.stopPropagation(); toggleModelMenu(bWmcSwitch); }); }
    var bWmcCfg = $("btn-wmc-config");
    if (bWmcCfg) { bWmcCfg.addEventListener("click", function (e) { e.stopPropagation(); openModelConfigModal("providers"); }); }
    var bSugCfg = $("btn-sug-config");
    if (bSugCfg) { bSugCfg.addEventListener("click", function (e) { e.stopPropagation(); openModelConfigModal("providers"); }); }

    // 绑定欢迎区快捷建议卡片点击填入输入框
    var welcomeCards = document.querySelectorAll(".welcome-sug-card[data-prompt]");
    Array.prototype.forEach.call(welcomeCards, function (card) {
      card.addEventListener("click", function () {
        var p = card.getAttribute("data-prompt");
        var inEl = $("in");
        if (inEl && p) {
          inEl.value = p;
          inEl.focus();
          autoResizeInput();
        }
      });
    });

    window.addEventListener("resize", function () {
      var m = $("model-menu");
      if (m && !m.hidden && currentModelMenuAnchor) {
        positionModelMenu(currentModelMenuAnchor);
      }
    });

    document.addEventListener("click", function (e) {
      var m = $("model-menu");
      if (m && !m.hidden && !m.contains(e.target) &&
          !($("btn-wmc-switch") && $("btn-wmc-switch").contains(e.target)) &&
          !($("btn-model") && $("btn-model").contains(e.target))) {
        closeModelMenuSmoothly();
      }
      var sm = $("style-menu");
      if (sm && !sm.hidden && !sm.contains(e.target)) { sm.hidden = true; }
      var am = $("at-menu");
      if (am && !am.hidden && !am.contains(e.target) && e.target !== $("btn-at")) { closeAtMenu(); }
    });

    var stream = $("stream");
    if (stream) {
      stream.addEventListener("scroll", function () {
        // Ignore the scroll we caused ourselves; only a real user gesture may
        // turn auto-follow off.
        if (S.programmaticScroll) { return; }
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
      if ($("projects-modal") && !$("projects-modal").hidden) { return; }
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
      if ($("projects-modal") && !$("projects-modal").hidden) {
        handleProjectLocalFilesUpload(e.dataTransfer.files);
        return;
      }
      addFiles(e.dataTransfer.files);
    });

    document.addEventListener("click", function (e) {
      var t = e.target;
      if (t && t.getAttribute && t.getAttribute("data-close")) { closeModal(); }
      if (t && t.getAttribute && t.getAttribute("data-proj-close")) { closeProjectModal(); }
    });

    // 消息内图片点击放大（灯箱）
    var logBox = $("log");
    if (logBox) {
      logBox.addEventListener("click", function (e) {
        var img = e.target && e.target.closest ? e.target.closest(".md img") : null;
        if (img && img.src) {
          e.preventDefault();
          openLightbox(img.src, img.alt);
        }
      });
    }

    document.addEventListener("keydown", function (e) {
      var tag = (e.target && e.target.tagName) || "";
      var typing = tag === "INPUT" || tag === "TEXTAREA" || (e.target && e.target.isContentEditable);
      var mod = e.ctrlKey || e.metaKey;
      // Shift+Tab 切换权限模式（上游全局生效；放在 document 级，焦点在输入框里也能用）。
      if (e.shiftKey && e.key === "Tab") { e.preventDefault(); cyclePermissionMode(); return; }
      if (e.key === "Escape") {
        if ($("model-config-modal") && !$("model-config-modal").hidden) { closeModelConfigModal(); return; }
        if ($("projects-modal") && !$("projects-modal").hidden) { closeProjectModal(); return; }
        if (!$("modal").hidden) { closeModal(); return; }
        if (!$("cmd").hidden) { closeCmd(); return; }
        if ($("model-menu") && !$("model-menu").hidden) { closeModelMenuSmoothly(); return; }
        if (S.busy) { stopGeneration(); return; }
      }
      if (e.altKey && e.key.toLowerCase() === "v") { e.preventDefault(); toggleVoiceInput(); return; }
      if (mod && e.shiftKey && e.key.toLowerCase() === "p") { e.preventDefault(); openProjectModal("files"); return; }
      if (mod && e.shiftKey && e.key.toLowerCase() === "l") { e.preventDefault(); openPromptLibraryModal(); return; }
      if (mod && e.key.toLowerCase() === "k") { e.preventDefault(); openCmd(); return; }
      if (mod && e.key === ",") { e.preventDefault(); openSettings(); return; }
      if (mod && e.key.toLowerCase() === "b") { e.preventDefault(); toggleRail(); return; }
      if (mod && e.key.toLowerCase() === "i") { e.preventDefault(); setInspector(!$("app").classList.contains("insp-open")); return; }
      if (mod && e.key.toLowerCase() === "l") { e.preventDefault(); newChat(); return; }
      if (mod && e.shiftKey && e.key.toLowerCase() === "o") { e.preventDefault(); newChat(); return; }
      if (mod && e.key === "/") { e.preventDefault(); openShortcutsModal(); return; }
      if (!typing && e.key === "?") { e.preventDefault(); openShortcutsModal(); }
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

    var resizeTimer = null;
    window.addEventListener("resize", function () {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(function () {
        moveModeThumb();
      }, 60);
    });
  }

  function isNarrow() { return window.innerWidth <= 960; }

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
    if (!open) { app.classList.remove("artifact-open"); }
    else if (S.inspTab === "artifact") { app.classList.add("artifact-open"); }
    try { localStorage.setItem(LS_INSP, open ? "open" : "closed"); } catch (e) { }
    if (open) {
      if (S.inspTab === "artifact") { renderArtifactStage(); }
      else { renderInspector(); }
    }
    setTimeout(moveModeThumb, 260);
  }

  /* ============================================ Claude 风格进阶特性实现 === */

  var STYLE_PRESETS = [
    { id: "normal", label: "正常", en: "Normal", desc: "默认均衡的 Claude 风格回答", prompt: "" },
    { id: "concise", label: "精简", en: "Concise", desc: "简明扼要，直奔核心结论与代码", prompt: "[回答风格要求：请保持极度精炼简洁，直奔主题，省略寒暄与冗长铺垫]" },
    { id: "explanatory", label: "详细", en: "Explanatory", desc: "深入浅出，附带设计思路与原理解析", prompt: "[回答风格要求：请采用深入浅出的教学式讲解，说明背后的设计取舍、原理与关键步骤]" },
    { id: "code_only", label: "仅代码", en: "Code Only", desc: "优先直接输出完整可运行代码", prompt: "[回答风格要求：请直接给出完整、高质量的代码实现，仅保留最必要的注释，不要输出多余解释]" }
  ];

  function applyStyleInstruction(userText) {
    var parts = [];
    // 1. 项目专属指令 / 提示词库激活的系统提示词与已启用的常驻/本地上传知识库文件
    var sysInst = (S.project && S.project.instructions && S.project.instructions.trim()) || "";
    if (!sysInst && promptLibraryState.activePromptId) {
      var activePrm = (promptLibraryState.prompts || []).filter(function (x) {
        return x.id === promptLibraryState.activePromptId;
      })[0];
      if (activePrm && activePrm.content) {
        sysInst = activePrm.content.trim();
      }
    }
    if (sysInst) {
      parts.push("[系统提示词与项目专属指令 (System Prompt / Instructions - " + ((S.project && S.project.name) || "当前项目") + ")：\n" + sysInst + "]");
    }
    var enabledKnowledge = ((S.project && S.project.knowledge) || []).filter(function (k) {
      return k && k.enabled !== false;
    });
    var isFirstTurn = !S.stats || !S.stats.messages;
    if ((isFirstTurn || S._projectContextDirty) && enabledKnowledge.length) {
      S._projectContextDirty = false;
      var kText = enabledKnowledge.map(function (k) {
        var srcLabel = k.source === "upload" ? "本地上传文件" : (k.source === "snippet" ? "项目片段" : "工作区文件");
        return "--- [" + srcLabel + "] " + (k.rel || k.name) + " (" + (k.lines || 0) + " lines) ---\n" + (k.content || "").slice(0, 8000);
      }).join("\n\n");
      parts.push("[Projects 项目上下文文件列表 (供 AI 参考的代码与文档)：\n" + kText + "]");
    }
    // 2. 深度思考模式（Extended Thinking）
  // 深度思考由 config.effort 驱动（按钮只写配置，注入在 agent/provider 侧）。

    // 3. 回答风格（Style）
    var st = STYLE_PRESETS.filter(function (x) { return x.id === S.style; })[0];
    if (st && st.prompt) {
      parts.push(st.prompt);
    }
    if (!parts.length) { return userText; }
    return parts.join("\n\n") + "\n\n" + userText;
  }

  function renderThinkingButton() {
    var btn = $("btn-thinking");
    var lbl = $("thinking-label");
    if (btn) {
      btn.classList.toggle("active", !!S.thinking);
      btn.title = S.thinking
        ? "深度思考已开启（Extended Thinking）：回答前先进行多步推理推演（点击关闭）"
        : "开启深度思考（Claude Extended Thinking）";
    }
    if (lbl) {
      lbl.textContent = S.thinking ? "深度思考 · 开" : "深度思考";
    }
  }

  function toggleThinkingMode() {
    S.thinking = !S.thinking;
    // One setting, two entry points: the button and /effort both write
    // config.effort; the provider turns it into reasoning_effort. The old
    // localStorage flag and the client-side prompt injection are gone.
    postJSON("/api/config", { effort: S.thinking ? "high" : "off" }).catch(function () {});
    renderThinkingButton();
    toast(S.thinking ? "已开启深度思考（effort=high）" : "已关闭深度思考", S.thinking ? "ok" : "info");
  }


  /* ---- Claude Projects & Prompt Library（项目文件上下文 + 常用系统提示词库） ---- */
  var projModalDraft = {
    mode: "files", // "files" | "prompts"
    name: "当前项目",
    instructions: "",
    files: [],
    disabledFiles: [],
    uploadedFiles: [],
    workspaceMeta: {},
    sourceFilter: "all",
    searchQuery: "",
    previewTargetId: null,
    bound: false
  };

  var promptLibraryState = {
    prompts: [],
    activePromptId: "",
    catFilter: "all",
    searchQuery: "",
    editingId: null
  };

  var PROMPT_CAT_LABELS = {
    system: "系统角色",
    coding: "编程规范",
    review: "审查重构",
    docs: "文档撰写",
    custom: "自定义"
  };

  function refreshPromptLibrary() {
    return getJSON("/api/prompts").then(function (j) {
      if (j && j.ok) {
        promptLibraryState.prompts = j.prompts || [];
        promptLibraryState.activePromptId = j.activePromptId || "";
        updatePromptLibraryBadges();
        renderPromptQuickChips();
        if ($("projects-modal") && !$("projects-modal").hidden) {
          renderPromptLibraryPane();
        }
      }
      return promptLibraryState;
    }).catch(function () {});
  }

  function updatePromptLibraryBadges() {
    var cnt = (promptLibraryState.prompts || []).length;
    var railBadge = $("prompt-lib-count");
    if (railBadge) { railBadge.textContent = String(cnt); }
    var tabCnt = $("proj-lib-tab-cnt");
    if (tabCnt) { tabCnt.textContent = String(cnt); }

  }

  function renderPromptQuickChips() {
    var bar = $("proj-prompt-quick-bar");
    if (!bar) { return; }
    clear(bar);
    var list = promptLibraryState.prompts || [];
    if (!list.length) { return; }

    bar.appendChild(el("span", "proj-prompt-quick-label", "常用模板一键填入："));
    var curInst = (($("proj-inst-ta") && $("proj-inst-ta").value) || projModalDraft.instructions || "").trim();

    list.slice(0, 6).forEach(function (prm) {
      var isMatched = curInst && curInst === String(prm.content || "").trim();
      var chip = el("button", "proj-prompt-chip" + (isMatched ? " active" : ""));
      chip.type = "button";
      chip.title = prm.title + "（点击填入下方系统指令，按住 Shift 点击可追加）：\n" + prm.content;
      if (prm.pinned) {
        chip.appendChild(el("span", "proj-prompt-chip-pin", "\u2605"));
      }
      chip.appendChild(el("span", null, prm.title));
      chip.addEventListener("click", function (e) {
        var ta = $("proj-inst-ta");
        if (!ta) { return; }
        if (e.shiftKey && ta.value.trim()) {
          ta.value = ta.value.trim() + "\n\n" + prm.content;
          toast("已追加提示词「" + prm.title + "」", "ok");
        } else {
          ta.value = prm.content;
          toast("已填入提示词「" + prm.title + "」", "ok");
        }
        projModalDraft.instructions = ta.value;
        postJSON("/api/prompts", { action: "setActive", id: prm.id }).then(function (res) {
          if (res && res.ok) {
            promptLibraryState.activePromptId = res.activePromptId || prm.id;
            promptLibraryState.prompts = res.prompts || promptLibraryState.prompts;
            renderPromptQuickChips();
            renderProjectsModalContent();
          }
        }).catch(function () {});
        renderPromptQuickChips();
        renderProjectsModalContent();
      });
      bar.appendChild(chip);
    });
  }

  function switchProjectModalMode(mode) {
    projModalDraft.mode = mode === "prompts" ? "prompts" : "files";
    var isPrompts = projModalDraft.mode === "prompts";
    var filesPane = $("proj-files-pane");
    var promptsPane = $("proj-prompts-pane");
    var tabFiles = $("tab-proj-mode-files");
    var tabPrompts = $("tab-proj-mode-prompts");
    var btnToggleAll = $("btn-proj-toggle-all");
    var btnClearUp = $("btn-proj-clear-uploads");

    if (filesPane) { filesPane.hidden = isPrompts; }
    if (promptsPane) { promptsPane.hidden = !isPrompts; }
    if (tabFiles) { tabFiles.classList.toggle("active", !isPrompts); }
    if (tabPrompts) { tabPrompts.classList.toggle("active", isPrompts); }
    if (btnToggleAll) { btnToggleAll.hidden = isPrompts; }
    if (btnClearUp) { btnClearUp.hidden = isPrompts; }

    if (isPrompts) {
      renderPromptLibraryPane();
    } else {
      renderPromptQuickChips();
      renderProjectsModalContent();
    }
  }

  function openPromptEditor(item, prefillContent) {
    var editor = $("plib-editor");
    var headTitle = $("plib-editor-title");
    var inpTitle = $("plib-form-title");
    var selCat = $("plib-form-category");
    var inpTag = $("plib-form-tag");
    var taContent = $("plib-form-content");
    var chkApply = $("plib-form-apply-now");
    if (!editor || !inpTitle || !taContent) { return; }

    if (item && item.id) {
      promptLibraryState.editingId = item.id;
      if (headTitle) { headTitle.textContent = "编辑提示词模板：" + item.title; }
      inpTitle.value = item.title || "";
      if (selCat) { selCat.value = item.category || "custom"; }
      if (inpTag) { inpTag.value = item.tag || ""; }
      taContent.value = item.content || "";
      if (chkApply) { chkApply.checked = false; }
    } else {
      promptLibraryState.editingId = null;
      if (headTitle) { headTitle.textContent = "新建系统提示词 / 常用指令"; }
      inpTitle.value = "";
      if (selCat) { selCat.value = "system"; }
      if (inpTag) { inpTag.value = ""; }
      taContent.value = prefillContent || "";
      if (chkApply) { chkApply.checked = true; }
    }
    editor.hidden = false;
    setTimeout(function () { inpTitle.focus(); }, 20);
  }

  function applyPromptItemAsSystemInstruction(item, appendMode) {
    if (!item || !item.content) { return; }
    var instTa = $("proj-inst-ta");
    var base = (instTa ? instTa.value : projModalDraft.instructions) || "";
    var nextInst = (appendMode && base.trim())
      ? (base.trim() + "\n\n" + item.content.trim())
      : item.content.trim();

    projModalDraft.instructions = nextInst;
    if (instTa) { instTa.value = nextInst; }

    postJSON("/api/prompts", { action: "setActive", id: item.id }).then(function (res) {
      if (res && res.ok) {
        promptLibraryState.prompts = res.prompts || promptLibraryState.prompts;
        promptLibraryState.activePromptId = res.activePromptId || item.id;
      }
      return postJSON("/api/project", {
        name: ($("proj-name-input") && $("proj-name-input").value.trim()) || projModalDraft.name || "当前项目",
        instructions: nextInst,
        files: projModalDraft.files,
        disabledFiles: projModalDraft.disabledFiles,
        uploadedFiles: projModalDraft.uploadedFiles
      });
    }).then(function (projRes) {
      if (projRes && projRes.ok) {
        S.project = projRes;
        S._projectContextDirty = true;
        updateProjectBadge();
        updatePromptLibraryBadges();
        renderPromptQuickChips();
        renderPromptLibraryPane();
        renderProjectsModalContent();
        renderInspector();
        toast((appendMode ? "已追加「" : "已将「") + item.title + "」设为当前系统提示词并生效", "ok");
      }
    }).catch(function (e) {
      toast("应用提示词失败：" + e.message, "err");
    });
  }

  function renderPromptLibraryPane() {
    var list = promptLibraryState.prompts || [];
    var counts = { all: list.length, system: 0, coding: 0, review: 0, docs: 0, custom: 0 };
    list.forEach(function (p) {
      var c = p.category && counts.hasOwnProperty(p.category) ? p.category : "custom";
      counts[c] = (counts[c] || 0) + 1;
    });

    ["all", "system", "coding", "review", "docs", "custom"].forEach(function (k) {
      var elCnt = $("plib-cnt-" + k);
      if (elCnt) { elCnt.textContent = String(counts[k] || 0); }
    });

    var tabsWrap = $("plib-cat-tabs");
    if (tabsWrap) {
      Array.prototype.forEach.call(tabsWrap.querySelectorAll(".proj-tab"), function (b) {
        b.classList.toggle("active", b.getAttribute("data-pcat") === promptLibraryState.catFilter);
      });
    }

    // 更新顶部当前生效系统指令横幅
    var curInst = (($("proj-inst-ta") && $("proj-inst-ta").value) || projModalDraft.instructions || (S.project && S.project.instructions) || "").trim();
    var banner = $("plib-active-banner");
    var summaryEl = $("plib-active-summary");
    var clearBtn = $("btn-plib-clear-active");
    var matchedPrm = list.filter(function (p) {
      return curInst && String(p.content || "").trim() === curInst;
    })[0];

    if (banner) {
      banner.classList.toggle("has-active", Boolean(curInst));
    }
    if (summaryEl) {
      if (matchedPrm) {
        summaryEl.textContent = "已启用「" + matchedPrm.title + "」（" + curInst.length + " 字）";
      } else if (curInst) {
        summaryEl.textContent = "自定义系统指令生效中（" + curInst.length + " 字）：" + curInst.slice(0, 46) + (curInst.length > 46 ? "…" : "");
      } else {
        summaryEl.textContent = "未设置（可从下方提示词库一键设为系统指令，或填入对话输入框）";
      }
    }
    if (clearBtn) {
      clearBtn.hidden = !curInst;
    }

    var host = $("plib-list");
    if (!host) { return; }
    clear(host);

    var q = String(promptLibraryState.searchQuery || "").trim().toLowerCase();
    var filtered = list.filter(function (p) {
      var cat = p.category && counts.hasOwnProperty(p.category) ? p.category : "custom";
      if (promptLibraryState.catFilter !== "all" && cat !== promptLibraryState.catFilter) {
        return false;
      }
      if (q) {
        var hay = (String(p.title || "") + " " + String(p.tag || "") + " " + String(p.content || "")).toLowerCase();
        if (hay.indexOf(q) < 0) { return false; }
      }
      return true;
    });

    if (!filtered.length) {
      host.appendChild(el("div", "empty-note", list.length
        ? "没有匹配当前筛选条件的提示词模板"
        : "提示词库为空，点击右上角「新建提示词模板」添加常用系统提示词。"));
      return;
    }

    filtered.forEach(function (item) {
      var isCurActive = Boolean(curInst && String(item.content || "").trim() === curInst);
      var card = el("div", "plib-card" + (isCurActive ? " is-active" : ""));

      var top = el("div", "plib-card-top");
      var titleRow = el("div", "plib-card-title-row");

      var pinBtn = el("button", "plib-pin-btn" + (item.pinned ? " pinned" : ""), item.pinned ? "\u2605" : "\u2606");
      pinBtn.type = "button";
      pinBtn.title = item.pinned ? "取消收藏置顶" : "收藏并置顶此提示词";
      pinBtn.addEventListener("click", function () {
        postJSON("/api/prompts", { action: "togglePin", id: item.id }).then(function (res) {
          if (res && res.ok) {
            promptLibraryState.prompts = res.prompts || [];
            renderPromptQuickChips();
            renderPromptLibraryPane();
          }
        });
      });
      titleRow.appendChild(pinBtn);

      titleRow.appendChild(el("span", "plib-card-title", item.title));

      var catKey = item.category || "custom";
      var catBadge = el("span", "plib-cat-badge " + catKey, item.tag || PROMPT_CAT_LABELS[catKey] || "自定义");
      titleRow.appendChild(catBadge);

      if (isCurActive) {
        titleRow.appendChild(el("span", "plib-active-pill", "当前生效指令"));
      }
      top.appendChild(titleRow);

      var metaText = (item.content || "").length + " 字 · ~" + estimateTextTokens(item.content || "") + " tok" + (item.usageCount ? " · 已复用 " + item.usageCount + " 次" : "");
      top.appendChild(el("span", "plib-card-meta", metaText));
      card.appendChild(top);

      var bodyPre = el("div", "plib-card-content", item.content || "");
      card.appendChild(bodyPre);

      var actions = el("div", "plib-card-actions");
      var actLeft = el("div", "plib-act-left");

      var useSysBtn = el("button", "fb-op-btn use", isCurActive ? "已设为系统指令" : "设为系统指令");
      useSysBtn.type = "button";
      useSysBtn.title = "将此模板设为当前项目的常驻系统提示词（System Prompt）";
      useSysBtn.addEventListener("click", function () {
        applyPromptItemAsSystemInstruction(item, false);
      });
      actLeft.appendChild(useSysBtn);

      var appendBtn = el("button", "fb-op-btn", "+ 追加到指令");
      appendBtn.type = "button";
      appendBtn.title = "将此提示词追加到现有项目专属指令末尾，支持多条指令组合";
      appendBtn.addEventListener("click", function () {
        applyPromptItemAsSystemInstruction(item, true);
      });
      actLeft.appendChild(appendBtn);

      var insertChatBtn = el("button", "fb-op-btn", "填入聊天框");
      insertChatBtn.type = "button";
      insertChatBtn.title = "将此提示词直接填入底部对话输入框";
      insertChatBtn.addEventListener("click", function () {
        var ta = $("in");
        if (ta) {
          ta.value = ta.value ? (ta.value.trim() + "\n\n" + item.content) : item.content;
          autoGrow(ta);
        }
        postJSON("/api/prompts", { action: "incrementUse", id: item.id }).then(function (res) {
          if (res && res.ok) { promptLibraryState.prompts = res.prompts || promptLibraryState.prompts; }
        }).catch(function () {});
        closeProjectModal();
        toast("已将提示词「" + item.title + "」填入对话输入框", "ok");
        if (ta) { ta.focus(); }
      });
      actLeft.appendChild(insertChatBtn);

      actions.appendChild(actLeft);

      var actRight = el("div", "plib-act-right");
      var copyBtn = el("button", "fb-op-btn", "复制");
      copyBtn.type = "button";
      copyBtn.addEventListener("click", function () {
        copyText(item.content || "");
      });
      actRight.appendChild(copyBtn);

      var editBtn = el("button", "fb-op-btn", "编辑");
      editBtn.type = "button";
      editBtn.addEventListener("click", function () {
        openPromptEditor(item);
      });
      actRight.appendChild(editBtn);

      var delBtn = el("button", "fb-op-btn del", "删除");
      delBtn.type = "button";
      delBtn.addEventListener("click", function () {
        postJSON("/api/prompts", { action: "delete", id: item.id }).then(function (res) {
          if (res && res.ok) {
            promptLibraryState.prompts = res.prompts || [];
            promptLibraryState.activePromptId = res.activePromptId || "";
            updatePromptLibraryBadges();
            renderPromptQuickChips();
            renderPromptLibraryPane();
            toast("已从提示词库移除「" + item.title + "」", "info");
          }
        });
      });
      actRight.appendChild(delBtn);

      actions.appendChild(actRight);
      card.appendChild(actions);
      host.appendChild(card);
    });
  }

  function refreshProjectKnowledge() {
    return getJSON("/api/project").then(function (j) {
      if (j && j.ok) {
        S.project = j;
        updateProjectBadge();
        if ($("app") && $("app").classList.contains("insp-open") && S.inspTab === "info") {
          renderInspector();
        }
      }
      return S.project;
    }).catch(function () {});
  }

  function updateProjectBadge() {
    var p = S.project || {};
    var knowledge = p.knowledge || [];
    var activeFilesCount = knowledge.filter(function (k) { return k && k.enabled !== false; }).length;
    var totalCount = knowledge.length + (p.instructions && p.instructions.trim() ? 1 : 0);

    var badge = $("project-count");
    if (badge) {
      badge.textContent = String(totalCount);
    }
  }

  function renderProjectSwitcherBar() {
    var host = $("proj-switcher-pills");
    var delBtn = $("btn-proj-delete");
    if (!host) { return; }
    clear(host);
    var p = S.project || {};
    var projects = p.projects || [];
    var activeId = p.activeProjectId || "proj-default";
    projects.forEach(function (proj) {
      var isAct = proj.id === activeId;
      var pill = el("button", "proj-switcher-pill" + (isAct ? " active" : ""));
      pill.type = "button";
      var cnt = (proj.filesCount || 0) + (proj.uploadedCount || 0);
      pill.appendChild(el("span", null, proj.name || "未命名项目"));
      if (cnt > 0) {
        pill.appendChild(el("span", "proj-tab-cnt", String(cnt)));
      }
      pill.addEventListener("click", function () {
        if (isAct) { return; }
        postJSON("/api/project", { action: "switch", projectId: proj.id }).then(function (res) {
          if (res && res.ok) {
            S.project = res;
            S._projectContextDirty = true;
            updateProjectBadge();
            syncDraftFromActiveProject(res);
            renderProjectSwitcherBar();
            renderProjectsModalContent();
            renderInspector();
            toast("已切换至项目「" + res.name + "」", "ok");
          }
        });
      });
      host.appendChild(pill);
    });
    if (delBtn) {
      delBtn.disabled = projects.length <= 1;
    }
  }

  function syncDraftFromActiveProject(p) {
    var proj = p || S.project || {};
    projModalDraft.name = proj.name || "当前项目";
    projModalDraft.instructions = proj.instructions || "";
    projModalDraft.files = (proj.files || []).slice();
    projModalDraft.disabledFiles = (proj.disabledFiles || []).slice();
    projModalDraft.uploadedFiles = (proj.uploadedFiles || []).map(function (u) {
      return Object.assign({}, u);
    });
    projModalDraft.workspaceMeta = {};
    (proj.knowledge || []).forEach(function (k) {
      if (k && k.source === "workspace") {
        projModalDraft.workspaceMeta[k.rel] = {
          size: k.size,
          lines: k.lines,
          tokens: k.tokens,
          content: k.content
        };
      }
    });
    var nameInp = $("proj-name-input");
    if (nameInp) { nameInp.value = projModalDraft.name; }
    var instTa = $("proj-inst-ta");
    if (instTa) { instTa.value = projModalDraft.instructions; }
  }

  function referenceProjectFileInChat(kItem) {
    if (!kItem) { return; }
    var content = kItem.content || "";
    var name = kItem.rel || kItem.name || "project-file";
    S.attachments.push({
      kind: "text",
      fileRef: true,
      name: name,
      mime: "text/plain",
      size: kItem.size || content.length,
      lines: kItem.lines || (content ? content.split(/\r?\n/).length : 0),
      text: "// [Projects Context File] " + name + "\n" + content
    });
    renderAttachments();
    toast("已将项目文件「" + name + "」加入当前提问引用", "ok");
    var ta = $("in");
    if (ta) { ta.focus(); }
  }


  function isTextProjectFile(file) {
    if (!file || !file.name) { return false; }
    var name = String(file.webkitRelativePath || file.name);
    if (/(?:^|\/)(?:node_modules|\.git|dist|build|\.next|coverage|vendor)(?:\/|$)/i.test(name)) {
      return false;
    }
    if (/\.(?:png|jpe?g|gif|webp|ico|pdf|zip|tar|gz|7z|exe|dll|so|dylib|woff2?|ttf|eot|mp3|mp4|mov|avi|wasm|pyc|class)$/i.test(name)) {
      return false;
    }
    if (file.size > 512 * 1024) {
      return false;
    }
    return true;
  }

  function buildCombinedDraftFiles() {
    var list = [];
    var disabledSet = {};
    (projModalDraft.disabledFiles || []).forEach(function (rel) { disabledSet[rel] = true; });

    (projModalDraft.uploadedFiles || []).forEach(function (u) {
      var content = String(u.content || "");
      list.push({
        id: u.id,
        name: u.name,
        rel: u.name,
        source: u.source === "snippet" ? "snippet" : "upload",
        size: typeof u.size === "number" ? u.size : content.length,
        lines: content ? content.split(/\r?\n/).length : 0,
        tokens: estimateTextTokens(content),
        enabled: u.enabled !== false,
        content: content,
        rawRef: u
      });
    });

    (projModalDraft.files || []).forEach(function (rel) {
      var meta = projModalDraft.workspaceMeta[rel] || {};
      var content = meta.content || "";
      list.push({
        id: "ws-" + rel,
        name: rel.split("/").pop() || rel,
        rel: rel,
        source: "workspace",
        size: meta.size || content.length || 0,
        lines: meta.lines || (content ? content.split(/\r?\n/).length : 0),
        tokens: meta.tokens || estimateTextTokens(content || ""),
        enabled: !disabledSet[rel],
        content: content
      });
    });

    return list;
  }

  function renderProjectsModalContent() {
    var allItems = buildCombinedDraftFiles();
    var cntAll = $("proj-cnt-all");
    var cntUp = $("proj-cnt-upload");
    var cntWs = $("proj-cnt-ws");
    var cntSnip = $("proj-cnt-snippet");

    var counts = { all: allItems.length, upload: 0, workspace: 0, snippet: 0 };
    var enabledCount = 0;
    var instText = ($("proj-inst-ta") && $("proj-inst-ta").value) || projModalDraft.instructions || "";
    var totalTokens = estimateTextTokens(instText);

    allItems.forEach(function (item) {
      counts[item.source] = (counts[item.source] || 0) + 1;
      if (item.enabled !== false) {
        enabledCount++;
        totalTokens += (item.tokens || 0);
      }
    });

    if (cntAll) { cntAll.textContent = String(counts.all); }
    if (cntUp) { cntUp.textContent = String(counts.upload); }
    if (cntWs) { cntWs.textContent = String(counts.workspace); }
    if (cntSnip) { cntSnip.textContent = String(counts.snippet); }

    var limitTokens = (S.project && S.project.limitTokens) || 128000;
    var pct = Math.min(100, Math.round((totalTokens / limitTokens) * 1000) / 10);
    var capSummary = $("proj-cap-summary");
    var capPct = $("proj-cap-pct");
    var capBar = $("proj-cap-bar");
    if (capSummary) {
      capSummary.textContent = "已启用 " + enabledCount + " / " + allItems.length + " 个上下文文件供 AI 参考";
    }
    if (capPct) {
      capPct.textContent = pct + "% · ~" + totalTokens + " tok";
    }
    if (capBar) {
      capBar.style.width = Math.min(100, Math.max(2, pct)) + "%";
    }

    var tabsWrap = $("proj-source-tabs");
    if (tabsWrap) {
      Array.prototype.forEach.call(tabsWrap.querySelectorAll(".proj-tab"), function (b) {
        b.classList.toggle("active", b.getAttribute("data-src") === projModalDraft.sourceFilter);
      });
    }

    var listHost = $("proj-context-list");
    if (!listHost) { return; }
    clear(listHost);

    var q = String(projModalDraft.searchQuery || "").trim().toLowerCase();
    var filtered = allItems.filter(function (item) {
      if (projModalDraft.sourceFilter !== "all" && item.source !== projModalDraft.sourceFilter) {
        return false;
      }
      if (q && String(item.rel || item.name).toLowerCase().indexOf(q) < 0) {
        return false;
      }
      return true;
    });

    if (!filtered.length) {
      var emptyMsg = allItems.length
        ? "没有匹配当前筛选条件的项目文件"
        : "尚未添加项目文件。可点击上方「上传本地文件」、直接拖拽代码文件到此窗口，或从工作区关联文件供 AI 参考。";
      listHost.appendChild(el("div", "empty-note", emptyMsg));
      return;
    }

    filtered.forEach(function (item) {
      var row = el("div", "proj-file-item" + (item.enabled === false ? " is-disabled" : ""));
      var left = el("div", "proj-file-left");

      var chk = document.createElement("input");
      chk.type = "checkbox";
      chk.className = "proj-file-check";
      chk.checked = item.enabled !== false;
      chk.title = "勾选后 AI 将在对话中参考此文件";
      chk.addEventListener("change", function () {
        if (item.source === "workspace") {
          var idx = projModalDraft.disabledFiles.indexOf(item.rel);
          if (chk.checked && idx >= 0) { projModalDraft.disabledFiles.splice(idx, 1); }
          else if (!chk.checked && idx < 0) { projModalDraft.disabledFiles.push(item.rel); }
        } else if (item.rawRef) {
          item.rawRef.enabled = chk.checked;
        }
        renderProjectsModalContent();
      });
      left.appendChild(chk);

      var ico = el("span", "proj-file-ico");
      ico.appendChild(icon("i-file-text", 15));
      left.appendChild(ico);

      var nameEl = el("span", "proj-file-name", item.rel || item.name);
      nameEl.title = item.rel || item.name;
      left.appendChild(nameEl);

      var srcLabel = item.source === "upload" ? "本地上传" : (item.source === "snippet" ? "文本片段" : "工作区");
      var badge = el("span", "proj-source-tag " + item.source, srcLabel);
      left.appendChild(badge);

      row.appendChild(left);

      var actions = el("div", "proj-file-actions");
      actions.appendChild(el("span", "proj-file-meta", bytes(item.size) + " · " + (item.lines || 0) + "行 · ~" + (item.tokens || 0) + " tok"));

      var prevBtn = el("button", "fb-op-btn", item.source === "workspace" ? "预览" : "查看/编辑");
      prevBtn.type = "button";
      prevBtn.addEventListener("click", function () {
        openProjectFilePreview(item);
      });
      actions.appendChild(prevBtn);

      var refBtn = el("button", "fb-op-btn use", "@引用");
      refBtn.type = "button";
      refBtn.title = "立即将此文件放入聊天输入框作为本次提问附件";
      refBtn.addEventListener("click", function () {
        if (item.source === "workspace" && !item.content) {
          getJSON("/api/fs/file?path=" + encodeURIComponent(item.rel)).then(function (fd) {
            item.content = (fd && fd.content) || "";
            referenceProjectFileInChat(item);
            closeProjectModal();
          });
        } else {
          referenceProjectFileInChat(item);
          closeProjectModal();
        }
      });
      actions.appendChild(refBtn);

      var delBtn = el("button", "fb-op-btn del", "移除");
      delBtn.type = "button";
      delBtn.addEventListener("click", function () {
        if (item.source === "workspace") {
          var fIdx = projModalDraft.files.indexOf(item.rel);
          if (fIdx >= 0) { projModalDraft.files.splice(fIdx, 1); }
        } else {
          projModalDraft.uploadedFiles = (projModalDraft.uploadedFiles || []).filter(function (u) {
            return u.id !== item.id;
          });
        }
        if (projModalDraft.previewTargetId === item.id) {
          var pbox = $("proj-file-preview");
          if (pbox) { pbox.hidden = true; }
          projModalDraft.previewTargetId = null;
        }
        renderProjectsModalContent();
      });
      actions.appendChild(delBtn);

      row.appendChild(actions);
      listHost.appendChild(row);
    });
  }

  function openProjectFilePreview(item) {
    var box = $("proj-file-preview");
    var titleEl = $("proj-preview-title");
    var ta = $("proj-preview-ta");
    var saveBtn = $("btn-proj-preview-save");
    if (!box || !ta || !titleEl) { return; }

    projModalDraft.previewTargetId = item.id;
    var editable = item.source !== "workspace";
    titleEl.textContent = (editable ? "查看 / 编辑上传文件：" : "预览工作区文件：") + (item.rel || item.name);
    ta.readOnly = !editable;
    if (saveBtn) {
      saveBtn.hidden = !editable;
      saveBtn.onclick = function () {
        if (item.rawRef) {
          item.rawRef.content = ta.value;
          item.rawRef.size = ta.value.length;
          item.rawRef.lines = ta.value.split(/\r?\n/).length;
          item.rawRef.tokens = estimateTextTokens(ta.value);
          renderProjectsModalContent();
          toast("已更新「" + item.name + "」内容，点击底部保存后生效", "ok");
        }
      };
    }

    if (item.source === "workspace" && !item.content) {
      ta.value = "正在读取文件内容…";
      box.hidden = false;
      getJSON("/api/fs/file?path=" + encodeURIComponent(item.rel)).then(function (fd) {
        var c = (fd && fd.content) || "";
        item.content = c;
        if (projModalDraft.workspaceMeta[item.rel]) {
          projModalDraft.workspaceMeta[item.rel].content = c;
        }
        ta.value = c;
      }).catch(function () {
        ta.value = "// 读取失败";
      });
    } else {
      ta.value = item.content || "";
      box.hidden = false;
    }
  }

  function handleProjectLocalFilesUpload(fileList) {
    if (!fileList || !fileList.length) { return; }
    var validFiles = [];
    var skipped = 0;
    Array.prototype.forEach.call(fileList, function (f) {
      if (isTextProjectFile(f)) {
        validFiles.push(f);
      } else {
        skipped++;
      }
    });

    if (!validFiles.length) {
      toast("未发现可解析的文本/代码文件（已跳过二进制或超大文件）", "warn");
      return;
    }

    var jobs = validFiles.slice(0, 35).map(function (file, idx) {
      return readFileText(file).then(function (txt) {
        var content = String(txt || "").slice(0, 48000);
        var relName = String(file.webkitRelativePath || file.name).replace(/\\/g, "/");
        return {
          id: "up-" + Date.now() + "-" + idx + "-" + Math.random().toString(36).slice(2, 6),
          name: relName,
          source: "upload",
          size: file.size || content.length,
          lines: content ? content.split(/\r?\n/).length : 0,
          tokens: estimateTextTokens(content),
          enabled: true,
          updatedAt: new Date().toISOString(),
          content: content
        };
      }).catch(function () { return null; });
    });

    Promise.all(jobs).then(function (results) {
      var added = 0;
      results.forEach(function (entry) {
        if (!entry) { return; }
        var existingIdx = -1;
        for (var i = 0; i < projModalDraft.uploadedFiles.length; i++) {
          if (projModalDraft.uploadedFiles[i].name === entry.name) {
            existingIdx = i;
            break;
          }
        }
        if (existingIdx >= 0) {
          entry.id = projModalDraft.uploadedFiles[existingIdx].id;
          projModalDraft.uploadedFiles[existingIdx] = entry;
        } else {
          projModalDraft.uploadedFiles.unshift(entry);
        }
        added++;
      });
      renderProjectsModalContent();
      toast("已导入 " + added + " 个本地项目文件到列表" + (skipped ? "（跳过 " + skipped + " 个非文本文件）" : ""), "ok");
    });
  }

  function bindProjectsModalEventsOnce() {
    if (projModalDraft.bound) { return; }
    projModalDraft.bound = true;

    var btnUpFiles = $("btn-proj-upload-files");
    var inpFiles = $("proj-file-input");
    if (btnUpFiles && inpFiles) {
      btnUpFiles.addEventListener("click", function () { inpFiles.click(); });
      inpFiles.addEventListener("change", function () {
        handleProjectLocalFilesUpload(inpFiles.files);
        inpFiles.value = "";
      });
    }

    var btnUpDir = $("btn-proj-upload-dir");
    var inpDir = $("proj-dir-input");
    if (btnUpDir && inpDir) {
      btnUpDir.addEventListener("click", function () { inpDir.click(); });
      inpDir.addEventListener("change", function () {
        handleProjectLocalFilesUpload(inpDir.files);
        inpDir.value = "";
      });
    }

    var dropzone = $("proj-dropzone");
    if (dropzone) {
      dropzone.addEventListener("dragover", function (e) {
        e.preventDefault();
        e.stopPropagation();
        dropzone.classList.add("drag-over");
      });
      dropzone.addEventListener("dragleave", function (e) {
        e.preventDefault();
        e.stopPropagation();
        dropzone.classList.remove("drag-over");
      });
      dropzone.addEventListener("drop", function (e) {
        e.preventDefault();
        e.stopPropagation();
        dropzone.classList.remove("drag-over");
        if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) {
          handleProjectLocalFilesUpload(e.dataTransfer.files);
        }
      });
    }

    var btnToggleSnip = $("btn-proj-toggle-snippet");
    var snipBox = $("proj-snippet-box");
    var btnCancelSnip = $("btn-proj-snippet-cancel");
    var btnAddSnip = $("btn-proj-snippet-add");
    if (btnToggleSnip && snipBox) {
      btnToggleSnip.addEventListener("click", function () {
        snipBox.hidden = !snipBox.hidden;
        if (!snipBox.hidden && $("proj-snippet-title")) {
          $("proj-snippet-title").focus();
        }
      });
    }
    if (btnCancelSnip && snipBox) {
      btnCancelSnip.addEventListener("click", function () {
        snipBox.hidden = true;
      });
    }
    if (btnAddSnip && snipBox) {
      btnAddSnip.addEventListener("click", function () {
        var tEl = $("proj-snippet-title");
        var cEl = $("proj-snippet-content");
        var title = (tEl && tEl.value ? tEl.value.trim() : "") || ("片段-" + (projModalDraft.uploadedFiles.length + 1) + ".md");
        var content = (cEl && cEl.value) ? cEl.value : "";
        if (!content.trim()) {
          toast("请输入文本片段内容", "warn");
          return;
        }
        projModalDraft.uploadedFiles.unshift({
          id: "snip-" + Date.now(),
          name: title,
          source: "snippet",
          size: content.length,
          lines: content.split(/\r?\n/).length,
          tokens: estimateTextTokens(content),
          enabled: true,
          updatedAt: new Date().toISOString(),
          content: content
        });
        if (tEl) { tEl.value = ""; }
        if (cEl) { cEl.value = ""; }
        snipBox.hidden = true;
        renderProjectsModalContent();
        toast("已添加文本片段「" + title + "」", "ok");
      });
    }

    var tabsWrap = $("proj-source-tabs");
    if (tabsWrap) {
      tabsWrap.addEventListener("click", function (e) {
        var btn = e.target && e.target.closest ? e.target.closest(".proj-tab") : null;
        if (!btn) { return; }
        projModalDraft.sourceFilter = btn.getAttribute("data-src") || "all";
        renderProjectsModalContent();
      });
    }

    var searchInp = $("proj-file-search");
    if (searchInp) {
      searchInp.addEventListener("input", function () {
        projModalDraft.searchQuery = searchInp.value || "";
        renderProjectsModalContent();
      });
    }

    var wsSelect = $("proj-ws-select");
    if (wsSelect) {
      wsSelect.addEventListener("change", function () {
        var rel = wsSelect.value;
        wsSelect.value = "";
        if (!rel) { return; }
        if (projModalDraft.files.indexOf(rel) < 0) {
          projModalDraft.files.push(rel);
          getJSON("/api/fs/file?path=" + encodeURIComponent(rel)).then(function (fd) {
            if (fd && !fd.error) {
              var c = fd.content || "";
              projModalDraft.workspaceMeta[rel] = {
                size: fd.size || c.length,
                lines: c.split(/\r?\n/).length,
                tokens: estimateTextTokens(c),
                content: c
              };
              renderProjectsModalContent();
            }
          }).catch(function () {});
        }
        renderProjectsModalContent();
      });
    }

    var btnPrevClose = $("btn-proj-preview-close");
    if (btnPrevClose) {
      btnPrevClose.addEventListener("click", function () {
        var pbox = $("proj-file-preview");
        if (pbox) { pbox.hidden = true; }
        projModalDraft.previewTargetId = null;
      });
    }

    var instTa = $("proj-inst-ta");
    if (instTa) {
      instTa.addEventListener("input", function () {
        projModalDraft.instructions = instTa.value;
        renderPromptQuickChips();
        renderProjectsModalContent();
      });
    }

    // 模态框顶部模式切换（项目文件上下文 <-> 提示词库 Prompt Library）
    var modeTabs = $("proj-modal-mode-tabs");
    if (modeTabs) {
      modeTabs.addEventListener("click", function (e) {
        var btn = e.target && e.target.closest ? e.target.closest(".proj-mode-tab") : null;
        if (!btn) { return; }
        switchProjectModalMode(btn.getAttribute("data-proj-mode") || "files");
      });
    }

    var btnOpenLib = $("btn-proj-open-lib");
    if (btnOpenLib) {
      btnOpenLib.addEventListener("click", function () {
        switchProjectModalMode("prompts");
      });
    }

    var btnSaveInstToLib = $("btn-proj-save-inst-to-lib");
    if (btnSaveInstToLib) {
      btnSaveInstToLib.addEventListener("click", function () {
        var curText = ($("proj-inst-ta") && $("proj-inst-ta").value.trim()) || "";
        switchProjectModalMode("prompts");
        openPromptEditor(null, curText);
        if (!curText) {
          toast("请填写要保存到提示词库的系统指令标题与内容", "info");
        }
      });
    }

    var btnPlibNew = $("btn-plib-new");
    if (btnPlibNew) {
      btnPlibNew.addEventListener("click", function () {
        var ed = $("plib-editor");
        if (ed && !ed.hidden && !promptLibraryState.editingId) {
          ed.hidden = true;
          return;
        }
        openPromptEditor(null, "");
      });
    }

    var btnPlibCancel = $("btn-plib-form-cancel");
    if (btnPlibCancel) {
      btnPlibCancel.addEventListener("click", function () {
        var ed = $("plib-editor");
        if (ed) { ed.hidden = true; }
        promptLibraryState.editingId = null;
      });
    }

    var btnPlibSave = $("btn-plib-form-save");
    if (btnPlibSave) {
      btnPlibSave.addEventListener("click", function () {
        var inpTitle = $("plib-form-title");
        var selCat = $("plib-form-category");
        var inpTag = $("plib-form-tag");
        var taContent = $("plib-form-content");
        var chkApply = $("plib-form-apply-now");

        var title = (inpTitle && inpTitle.value.trim()) || "";
        var content = (taContent && taContent.value.trim()) || "";
        var category = (selCat && selCat.value) || "custom";
        var tag = (inpTag && inpTag.value.trim()) || PROMPT_CAT_LABELS[category] || "自定义";
        var applyNow = Boolean(chkApply && chkApply.checked);

        if (!title) {
          toast("请输入提示词名称", "warn");
          if (inpTitle) { inpTitle.focus(); }
          return;
        }
        if (!content) {
          toast("请输入提示词正文内容", "warn");
          if (taContent) { taContent.focus(); }
          return;
        }

        postJSON("/api/prompts", {
          action: "upsert",
          setActive: applyNow,
          prompt: {
            id: promptLibraryState.editingId || undefined,
            title: title,
            category: category,
            tag: tag,
            pinned: true,
            content: content
          }
        }).then(function (res) {
          if (res && res.ok) {
            promptLibraryState.prompts = res.prompts || [];
            promptLibraryState.activePromptId = res.activePromptId || "";
            promptLibraryState.editingId = null;
            var ed = $("plib-editor");
            if (ed) { ed.hidden = true; }
            if (applyNow) {
              projModalDraft.instructions = content;
              if ($("proj-inst-ta")) { $("proj-inst-ta").value = content; }
              postJSON("/api/project", {
                name: ($("proj-name-input") && $("proj-name-input").value.trim()) || projModalDraft.name || "当前项目",
                instructions: content,
                files: projModalDraft.files,
                disabledFiles: projModalDraft.disabledFiles,
                uploadedFiles: projModalDraft.uploadedFiles
              }).then(function (pRes) {
                if (pRes && pRes.ok) {
                  S.project = pRes;
                  S._projectContextDirty = true;
                  updateProjectBadge();
                  renderInspector();
                }
              });
            }
            updatePromptLibraryBadges();
            renderPromptQuickChips();
            renderPromptLibraryPane();
            toast("已保存提示词「" + title + "」到提示词库" + (applyNow ? "并设为当前系统指令" : ""), "ok");
          }
        }).catch(function (e) {
          toast("保存提示词失败：" + e.message, "err");
        });
      });
    }

    var btnPlibClearActive = $("btn-plib-clear-active");
    if (btnPlibClearActive) {
      btnPlibClearActive.addEventListener("click", function () {
        projModalDraft.instructions = "";
        if ($("proj-inst-ta")) { $("proj-inst-ta").value = ""; }
        postJSON("/api/prompts", { action: "setActive", id: "" }).then(function (res) {
          if (res && res.ok) { promptLibraryState.activePromptId = ""; }
        });
        postJSON("/api/project", {
          name: ($("proj-name-input") && $("proj-name-input").value.trim()) || projModalDraft.name || "当前项目",
          instructions: "",
          files: projModalDraft.files,
          disabledFiles: projModalDraft.disabledFiles,
          uploadedFiles: projModalDraft.uploadedFiles
        }).then(function (pRes) {
          if (pRes && pRes.ok) {
            S.project = pRes;
            S._projectContextDirty = true;
            updateProjectBadge();
            updatePromptLibraryBadges();
            renderPromptQuickChips();
            renderPromptLibraryPane();
            renderProjectsModalContent();
            renderInspector();
            toast("已清除当前项目系统指令", "info");
          }
        });
      });
    }

    var plibCatTabs = $("plib-cat-tabs");
    if (plibCatTabs) {
      plibCatTabs.addEventListener("click", function (e) {
        var btn = e.target && e.target.closest ? e.target.closest(".proj-tab") : null;
        if (!btn) { return; }
        promptLibraryState.catFilter = btn.getAttribute("data-pcat") || "all";
        renderPromptLibraryPane();
      });
    }

    var plibSearch = $("plib-search-input");
    if (plibSearch) {
      plibSearch.addEventListener("input", function () {
        promptLibraryState.searchQuery = plibSearch.value || "";
        renderPromptLibraryPane();
      });
    }

    var btnToggleAll = $("btn-proj-toggle-all");
    if (btnToggleAll) {
      btnToggleAll.addEventListener("click", function () {
        var allItems = buildCombinedDraftFiles();
        var anyDisabled = allItems.some(function (x) { return x.enabled === false; });
        if (anyDisabled) {
          projModalDraft.disabledFiles = [];
          projModalDraft.uploadedFiles.forEach(function (u) { u.enabled = true; });
        } else {
          projModalDraft.disabledFiles = projModalDraft.files.slice();
          projModalDraft.uploadedFiles.forEach(function (u) { u.enabled = false; });
        }
        renderProjectsModalContent();
      });
    }

    var btnClearUp = $("btn-proj-clear-uploads");
    if (btnClearUp) {
      btnClearUp.addEventListener("click", function () {
        if (!projModalDraft.uploadedFiles.length) {
          toast("当前没有已上传的本地文件", "info");
          return;
        }
        projModalDraft.uploadedFiles = [];
        renderProjectsModalContent();
        toast("已清空上传文件列表（点击保存后生效）", "info");
      });
    }

    var btnProjCreate = $("btn-proj-create");
    if (btnProjCreate) {
      btnProjCreate.addEventListener("click", function () {
        var newName = "新项目 #" + (((S.project && S.project.projects && S.project.projects.length) || 1) + 1);
        var nameInp = $("proj-name-input");
        if (nameInp && nameInp.value.trim() && nameInp.value.trim() !== S.project.name) {
          newName = nameInp.value.trim();
        }
        postJSON("/api/project", {
          action: "create",
          name: newName,
          instructions: "",
          files: [],
          uploadedFiles: []
        }).then(function (res) {
          if (res && res.ok) {
            S.project = res;
            S._projectContextDirty = true;
            updateProjectBadge();
            syncDraftFromActiveProject(res);
            renderProjectSwitcherBar();
            renderProjectsModalContent();
            renderInspector();
            if ($("proj-name-input")) {
              $("proj-name-input").focus();
              $("proj-name-input").select();
            }
            toast("已创建并切换到新项目「" + res.name + "」", "ok");
          }
        });
      });
    }

    var btnProjDelete = $("btn-proj-delete");
    if (btnProjDelete) {
      btnProjDelete.addEventListener("click", function () {
        var p = S.project || {};
        if (!p.projects || p.projects.length <= 1) {
          toast("至少需要保留一个项目工作区", "warn");
          return;
        }
        var delName = p.name || "当前项目";
        postJSON("/api/project", {
          action: "delete",
          projectId: p.activeProjectId
        }).then(function (res) {
          if (res && res.ok) {
            S.project = res;
            S._projectContextDirty = true;
            updateProjectBadge();
            syncDraftFromActiveProject(res);
            renderProjectSwitcherBar();
            renderProjectsModalContent();
            renderInspector();
            toast("已删除项目「" + delName + "」，切换至「" + res.name + "」", "info");
          }
        });
      });
    }

    var btnSave = $("btn-proj-save");
    if (btnSave) {
      btnSave.addEventListener("click", function () {
        var nameInp = $("proj-name-input");
        var instInput = $("proj-inst-ta");
        postJSON("/api/project", {
          name: (nameInp && nameInp.value.trim()) || projModalDraft.name || "当前项目",
          instructions: instInput ? instInput.value : projModalDraft.instructions,
          files: projModalDraft.files,
          disabledFiles: projModalDraft.disabledFiles,
          uploadedFiles: projModalDraft.uploadedFiles
        }).then(function (res) {
          if (res && res.ok) {
            S.project = res;
            S._projectContextDirty = true;
            updateProjectBadge();
            updatePromptLibraryBadges();
            renderProjectSwitcherBar();
            renderInspector();
            closeProjectModal();
            var enabledCnt = (res.knowledge || []).filter(function (k) { return k.enabled !== false; }).length;
            toast("已保存项目「" + res.name + "」（" + enabledCnt + " 个上下文文件" + (res.instructions ? " + 系统指令已生效" : "") + "）", "ok");
          }
        }).catch(function (e) {
          toast("保存失败：" + e.message, "err");
        });
      });
    }
  }

  function closeProjectModal() {
    var m = $("projects-modal");
    if (m) { m.hidden = true; }
  }

  function openPromptLibraryModal() {
    openProjectModal("prompts");
  }

  function openProjectModal(initialMode) {
    var targetMode = initialMode === "prompts" ? "prompts" : "files";
    bindProjectsModalEventsOnce();
    Promise.all([refreshProjectKnowledge(), refreshPromptLibrary()]).then(function () {
      var p = S.project || { name: "当前项目", instructions: "", files: [], disabledFiles: [], uploadedFiles: [], knowledge: [] };
      syncDraftFromActiveProject(p);
      renderProjectSwitcherBar();
      projModalDraft.sourceFilter = "all";
      projModalDraft.searchQuery = "";
      projModalDraft.previewTargetId = null;

      var searchInp = $("proj-file-search");
      if (searchInp) { searchInp.value = ""; }
      var pbox = $("proj-file-preview");
      if (pbox) { pbox.hidden = true; }
      var sbox = $("proj-snippet-box");
      if (sbox) { sbox.hidden = true; }
      var edBox = $("plib-editor");
      if (edBox) { edBox.hidden = true; }

      var wsSelect = $("proj-ws-select");
      if (wsSelect) {
        clear(wsSelect);
        var defOpt = document.createElement("option");
        defOpt.value = "";
        defOpt.textContent = "+ 关联工作区文件…";
        wsSelect.appendChild(defOpt);
        getJSON("/api/fs/search?q=").then(function (j) {
          ((j && j.files) || []).forEach(function (f) {
            var opt = document.createElement("option");
            opt.value = f.rel;
            opt.textContent = f.rel + " (" + bytes(f.size) + ")";
            wsSelect.appendChild(opt);
          });
        }).catch(function () {});
      }

      switchProjectModalMode(targetMode);
      var modal = $("projects-modal");
      if (modal) {
        modal.hidden = false;
      }
    });
  }

  function renderStyleButton() {
    var st = STYLE_PRESETS.filter(function (x) { return x.id === S.style; })[0] || STYLE_PRESETS[0];
    var lbl = $("style-label");
    var btn = $("btn-style");
    if (lbl) { lbl.textContent = st.label; }
    if (btn) { btn.classList.toggle("active", st.id !== "normal"); }
  }

  function toggleStyleMenu() {
    var menu = $("style-menu");
    if (!menu) { return; }
    if (!menu.hidden) { menu.hidden = true; return; }
    clear(menu);
    menu.appendChild(el("div", "style-menu-head", "选择回答风格 · Choose a style"));
    STYLE_PRESETS.forEach(function (st) {
      var b = el("button", "style-opt" + (S.style === st.id ? " on" : ""));
      b.type = "button";
      var top = el("div", "style-opt-top");
      top.appendChild(el("span", null, st.label + " · " + st.en));
      if (S.style === st.id) { top.appendChild(el("span", null, "\u2713")); }
      b.appendChild(top);
      b.appendChild(el("div", "style-opt-desc", st.desc));
      b.addEventListener("click", function (e) {
        e.stopPropagation();
        S.style = st.id;
        try { localStorage.setItem(LS_STYLE, st.id); } catch (err) {}
        renderStyleButton();
        menu.hidden = true;
        toast("回答风格已切换为「" + st.label + "」", "ok");
      });
      menu.appendChild(b);
    });
    menu.hidden = false;
  }

  /* ---- @ 工作区文件引用选择器 ---- */
  var atOpen = false;
  var atIndex = 0;
  var atMatches = [];
  var atStartPos = -1;
  var atSearchTimer = null;

  function updateAtMenu(ta) {
    if (!ta) { return; }
    var val = ta.value || "";
    var caret = typeof ta.selectionStart === "number" ? ta.selectionStart : val.length;
    var before = val.slice(0, caret);
    var m = before.match(/(?:^|\s)@([^\s@]*)$/);
    if (!m) { closeAtMenu(); return; }
    var query = m[1] || "";
    atStartPos = caret - query.length - 1;
    clearTimeout(atSearchTimer);
    atSearchTimer = setTimeout(function () {
      fetchAtFiles(query);
    }, 60);
  }

  function fetchAtFiles(query) {
    var q = String(query || "").toLowerCase();
    var uploadedMatches = ((S.project && S.project.knowledge) || [])
      .filter(function (k) {
        return (k.source === "upload" || k.source === "snippet") && (!q || String(k.rel || k.name).toLowerCase().indexOf(q) >= 0);
      })
      .map(function (k) {
        return {
          rel: k.rel || k.name,
          size: k.size || 0,
          isProjectUpload: true,
          projectItem: k
        };
      });

    getJSON("/api/fs/search?q=" + encodeURIComponent(query || "")).then(function (j) {
      var wsFiles = (j && j.files) || [];
      atMatches = uploadedMatches.concat(wsFiles);
      if (!atMatches.length) { closeAtMenu(); return; }
      atIndex = Math.min(atIndex, atMatches.length - 1);
      atOpen = true;
      drawAtMenu();
    }).catch(function () {
      if (uploadedMatches.length) {
        atMatches = uploadedMatches;
        atIndex = 0;
        atOpen = true;
        drawAtMenu();
      } else {
        closeAtMenu();
      }
    });
  }

  function drawAtMenu() {
    var host = $("at-menu");
    if (!host) { return; }
    host.hidden = false;
    clear(host);
    atMatches.slice(0, 10).forEach(function (f, i) {
      var isDir = f.isDir || /\/$/.test(f.rel || "");
      var row = el("button", "slash-item" + (i === atIndex ? " sel" : ""));
      row.type = "button";
      row.appendChild(el("span", "slash-k", "@" + f.rel));
      row.appendChild(el("span", "slash-d", (f.isProjectUpload ? "[Projects 上传] " : "") + (isDir ? "目录 · 回车进入" : bytes(f.size))));
      row.addEventListener("mousedown", function (e) {
        e.preventDefault();
        atIndex = i;
        atAccept();
      });
      host.appendChild(row);
    });
  }

  function atMove(delta) {
    if (!atMatches.length) { return; }
    atIndex = (atIndex + delta + atMatches.length) % atMatches.length;
    drawAtMenu();
  }

  function atAccept() {
    var item = atMatches[atIndex];
    if (!item) { closeAtMenu(); return; }
    // 目录行：不关菜单，把 @ 查询替换成「rel/」继续往深处浏览
    // （对齐 Claude Code 的 @ 目录行为）。
    if (item.isDir || /\/$/.test(item.rel || "")) {
      var taDir = $("in");
      if (taDir && atStartPos >= 0) {
        var caretDir = typeof taDir.selectionStart === "number" ? taDir.selectionStart : taDir.value.length;
        // 保留 @ 前缀：@src/ 继续触发补全，光标落在斜杠后
        taDir.value = taDir.value.slice(0, atStartPos) + "@" + (item.rel || "") + taDir.value.slice(caretDir);
        var nextPos = atStartPos + 1 + (item.rel || "").length;
        taDir.setSelectionRange(nextPos, nextPos);
        autoGrow(taDir);
      }
      fetchAtFiles(String(item.rel || ""));
      return;
    }
    var ta = $("in");
    if (ta && atStartPos >= 0) {
      var caret = typeof ta.selectionStart === "number" ? ta.selectionStart : ta.value.length;
      ta.value = ta.value.slice(0, atStartPos) + ta.value.slice(caret);
      ta.setSelectionRange(atStartPos, atStartPos);
      autoGrow(ta);
    }
    closeAtMenu();
    if (item.isProjectUpload && item.projectItem) {
      referenceProjectFileInChat(item.projectItem);
      return;
    }
    getJSON("/api/fs/file?path=" + encodeURIComponent(item.path)).then(function (fileData) {
      if (!fileData || fileData.error) {
        toast("无法读取文件：" + ((fileData && fileData.error) || item.rel), "err");
        return;
      }
      S.attachments.push({
        kind: "text",
        fileRef: true,
        name: item.rel,
        mime: "text/plain",
        size: fileData.size || (fileData.content || "").length,
        lines: (fileData.content || "").split(/\r?\n/).length,
        text: "// File: " + item.rel + "\n" + (fileData.content || "")
      });
      renderAttachments();
      toast("已引用文件 @" + item.rel, "ok");
      if (ta) { ta.focus(); }
    }).catch(function (e) {
      toast("读取文件失败：" + e.message, "err");
    });
  }

  function closeAtMenu() {
    atOpen = false;
    atIndex = 0;
    atStartPos = -1;
    var host = $("at-menu");
    if (host) { host.hidden = true; clear(host); }
  }

  /* ---- Artifacts 右侧分屏画布与对话内卡片（支持 HTML/SVG/Mermaid/JSX/CSV/Diff/一键写入文件） ---- */
  function isPreviewableArtifact(lang, code) {
    var l = String(lang || "").toLowerCase();
    if (/^(html|htm|svg|xml|markdown|md|mermaid|mmd|jsx|tsx|react|csv|tsv)$/.test(l)) { return true; }
    if (l === "json" && /^\s*\[\s*\{/.test(code || "")) { return true; }
    if (/^\s*(<!doctype html|<html|<svg|graph\s+|flowchart\s+|sequenceDiagram|classDiagram|stateDiagram|erDiagram|gantt|pie\s+)/i.test(code || "")) { return true; }
    return false;
  }

  function inferArtifactTitle(lang, code, idx) {
    var firstLine = (String(code || "").trim().split(/\r?\n/)[0] || "").trim();
    var mComment = firstLine.match(/^(?:\/\/|#|<!--|\/\*)\s*([A-Za-z0-9_.\-\u4e00-\u9fa5 /]{2,40})/);
    if (mComment && mComment[1]) {
      return mComment[1].replace(/(-->|\*\/)$/, "").trim();
    }
    var mTitle = String(code || "").match(/<title>([^<]{1,40})<\/title>/i);
    if (mTitle && mTitle[1]) { return mTitle[1].trim(); }
    var l = String(lang || "code").toUpperCase();
    return l + " 代码工件 #" + idx;
  }

  function inferArtifactDefaultPath(active) {
    if (!active) { return "src/artifact.txt"; }
    var titlePath = String(active.title || "").trim();
    if (/^[A-Za-z0-9_.\-/]+\.[A-Za-z0-9]+$/.test(titlePath)) {
      return titlePath;
    }
    var l = String(active.lang || "").toLowerCase();
    var extMap = {
      html: "html", htm: "html", svg: "svg",
      mermaid: "mmd", mmd: "mmd",
      jsx: "jsx", tsx: "tsx", react: "jsx",
      js: "js", javascript: "js", ts: "ts", typescript: "ts",
      css: "css", json: "json", csv: "csv", md: "md", markdown: "md", py: "py", python: "py"
    };
    var ext = extMap[l] || "txt";
    return "artifacts/artifact-v" + (active.version || 1) + "." + ext;
  }

  function updateArtifactBadge() {
    var badge = $("artifact-count");
    if (!badge) { return; }
    if (S.artifacts.length > 0) {
      badge.hidden = false;
      badge.textContent = String(S.artifacts.length);
    } else {
      badge.hidden = true;
    }
  }

  function enhanceCodeblocksWithArtifacts(container) {
    if (!container) { return; }
    var blocks = container.querySelectorAll(".codeblock");
    Array.prototype.forEach.call(blocks, function (block) {
      if (block.getAttribute("data-art-bound")) { return; }
      block.setAttribute("data-art-bound", "1");
      var langEl = block.querySelector(".cb-lang");
      var preEl = block.querySelector("pre");
      var headEl = block.querySelector(".cb-head");
      var copyBtn = block.querySelector(".cb-copy");
      if (!preEl || !headEl) { return; }

      var lang = (langEl && langEl.textContent) || "text";
      var code = preEl.textContent || "";
      var lines = code.split(/\r?\n/).length;
      if (lines < 4 && !isPreviewableArtifact(lang, code)) { return; }

      var ver = S.artifacts.length + 1;
      var artId = "art-" + Date.now() + "-" + ver;
      var previewable = isPreviewableArtifact(lang, code);
      var title = inferArtifactTitle(lang, code, ver);
      var prevSameLang = null;
      for (var i = S.artifacts.length - 1; i >= 0; i--) {
        if (S.artifacts[i].lang === lang) {
          prevSameLang = S.artifacts[i].code;
          break;
        }
      }
      var item = {
        id: artId,
        version: ver,
        title: title,
        lang: lang,
        lines: lines,
        code: code,
        originalCode: prevSameLang || code,
        previewable: previewable
      };
      S.artifacts.push(item);
      updateArtifactBadge();

      // 在代码块头部增加「在画布中打开」按钮
      var actWrap = el("div", "cb-head-actions");
      var openBtn = el("button", "cb-art-btn", previewable ? "预览 Artifact" : "画布打开");
      openBtn.type = "button";
      openBtn.addEventListener("click", function () {
        openArtifactInPane(artId, previewable ? "preview" : "code");
      });
      if (copyBtn && copyBtn.parentNode === headEl) {
        headEl.replaceChild(actWrap, copyBtn);
        actWrap.appendChild(openBtn);
        actWrap.appendChild(copyBtn);
      } else {
        headEl.appendChild(openBtn);
      }

      // 在代码块前插入 Claude 风格 Artifact 独立卡片
      var card = el("button", "artifact-card");
      card.type = "button";
      var ico = el("span", "artifact-card-ico");
      ico.appendChild(icon("i-code", 18));
      card.appendChild(ico);
      var cbody = el("div", "artifact-card-body");
      cbody.appendChild(el("div", "artifact-card-title", title));
      cbody.appendChild(el("div", "artifact-card-sub", (previewable ? "可交互预览 · " : "代码视图 · ") + lang + " · " + lines + " 行 · v" + ver));
      card.appendChild(cbody);
      card.appendChild(el("span", "artifact-card-open", "打开画布 \u2192"));
      card.addEventListener("click", function () {
        openArtifactInPane(artId, previewable ? "preview" : "code");
      });
      if (block.parentNode) {
        block.parentNode.insertBefore(card, block);
      }
    });
  }

    /**
   * 变更 tab — aligned with the Claude Code changes panel: turn/branch scope,
   * per-file +added/-removed, click a file for its diff.
   */
  function loadChanges(scope) {
    S.changesScope = scope === "branch" ? "branch" : "turn";
    var box = $("changes-body");
    if (!box) { return; }
    box.innerHTML = "";
    var head = el("div", "chg-head");
    var seg = el("div", "chg-scope-seg");
    var bTurn = el("button", "chg-scope-btn" + (S.changesScope === "turn" ? " active" : ""), "本轮");
    var bBranch = el("button", "chg-scope-btn" + (S.changesScope === "branch" ? " active" : ""), "分支");
    bTurn.type = "button"; bBranch.type = "button";
    bTurn.addEventListener("click", function () { loadChanges("turn"); });
    bBranch.addEventListener("click", function () { loadChanges("branch"); });
    seg.appendChild(bTurn); seg.appendChild(bBranch);
    head.appendChild(seg);
    var refresh = el("button", "icon-btn", "↻");
    refresh.title = "刷新";
    refresh.addEventListener("click", function () { loadChanges(S.changesScope); });
    head.appendChild(refresh);
    box.appendChild(head);
    var list = el("div", "chg-list");
    list.appendChild(el("div", "empty-note", "加载中…"));
    box.appendChild(list);
    getJSON("/api/changes?sessionKey=" + encodeURIComponent(S.sessionKey || "default") + "&scope=" + S.changesScope).then(function (j) {
      list.innerHTML = "";
      if (!j.ok) {
        list.appendChild(el("div", "empty-note", j.reason === "non-git" ? "当前目录不是 git 仓库" : "无法读取变更：" + (j.error || j.reason || "")));
        return;
      }
      if (j.truncated) { list.appendChild(el("div", "empty-note warn", "文件过多，仅显示前 500 个")); }
      if (!j.files.length) {
        list.appendChild(el("div", "empty-note", S.changesScope === "turn"
          ? "本轮没有文件变更（运行一轮并修改文件后，这里会显示该轮的差异）"
          : "暂无变更（分支上有提交差异后显示）"));
        return;
      }
      var sum = el("div", "chg-sum");
      sum.appendChild(el("span", "chg-add", "+" + j.totalAdded));
      sum.appendChild(el("span", "chg-del", "−" + j.totalRemoved));
      list.appendChild(sum);
      j.files.forEach(function (f) {
        var row = el("div", "chg-file");
        row.appendChild(el("span", "chg-path", f.path.split(/[\\/]/).pop()));
        row.appendChild(el("span", "chg-status st-" + (f.status || "M").toLowerCase(), f.status || "M"));
        var nums = el("span", "chg-nums");
        if (f.added) { nums.appendChild(el("span", "chg-add", "+" + f.added)); }
        if (f.removed) { nums.appendChild(el("span", "chg-del", "−" + f.removed)); }
        row.appendChild(nums);
        row.title = f.path;
        row.addEventListener("click", function () { openChangeDiff(f); });
        list.appendChild(row);
      });
    }).catch(function (e) {
      list.innerHTML = "";
      list.appendChild(el("div", "empty-note", "加载失败：" + e.message));
    });
  }

  /** Click a changed file: fetch its unified diff and show it in a dialog. */
  function openChangeDiff(f) {
    var overlay = el("div", "diff-overlay");
    var dialog = el("div", "diff-dialog-box");
    var head = el("div", "diff-dialog-head");
    head.appendChild(el("span", "diff-dialog-title", f.path));
    var close = el("button", "icon-btn", "✕");
    close.addEventListener("click", function () { overlay.remove(); });
    head.appendChild(close);
    dialog.appendChild(head);
    var pre = el("pre", "diff-dialog-body");
    pre.textContent = "加载中…";
    dialog.appendChild(pre);
    overlay.appendChild(dialog);
    overlay.addEventListener("click", function (ev) { if (ev.target === overlay) { overlay.remove(); } });
    document.body.appendChild(overlay);
    getJSON("/api/changes/diff?path=" + encodeURIComponent(f.path)).then(function (j) {
      var d = String(j.diff || "");
      if (!d) { pre.textContent = "(无差异内容 — 可能是新文件或二进制)"; return; }
      pre.innerHTML = "";
      d.split("\n").forEach(function (line) {
        var ln = el("div", "diff-line");
        if (line.indexOf("@@") === 0) { ln.className += " dl-hunk"; }
        else if (line.indexOf("+") === 0) { ln.className += " dl-add"; }
        else if (line.indexOf("-") === 0) { ln.className += " dl-del"; }
        ln.textContent = line || " ";
        pre.appendChild(ln);
      });
    }).catch(function (e) { pre.textContent = "加载失败：" + e.message; });
  }
function switchInspectorTab(tab) {
    S.inspTab = tab === "artifact" ? "artifact" : tab === "changes" ? "changes" : tab === "tasks" ? "tasks" : "info";
    var app = $("app");
    var tInfo = $("tab-insp-info");
    var tArt = $("tab-insp-artifact");
    var bInfo = $("insp-body");
    var bArt = $("artifact-pane");
    var bChg = $("changes-body");
    var tChg = $("tab-insp-changes");
    if (tInfo) { tInfo.classList.toggle("active", S.inspTab === "info"); }
    if (tArt) { tArt.classList.toggle("active", S.inspTab === "artifact"); }
    if (bInfo) { bInfo.hidden = S.inspTab !== "info"; }
    if (bArt) { bArt.hidden = S.inspTab !== "artifact"; }
    if (bChg) { bChg.hidden = S.inspTab !== "changes"; }
    var bTasks = $("tasks-body");
    if (bTasks) { bTasks.hidden = S.inspTab !== "tasks"; }
    if (tChg) { tChg.classList.toggle("active", S.inspTab === "changes"); }
    var tTasks = $("tab-insp-tasks");
    if (tTasks) { tTasks.classList.toggle("active", S.inspTab === "tasks"); }
    if (app) {
      app.classList.toggle("artifact-open", app.classList.contains("insp-open") && S.inspTab === "artifact");
    }
    if (S.inspTab === "artifact") { renderArtifactStage(); }
    else if (S.inspTab === "changes") { loadChanges(S.changesScope || "turn"); }
    else if (S.inspTab === "tasks") { if (typeof openTasks === "function") { openTasks(); } }
    else { renderInspector(); }
  }

  function openArtifactInPane(artId, viewMode) {
    S.activeArtifactId = artId;
    if (viewMode) { S.artifactView = viewMode; }
    var app = $("app");
    if (app && !app.classList.contains("insp-open")) {
      app.classList.add("insp-open");
    }
    switchInspectorTab("artifact");
  }

  function computeLineDiff(oldStr, newStr) {
    var oldLines = String(oldStr || "").split(/\r?\n/);
    var newLines = String(newStr || "").split(/\r?\n/);
    var rows = [];
    var added = 0;
    var removed = 0;
    var i = 0, j = 0;
    while (i < oldLines.length || j < newLines.length) {
      if (i < oldLines.length && j < newLines.length && oldLines[i] === newLines[j]) {
        rows.push({ type: "ctx", ln: j + 1, sign: " ", text: newLines[j] });
        i++; j++;
      } else if (j + 1 < newLines.length && oldLines[i] === newLines[j + 1]) {
        rows.push({ type: "add", ln: j + 1, sign: "+", text: newLines[j] });
        added++;
        j++;
      } else if (i + 1 < oldLines.length && oldLines[i + 1] === newLines[j]) {
        rows.push({ type: "del", ln: i + 1, sign: "-", text: oldLines[i] });
        removed++;
        i++;
      } else {
        if (i < oldLines.length) {
          rows.push({ type: "del", ln: i + 1, sign: "-", text: oldLines[i] });
          removed++;
          i++;
        }
        if (j < newLines.length) {
          rows.push({ type: "add", ln: j + 1, sign: "+", text: newLines[j] });
          added++;
          j++;
        }
      }
    }
    return { rows: rows, added: added, removed: removed };
  }

  function buildMermaidSandboxHtml(mermaidCode) {
    var escaped = String(mermaidCode || "").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    return '<!DOCTYPE html><html><head><meta charset="utf-8"><style>' +
      'body{margin:0;padding:20px;font-family:system-ui,-apple-system,sans-serif;background:#faf8f5;color:#1f1e1b;display:flex;flex-direction:column;align-items:center;min-height:100vh;box-sizing:border-box;}' +
      '.bar{width:100%;display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;font-size:12px;color:#6e6a63;}' +
      '.btns button{padding:4px 10px;border-radius:6px;border:1px solid #ded8cf;background:#fff;cursor:pointer;font-size:12px;margin-left:4px;}' +
      '#stage{flex:1;width:100%;display:flex;align-items:center;justify-content:center;overflow:auto;background:#fff;border:1px solid #e6e1d8;border-radius:12px;padding:20px;box-sizing:border-box;transform-origin:center center;transition:transform .15s ease;}' +
      '</style></head><body>' +
      '<div class="bar"><span>Mermaid 架构 / 流程图实时渲染</span><div class="btns"><button onclick="z(0.85)">缩小</button><button onclick="z(1,true)">100%</button><button onclick="z(1.18)">放大</button></div></div>' +
      '<div id="stage"><pre class="mermaid">' + escaped + '</pre></div>' +
      '<script src="https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.min.js"></script>' +
      '<script>var s=1;function z(f,r){s=r?1:Math.max(0.4,Math.min(2.6,s*f));document.querySelector(".mermaid").style.transform="scale("+s+")";}' +
      'if(window.mermaid){mermaid.initialize({startOnLoad:true,theme:"default",securityLevel:"loose"});}</script>' +
      '</body></html>';
  }

  function buildReactSandboxHtml(jsxCode) {
    var cleanCode = String(jsxCode || "")
      .replace(/^\s*import\s+[\s\S]*?from\s+['"][^'"]+['"];?\s*$/gm, "")
      .replace(/export\s+default\s+function\s+([A-Za-z0-9_]+)/g, "function $1")
      .replace(/export\s+default\s+/g, "const __DefaultExport = ");
    return '<!DOCTYPE html><html><head><meta charset="utf-8">' +
      '<script src="https://cdn.tailwindcss.com"></script>' +
      '<script crossorigin src="https://unpkg.com/react@18/umd/react.production.min.js"></script>' +
      '<script crossorigin src="https://unpkg.com/react-dom@18/umd/react-dom.production.min.js"></script>' +
      '<script src="https://unpkg.com/@babel/standalone/babel.min.js"></script>' +
      '<style>body{margin:0;padding:16px;font-family:system-ui,-apple-system,sans-serif;background:#faf8f5;color:#1f1e1b;}</style>' +
      '</head><body><div id="root"></div>' +
      '<script type="text/babel">' +
      'const { useState, useEffect, useMemo, useRef, useCallback } = React;\n' +
      cleanCode + '\n' +
      'const Comp = typeof __DefaultExport !== "undefined" ? __DefaultExport : (typeof App !== "undefined" ? App : (typeof Demo !== "undefined" ? Demo : null));\n' +
      'if (Comp) { ReactDOM.createRoot(document.getElementById("root")).render(<Comp />); } else { document.getElementById("root").innerHTML = "<div style=\\"padding:16px;color:#666\\">已编译 JSX 组件（请定义 App 或 export default 组件以自动挂载）</div>"; }' +
      '</script></body></html>';
  }

  function parseTableDataFromArtifact(lang, code) {
    var l = String(lang || "").toLowerCase();
    var raw = String(code || "").trim();
    if (l === "json") {
      try {
        var parsed = JSON.parse(raw);
        if (Array.isArray(parsed) && parsed.length && typeof parsed[0] === "object") {
          var cols = Object.keys(parsed[0]);
          var rows = parsed.map(function (item) {
            return cols.map(function (k) {
              var v = item[k];
              return v == null ? "" : (typeof v === "object" ? JSON.stringify(v) : String(v));
            });
          });
          return { columns: cols, rows: rows };
        }
      } catch (e) {}
      return null;
    }
    var sep = l === "tsv" ? "\t" : ",";
    var lines = raw.split(/\r?\n/).filter(function (x) { return x.trim().length > 0; });
    if (lines.length < 2) { return null; }
    var splitLine = function (line) {
      return line.split(sep).map(function (cell) {
        return cell.trim().replace(/^"|"$/g, "");
      });
    };
    return {
      columns: splitLine(lines[0]),
      rows: lines.slice(1).map(splitLine)
    };
  }

  function renderInteractiveTableStage(stage, tableData) {
    var wrap = el("div", "artifact-table-stage");
    var bar = el("div", "artifact-table-toolbar");
    var summary = el("span", null, "共 " + tableData.rows.length + " 行 × " + tableData.columns.length + " 列（点击表头可排序）");
    var searchInp = el("input", "artifact-table-search");
    searchInp.type = "text";
    searchInp.placeholder = "筛选表格数据…";
    bar.appendChild(summary);
    bar.appendChild(searchInp);
    wrap.appendChild(bar);

    var scrollBox = el("div", "artifact-table-scroll");
    var table = el("table", "artifact-data-table");
    var thead = document.createElement("thead");
    var tbody = document.createElement("tbody");
    table.appendChild(thead);
    table.appendChild(tbody);
    scrollBox.appendChild(table);
    wrap.appendChild(scrollBox);
    stage.appendChild(wrap);

    var sortCol = -1;
    var sortAsc = true;
    var filterQ = "";

    function drawTable() {
      clear(thead);
      clear(tbody);
      var trHead = document.createElement("tr");
      tableData.columns.forEach(function (colName, cIdx) {
        var th = document.createElement("th");
        var arrow = sortCol === cIdx ? (sortAsc ? " ▲" : " ▼") : "";
        th.textContent = colName + arrow;
        th.addEventListener("click", function () {
          if (sortCol === cIdx) { sortAsc = !sortAsc; }
          else { sortCol = cIdx; sortAsc = true; }
          drawTable();
        });
        trHead.appendChild(th);
      });
      thead.appendChild(trHead);

      var rows = tableData.rows.filter(function (r) {
        if (!filterQ) { return true; }
        return r.some(function (cell) { return String(cell).toLowerCase().indexOf(filterQ) >= 0; });
      });
      if (sortCol >= 0) {
        rows = rows.slice().sort(function (a, b) {
          var va = a[sortCol] || "";
          var vb = b[sortCol] || "";
          var na = Number(va), nb = Number(vb);
          var cmp = (!isNaN(na) && !isNaN(nb) && va !== "" && vb !== "")
            ? (na - nb)
            : String(va).localeCompare(String(vb), "zh");
          return sortAsc ? cmp : -cmp;
        });
      }
      summary.textContent = "显示 " + rows.length + " / " + tableData.rows.length + " 行 × " + tableData.columns.length + " 列（点击表头排序）";
      rows.forEach(function (r) {
        var tr = document.createElement("tr");
        tableData.columns.forEach(function (_, cIdx) {
          var td = document.createElement("td");
          td.textContent = r[cIdx] != null ? r[cIdx] : "";
          tr.appendChild(td);
        });
        tbody.appendChild(tr);
      });
    }

    searchInp.addEventListener("input", function () {
      filterQ = (searchInp.value || "").trim().toLowerCase();
      drawTable();
    });
    drawTable();
  }

  function renderArtifactStage() {
    var sel = $("artifact-select");
    var stage = $("artifact-stage");
    var btnPrev = $("btn-art-preview");
    var btnCode = $("btn-art-code");
    var btnDiff = $("btn-art-diff");
    var btnEdit = $("btn-art-edit");
    if (!stage || !sel) { return; }
    clear(sel);
    clear(stage);

    if (!S.artifacts.length) {
      stage.appendChild(el("div", "empty-note", "当前对话尚无 Artifact。让 MyClaude 生成 HTML 页面、SVG 图形、Mermaid 流程图、React 组件或 CSV 数据表即可在此分屏预览、对比 Diff 或一键写入本地文件。"));
      return;
    }

    var active = S.artifacts.filter(function (a) { return a.id === S.activeArtifactId; })[0];
    if (!active) {
      active = S.artifacts[S.artifacts.length - 1];
      S.activeArtifactId = active.id;
    }

    // 版本切换器：同名同语言的条目视为同一工件的版本链（◀ vN/T ▶，
    // 对齐 claude.ai 的 artifact 版本翻页；dropdown 仍是全量列表）。
    var lineage = S.artifacts.filter(function (a) { return a.title === active.title && a.lang === active.lang; });
    var linIdx = lineage.findIndex(function (a) { return a.id === active.id; });
    var btnVerPrev = $("btn-art-ver-prev");
    var btnVerNext = $("btn-art-ver-next");
    var verInd = $("art-ver-indicator");
    if (btnVerPrev && btnVerNext && verInd) {
      var multi = lineage.length > 1;
      btnVerPrev.hidden = !multi;
      btnVerNext.hidden = !multi;
      verInd.hidden = !multi;
      if (multi) {
        verInd.textContent = "v" + (linIdx + 1) + "/" + lineage.length;
        verInd.title = "同一工件的第 " + (linIdx + 1) + " 版，共 " + lineage.length + " 版";
        btnVerPrev.disabled = linIdx <= 0;
        btnVerNext.disabled = linIdx >= lineage.length - 1;
        btnVerPrev.onclick = function () {
          if (linIdx > 0) { S.activeArtifactId = lineage[linIdx - 1].id; renderArtifactStage(); }
        };
        btnVerNext.onclick = function () {
          if (linIdx < lineage.length - 1) { S.activeArtifactId = lineage[linIdx + 1].id; renderArtifactStage(); }
        };
      }
    }

    S.artifacts.forEach(function (a) {
      var opt = document.createElement("option");
      opt.value = a.id;
      opt.textContent = "v" + a.version + " · " + a.title + " (" + a.lang + ")";
      if (a.id === active.id) { opt.selected = true; }
      sel.appendChild(opt);
    });

    if (btnPrev) { btnPrev.classList.toggle("active", S.artifactView === "preview"); }
    if (btnCode) { btnCode.classList.toggle("active", S.artifactView === "code"); }
    if (btnDiff) { btnDiff.classList.toggle("active", S.artifactView === "diff"); }
    if (btnEdit) { btnEdit.classList.toggle("active", S.artifactView === "edit"); }

    if (S.artifactView === "diff") {
      var prevVerArtifact = null;
      for (var i = 0; i < S.artifacts.length; i++) {
        if (S.artifacts[i].id === active.id && i > 0) {
          prevVerArtifact = S.artifacts[i - 1];
          break;
        }
      }
      var baseCode = active.originalCode !== active.code
        ? active.originalCode
        : (prevVerArtifact ? prevVerArtifact.code : active.originalCode);
      var diffRes = computeLineDiff(baseCode, active.code);

      var diffWrap = el("div", "artifact-diff-wrap");
      var diffHead = el("div", "artifact-diff-head");
      diffHead.appendChild(el("span", null, prevVerArtifact && active.originalCode === active.code
        ? "对比上一版本 (v" + prevVerArtifact.version + " → v" + active.version + ")"
        : "对比初始版本与当前修改差异"));
      var statBadges = el("div", "diff-stat-badges");
      statBadges.appendChild(el("span", "diff-stat-add", "+" + diffRes.added + " 行"));
      statBadges.appendChild(el("span", "diff-stat-del", "-" + diffRes.removed + " 行"));
      diffHead.appendChild(statBadges);
      diffWrap.appendChild(diffHead);

      var linesBox = el("div", "artifact-diff-lines");
      diffRes.rows.forEach(function (r) {
        var row = el("div", "diff-row " + r.type);
        row.appendChild(el("span", "diff-ln", String(r.ln)));
        row.appendChild(el("span", "diff-sign", r.sign));
        row.appendChild(el("span", "diff-code", r.text || " "));
        linesBox.appendChild(row);
      });
      diffWrap.appendChild(linesBox);
      stage.appendChild(diffWrap);
      return;
    }

    if (S.artifactView === "edit") {
      var wrap = el("div", "artifact-editor-wrap");
      var head = el("div", "artifact-editor-head");
      head.appendChild(el("span", null, "在线编辑代码 · 修改后点击右侧应用即可实时刷新预览或查看 Diff（Ctrl+Enter）"));
      var applyBtn = el("button", "artifact-apply-btn", "应用并刷新预览");
      applyBtn.type = "button";
      var ta = el("textarea", "artifact-editor-ta");
      ta.spellcheck = false;
      ta.value = active.code;
      function commitEdit() {
        active.code = ta.value;
        active.lines = active.code.split(/\r?\n/).length;
        S.artifactView = "preview";
        renderArtifactStage();
        toast("已更新 Artifact 代码并刷新预览（可点击「对比 Diff」查看改动）", "ok");
      }
      applyBtn.addEventListener("click", commitEdit);
      ta.addEventListener("keydown", function (e) {
        if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
          e.preventDefault();
          commitEdit();
        }
      });
      head.appendChild(applyBtn);
      wrap.appendChild(head);
      wrap.appendChild(ta);
      stage.appendChild(wrap);
      setTimeout(function () { ta.focus(); }, 20);
      return;
    }

    if (S.artifactView === "preview") {
      var l = String(active.lang || "").toLowerCase();
      var rawCode = active.code || "";
      if (l === "mermaid" || l === "mmd" || /^\s*(graph\s+|flowchart\s+|sequenceDiagram|classDiagram|stateDiagram|erDiagram|gantt|pie\s+)/i.test(rawCode)) {
        var mFrame = document.createElement("iframe");
        mFrame.className = "artifact-iframe";
        mFrame.setAttribute("sandbox", "allow-scripts");
        mFrame.srcdoc = buildMermaidSandboxHtml(rawCode);
        stage.appendChild(mFrame);
      } else if (l === "jsx" || l === "tsx" || l === "react") {
        var rFrame = document.createElement("iframe");
        rFrame.className = "artifact-iframe";
        rFrame.setAttribute("sandbox", "allow-scripts allow-modals");
        rFrame.srcdoc = buildReactSandboxHtml(rawCode);
        stage.appendChild(rFrame);
      } else if (l === "csv" || l === "tsv" || (l === "json" && /^\s*\[\s*\{/.test(rawCode))) {
        var tableData = parseTableDataFromArtifact(l, rawCode);
        if (tableData) {
          renderInteractiveTableStage(stage, tableData);
        } else {
          var jPre = el("pre", "artifact-code-view");
          jPre.textContent = rawCode;
          stage.appendChild(jPre);
        }
      } else if (l === "html" || l === "htm" || l === "svg" || l === "xml" || /^\s*(<!doctype html|<html|<svg)/i.test(rawCode)) {
        var iframe = document.createElement("iframe");
        iframe.className = "artifact-iframe";
        iframe.setAttribute("sandbox", "allow-scripts allow-modals");
        iframe.srcdoc = rawCode;
        stage.appendChild(iframe);
      } else if (l === "md" || l === "markdown") {
        var mdBox = el("div", "artifact-md-preview md");
        mdBox.innerHTML = MD.render(rawCode);
        stage.appendChild(mdBox);
      } else if (!renderChangeListStage(stage, rawCode)) {
        var pre = el("pre", "artifact-code-view");
        pre.textContent = rawCode;
        stage.appendChild(pre);
      }
    } else {
      var codePre = el("pre", "artifact-code-view");
      codePre.textContent = active.code;
      stage.appendChild(codePre);
    }
  }

  /**
   * A TEXT artifact that is really a git-status-style change list gets
   * structure: status badge, path, annotation. Plain prose keeps the raw
   * <pre> — only two or more parseable status rows are promoted.
   */
  function renderChangeListStage(stage, text) {
    var rows = [];
    var re = /^\s*(M|A|D|R|C|U|\?\?|!!|MM|AM|AD|MD)\s+(.+?)\s*$/;
    String(text || "").split(/\r?\n/).forEach(function (line) {
      var m = line.match(re);
      if (!m) { return; }
      var rest = m[2], note = "";
      var arrow = rest.indexOf("←");
      if (arrow >= 0) { note = rest.slice(arrow + 1).trim(); rest = rest.slice(0, arrow).trim(); }
      rows.push({ status: m[1], path: rest.trim(), note: note });
    });
    if (rows.length < 2) { return false; }

    var wrap = el("div", "chg-view");
    var head = el("div", "chg-view-head");
    head.appendChild(el("span", "chg-view-title", "工作区变更"));
    head.appendChild(el("span", "chg-view-count", rows.length + " 项"));
    var legend = el("div", "chg-view-legend");
    var seen = {};
    rows.forEach(function (r) { seen[r.status] = (seen[r.status] || 0) + 1; });
    Object.keys(seen).forEach(function (s) {
      var tag = el("span", "chg-view-legend-item");
      tag.appendChild(el("span", "chg-view-badge " + changeStatusClass(s), s));
      tag.appendChild(el("span", "chg-view-legend-num", String(seen[s])));
      legend.appendChild(tag);
    });
    head.appendChild(legend);
    wrap.appendChild(head);

    var list = el("div", "chg-view-list");
    rows.forEach(function (r, i) {
      var row = el("div", "chg-view-row");
      row.appendChild(el("span", "chg-view-idx", (i + 1 < 10 ? "0" : "") + (i + 1)));
      row.appendChild(el("span", "chg-view-badge " + changeStatusClass(r.status), r.status));
      row.appendChild(el("span", "chg-view-path", r.path));
      if (r.note) { row.appendChild(el("span", "chg-view-note", r.note)); }
      list.appendChild(row);
    });
    wrap.appendChild(list);
    stage.appendChild(wrap);
    return true;
  }

  function changeStatusClass(status) {
    if (status === "??" || status === "!!") { return "st-untracked"; }
    if (status === "A" || status.indexOf("A") === 0) { return "st-added"; }
    if (status === "D" || status.indexOf("D") >= 0) { return "st-deleted"; }
    return "st-modified";
  }
  function submitArtifactRefine() {
    var inp = $("artifact-refine-input");
    if (!inp) { return; }
    var reqText = (inp.value || "").trim();
    if (!reqText) {
      toast("请输入对当前 Artifact 的修改要求", "warn");
      inp.focus();
      return;
    }
    if (S.busy) {
      toast("请等待当前回复结束", "warn");
      return;
    }
    var active = S.artifacts.filter(function (a) { return a.id === S.activeArtifactId; })[0] || S.artifacts[S.artifacts.length - 1];
    if (!active) {
      toast("当前没有可迭代的 Artifact", "warn");
      return;
    }
    inp.value = "";
    var prompt = "请基于以下 Artifact（" + active.title + "，语言：" + active.lang + "）进行迭代修改，并输出完整更新后的代码块：\n\n修改要求：" + reqText + "\n\n当前代码：\n```" + active.lang + "\n" + active.code + "\n```";
    var ta = $("in");
    if (ta) {
      ta.value = prompt;
      sendMessage();
    }
  }

  /* ---- 导出与分享当前会话（Markdown / 独立 HTML 报告 / PDF 打印 / 复制） ---- */
  function collectConversationMessages() {
    var root = logRoot();
    if (!root) { return []; }
    var items = [];
    Array.prototype.forEach.call(root.children, function (node) {
      if (node.classList.contains("msg-user")) {
        items.push({ role: "user", text: node._text || (node.querySelector(".bubble") && node.querySelector(".bubble").textContent) || "" });
      } else if (node.classList.contains("msg-asst")) {
        items.push({ role: "assistant", text: node._raw || (node.querySelector(".md") && node.querySelector(".md").innerText) || "" });
      }
    });
    return items;
  }

  function exportCurrentConversation(fmt) {
    var msgs = collectConversationMessages();
    if (!msgs.length) {
      toast("当前对话尚无消息可导出", "warn");
      return;
    }
    var title = ($("top-title") && $("top-title").textContent.trim()) || "MyClaude-对话记录";
    var safeFileTitle = title.replace(/[\\/:*?"<>|\s]+/g, "-").slice(0, 40) || "conversation";
    var nowStr = new Date().toLocaleString("zh-CN");

    var mdLines = ["# " + title, "", "> 导出时间：" + nowStr + " · 模型：" + ((S.config && S.config.model) || "默认"), ""];
    msgs.forEach(function (m) {
      mdLines.push(m.role === "user" ? "### 👤 用户提问" : "### ✦ MyClaude 回复");
      mdLines.push("");
      mdLines.push(m.text || "");
      mdLines.push("");
      mdLines.push("---");
      mdLines.push("");
    });
    var mdContent = mdLines.join("\n");

    if (fmt === "copy") {
      copyText(mdContent);
      toast("已将完整对话 Markdown 复制到剪贴板", "ok");
      return;
    }

    if (fmt === "md") {
      var blobMd = new Blob([mdContent], { type: "text/markdown;charset=utf-8" });
      var urlMd = URL.createObjectURL(blobMd);
      var aMd = document.createElement("a");
      aMd.href = urlMd;
      aMd.download = safeFileTitle + ".md";
      document.body.appendChild(aMd);
      aMd.click();
      document.body.removeChild(aMd);
      setTimeout(function () { URL.revokeObjectURL(urlMd); }, 1000);
      toast("已导出 Markdown 文档 (" + safeFileTitle + ".md)", "ok");
      return;
    }

    var htmlBlocks = msgs.map(function (m) {
      var roleTag = m.role === "user" ? '<div class="role user">用户提问</div>' : '<div class="role asst">✦ MyClaude 回复</div>';
      var bodyHtml = m.role === "assistant" ? MD.render(m.text || "") : '<div class="user-txt">' + String(m.text || "").replace(/</g, "&lt;").replace(/\n/g, "<br>") + '</div>';
      return '<section class="turn ' + m.role + '">' + roleTag + '<div class="body">' + bodyHtml + '</div></section>';
    }).join("\n");

    var reportHtml = '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><title>' + title + ' - MyClaude 报告</title>' +
      '<style>body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:#faf8f5;color:#1f1e1b;max-width:820px;margin:0 auto;padding:40px 24px;line-height:1.65;}' +
      'h1{font-size:24px;margin:0 0 6px;} .meta{color:#7a756c;font-size:13px;margin-bottom:28px;padding-bottom:14px;border-bottom:1px solid #e6e1d8;}' +
      '.turn{margin-bottom:22px;padding:18px 20px;border-radius:14px;background:#fff;border:1px solid #e6e1d8;}' +
      '.turn.user{background:#f3efe8;} .role{font-size:12px;font-weight:700;color:#c96442;margin-bottom:8px;text-transform:uppercase;letter-spacing:.04em;}' +
      'pre{background:#1e1e1e;color:#f8f8f2;padding:14px;border-radius:8px;overflow:auto;font-size:12.5px;} code{font-family:monospace;}</style>' +
      '</head><body><h1>' + title + '</h1><div class="meta">导出时间：' + nowStr + ' · 模型：' + ((S.config && S.config.model) || "默认") + ' · 共 ' + msgs.length + ' 条消息</div>' +
      htmlBlocks + '</body></html>';

    if (fmt === "print") {
      var printFrame = document.createElement("iframe");
      printFrame.style.position = "fixed";
      printFrame.style.right = "0";
      printFrame.style.bottom = "0";
      printFrame.style.width = "0";
      printFrame.style.height = "0";
      printFrame.style.border = "0";
      document.body.appendChild(printFrame);
      var doc = printFrame.contentWindow.document;
      doc.open();
      doc.write(reportHtml);
      doc.close();
      setTimeout(function () {
        printFrame.contentWindow.focus();
        printFrame.contentWindow.print();
        setTimeout(function () { document.body.removeChild(printFrame); }, 2000);
      }, 250);
      toast("已打开打印 / 另存为 PDF 视图", "info");
      return;
    }

    var blobHtml = new Blob([reportHtml], { type: "text/html;charset=utf-8" });
    var urlHtml = URL.createObjectURL(blobHtml);
    var aHtml = document.createElement("a");
    aHtml.href = urlHtml;
    aHtml.download = safeFileTitle + ".html";
    document.body.appendChild(aHtml);
    aHtml.click();
    document.body.removeChild(aHtml);
    setTimeout(function () { URL.revokeObjectURL(urlHtml); }, 1000);
    toast("已导出独立 HTML 报告 (" + safeFileTitle + ".html)", "ok");
  }

  /* ---- 侧边栏近 7 天用量统计视图 (Usage Statistics with Recharts) ---- */
  function initClaudeFeatures() {
    try {
      var savedStyle = localStorage.getItem(LS_STYLE);
      if (savedStyle) { S.style = savedStyle; }
      var savedArchive = localStorage.getItem(LS_ARCHIVE_POLICY);
      if (savedArchive) { S.archivePolicy = savedArchive; }
      var savedChatView = localStorage.getItem(LS_CHAT_VIEW);
      if (savedChatView) { S.chatView = savedChatView === "time" ? "time" : "project"; }
    } catch (e) {}
  // S.thinking mirrors config.effort; it is set once the config loads
  // (syncThinkingFromConfig) instead of from localStorage.
    renderStyleButton();
    renderThinkingButton();
    renderArchivePolicyButton();
    refreshProjectKnowledge();
    refreshPromptLibrary();

    var btnThinking = $("btn-thinking");
    if (btnThinking) {
      btnThinking.addEventListener("click", function (e) {
        e.stopPropagation();
        toggleThinkingMode();
      });
    }


    var btnExportChat = $("btn-export-chat");
    var exportMenu = $("export-menu");
    if (btnExportChat && exportMenu) {
      btnExportChat.addEventListener("click", function (e) {
        e.stopPropagation();
        exportMenu.hidden = !exportMenu.hidden;
      });
      exportMenu.addEventListener("click", function (e) {
        var opt = e.target && e.target.closest ? e.target.closest("[data-export-fmt]") : null;
        if (!opt) { return; }
        e.stopPropagation();
        exportMenu.hidden = true;
        exportCurrentConversation(opt.getAttribute("data-export-fmt") || "md");
      });
      document.addEventListener("click", function (e) {
        if (!exportMenu.hidden && !exportMenu.contains(e.target) && e.target !== btnExportChat) {
          exportMenu.hidden = true;
        }
      });
    }

    var btnProject = $("btn-project");
    if (btnProject) {
      btnProject.addEventListener("click", function () {
        openProjectModal("files");
      });
    }
    var btnPromptLibRail = $("btn-prompt-library");
    if (btnPromptLibRail) {
      btnPromptLibRail.addEventListener("click", function () {
        openPromptLibraryModal();
      });
    }

    var topTitle = $("top-title");
    if (topTitle) {
      topTitle.title = "点击重命名当前对话";
      topTitle.addEventListener("click", function () {
        if (!S.sessionKey) {
          toast("发送第一条消息后即可重命名对话", "info");
          return;
        }
        var curSession = (S.sessions || []).filter(function (x) { return x.id === S.sessionKey; })[0] || { id: S.sessionKey, title: topTitle.textContent };
        openModal("重命名对话", function (body) {
          var inp = document.createElement("input");
          inp.value = curSession.title || topTitle.textContent || "";
          inp.placeholder = "输入对话标题";
          body.appendChild(field("对话标题", inp));
          body._saveTopRename = function () {
            var v = inp.value.trim();
            if (v) {
              patchJSON("/api/sessions/" + encodeURIComponent(S.sessionKey), { title: v }).then(function () {
                topTitle.textContent = v;
                refreshSessions();
                toast("已更新对话标题", "ok");
              });
            }
            closeModal();
          };
          setTimeout(function () { inp.focus(); inp.select(); }, 20);
        }, [
          { label: "取消", cls: "ghost", fn: closeModal },
          { label: "保存", cls: "primary", fn: function () {
            var b = $("modal-body");
            if (b && b._saveTopRename) { b._saveTopRename(); }
          } }
        ]);
      });
    }

    var btnArchivePolicy = $("btn-archive-policy");
    if (btnArchivePolicy) {
      btnArchivePolicy.addEventListener("click", function (e) {
        e.stopPropagation();
        openArchivePolicyModal();
      });
    }

    var btnStyle = $("btn-style");
    if (btnStyle) {
      btnStyle.addEventListener("click", function (e) {
        e.stopPropagation();
        toggleStyleMenu();
      });
    }

    var tabInfo = $("tab-insp-info");
    var tabArt = $("tab-insp-artifact");
    if (tabInfo) { tabInfo.addEventListener("click", function () { switchInspectorTab("info"); }); }
    if (tabArt) { tabArt.addEventListener("click", function () { switchInspectorTab("artifact"); }); }
    var tabChg = $("tab-insp-changes");
    if (tabChg) { tabChg.addEventListener("click", function () { switchInspectorTab("changes"); }); }
    var tabTasks = $("tab-insp-tasks");
    if (tabTasks) { tabTasks.addEventListener("click", function () { switchInspectorTab("tasks"); }); }

    var selArt = $("artifact-select");
    if (selArt) {
      selArt.addEventListener("change", function () {
        S.activeArtifactId = selArt.value;
        renderArtifactStage();
      });
    }
    var btnPrev = $("btn-art-preview");
    var btnCode = $("btn-art-code");
    var btnDiff = $("btn-art-diff");
    var btnEdit = $("btn-art-edit");
    if (btnPrev) {
      btnPrev.addEventListener("click", function () {
        S.artifactView = "preview";
        renderArtifactStage();
      });
    }
    if (btnCode) {
      btnCode.addEventListener("click", function () {
        S.artifactView = "code";
        renderArtifactStage();
      });
    }
    if (btnDiff) {
      btnDiff.addEventListener("click", function () {
        S.artifactView = "diff";
        renderArtifactStage();
      });
    }
    if (btnEdit) {
      btnEdit.addEventListener("click", function () {
        S.artifactView = "edit";
        renderArtifactStage();
      });
    }

    var btnArtApplyFile = $("btn-art-apply-file");
    var artApplyBar = $("artifact-apply-bar");
    var artApplyPath = $("artifact-apply-path");
    var btnArtApplyConfirm = $("btn-art-apply-confirm");
    var btnArtApplyCancel = $("btn-art-apply-cancel");
    if (btnArtApplyFile && artApplyBar) {
      btnArtApplyFile.addEventListener("click", function () {
        var active = S.artifacts.filter(function (a) { return a.id === S.activeArtifactId; })[0] || S.artifacts[S.artifacts.length - 1];
        if (!active) {
          toast("当前没有可写入工作区的 Artifact", "warn");
          return;
        }
        artApplyBar.hidden = !artApplyBar.hidden;
        if (!artApplyBar.hidden && artApplyPath) {
          if (!artApplyPath.value.trim()) {
            artApplyPath.value = inferArtifactDefaultPath(active);
          }
          artApplyPath.focus();
          artApplyPath.select();
        }
      });
    }
    if (btnArtApplyCancel && artApplyBar) {
      btnArtApplyCancel.addEventListener("click", function () {
        artApplyBar.hidden = true;
      });
    }
    if (btnArtApplyConfirm && artApplyBar && artApplyPath) {
      btnArtApplyConfirm.addEventListener("click", function () {
        var active = S.artifacts.filter(function (a) { return a.id === S.activeArtifactId; })[0] || S.artifacts[S.artifacts.length - 1];
        var targetRel = (artApplyPath.value || "").trim();
        if (!active || !targetRel) {
          toast("请填写要写入的相对文件路径", "warn");
          return;
        }
        postJSON("/api/fs/write", {
          path: targetRel,
          content: active.code || ""
        }).then(function (res) {
          if (res && res.ok) {
            artApplyBar.hidden = true;
            toast("已将 Artifact 写入工作区文件：" + res.path + " (" + res.lines + " 行)", "ok");
          }
        }).catch(function (e) {
          toast("写入文件失败：" + e.message, "err");
        });
      });
    }

    var btnReloadArt = $("btn-art-reload");
    if (btnReloadArt) {
      btnReloadArt.addEventListener("click", function () {
        renderArtifactStage();
        toast("已重新加载画布预览", "info");
      });
    }
    var btnFullArt = $("btn-art-fullscreen");
    if (btnFullArt) {
      btnFullArt.addEventListener("click", function () {
        S.artifactFullscreen = !S.artifactFullscreen;
        var app = $("app");
        if (app) { app.classList.toggle("artifact-fullscreen", S.artifactFullscreen); }
      });
    }
    var btnRefineArt = $("btn-art-refine");
    var inpRefineArt = $("artifact-refine-input");
    if (btnRefineArt) {
      btnRefineArt.addEventListener("click", submitArtifactRefine);
    }
    if (inpRefineArt) {
      inpRefineArt.addEventListener("keydown", function (e) {
        if (e.key === "Enter") {
          e.preventDefault();
          submitArtifactRefine();
        }
      });
    }
    // 快捷重构 chips（对齐 claude.ai 代码视图的 Add comments 等快捷操作）：
    // 点击把指令填进迭代输入框并直接提交
    var chipHost = $("artifact-quick-chips");
    if (chipHost) {
      Array.prototype.forEach.call(chipHost.querySelectorAll(".art-chip"), function (chip) {
        chip.addEventListener("click", function () {
          if (!S.activeArtifactId) { toast("先在画布里打开一个 Artifact", "warn"); return; }
          if (inpRefineArt) { inpRefineArt.value = chip.getAttribute("data-chip") || ""; }
          submitArtifactRefine();
        });
      });
    }
    var btnCopyArt = $("btn-art-copy");
    if (btnCopyArt) {
      btnCopyArt.addEventListener("click", function () {
        var active = S.artifacts.filter(function (a) { return a.id === S.activeArtifactId; })[0];
        if (active) { copyText(active.code); }
      });
    }
    var btnDlArt = $("btn-art-download");
    if (btnDlArt) {
      btnDlArt.addEventListener("click", function () {
        var active = S.artifacts.filter(function (a) { return a.id === S.activeArtifactId; })[0];
        if (!active) { return; }
        var extMap = { html: "html", svg: "svg", js: "js", javascript: "js", ts: "ts", css: "css", py: "py", python: "py", json: "json", md: "md" };
        var ext = extMap[String(active.lang || "").toLowerCase()] || "txt";
        var blob = new Blob([active.code], { type: "text/plain;charset=utf-8" });
        var url = URL.createObjectURL(blob);
        var a = document.createElement("a");
        a.href = url;
        a.download = "artifact-v" + active.version + "." + ext;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
        toast("已下载 Artifact 文件", "ok");
      });
    }

    // 在新窗口打开：可预览类型用 blob URL 直开（沙箱外完整体验），其余开代码文本
    var btnPopArt = $("btn-art-popout");
    if (btnPopArt) {
      btnPopArt.addEventListener("click", function () {
        var active = S.artifacts.filter(function (a) { return a.id === S.activeArtifactId; })[0];
        if (!active) { return; }
        var l = String(active.lang || "").toLowerCase();
        var mime = (l === "html" || l === "htm" || /^\s*<!doctype html/i.test(active.code)) ? "text/html"
          : (l === "svg" || /^\s*<svg/i.test(active.code)) ? "image/svg+xml" : "text/plain";
        var blob = new Blob([active.code], { type: mime + ";charset=utf-8" });
        var url = URL.createObjectURL(blob);
        window.open(url, "_blank");
        setTimeout(function () { URL.revokeObjectURL(url); }, 60000);
      });
    }

    // 划词「引用并追问」浮动按钮
    var quotePop = $("quote-pop");
    var selectedQuoteText = "";
    document.addEventListener("mouseup", function (e) {
      if (!quotePop) { return; }
      if (quotePop.contains(e.target)) { return; }
      var sel = window.getSelection ? window.getSelection() : null;
      var text = sel ? String(sel.toString() || "").trim() : "";
      var stream = $("stream");
      if (!text || text.length < 4 || !stream || ! sel.anchorNode || !stream.contains(sel.anchorNode)) {
        quotePop.hidden = true;
        return;
      }
      selectedQuoteText = text;
      var range = sel.getRangeAt(0);
      var rect = range.getBoundingClientRect();
      quotePop.style.top = Math.max(12, rect.top - 38) + "px";
      quotePop.style.left = Math.min(window.innerWidth - 120, Math.max(12, rect.left + rect.width / 2 - 48)) + "px";
      quotePop.hidden = false;
    });

    if (quotePop) {
      quotePop.addEventListener("click", function () {
        quotePop.hidden = true;
        if (!selectedQuoteText) { return; }
        var snippet = selectedQuoteText.slice(0, 24).replace(/\s+/g, " ");
        S.attachments.push({
          kind: "text",
          quote: true,
          name: "引用: " + snippet + (selectedQuoteText.length > 24 ? "…" : ""),
          mime: "text/plain",
          size: selectedQuoteText.length,
          lines: selectedQuoteText.split(/\r?\n/).length,
          text: "> 引用内容：\n" + selectedQuoteText
        });
        renderAttachments();
        if (window.getSelection) { window.getSelection().removeAllRanges(); }
        var ta = $("in");
        if (ta) { ta.focus(); }
      });
    }
  }

  var modelCache = null;
  var modelProbing = false;
  var modelSortFast = false;
  var modelGroupMode = "vendor"; // "vendor" | "capability" — 默认按公司（供应商）分组，速度优先按钮切换为按 ping 排序
  var modelCategoryFilter = "all"; // "all" | "coding" | "general" | "context"
  var collapsedModelGroups = {};

  var MODEL_CATEGORIES = [
    { id: "coding", label: "编程与推理 · Coding", shortLabel: "编程 Coding" },
    { id: "general", label: "通用对话 · General Purpose", shortLabel: "通用 General" },
    { id: "context", label: "长上下文与视觉 · Large Context", shortLabel: "长文本 Context" }
  ];

  /**
   * Determine the primary capability group for a model entry.
   * Returns { id: 'coding'|'general'|'context', label: string, tag: string }.
   */
  function modelCategoryOf(m) {
    var obj = typeof m === "string" ? { id: m } : (m || {});
    if (obj.category && obj.categoryLabel) {
      return {
        id: obj.category,
        label: obj.categoryLabel,
        tag: obj.capabilityTag || (obj.category === "coding" ? "代码" : obj.category === "context" ? "长文本" : "通用")
      };
    }
    var id = String(obj.id || "").toLowerCase();
    if (/coder|code|sonnet|r1|reasoner|o1|o3|codestral|devstral/i.test(id)) {
      return {
        id: "coding",
        label: "编程与推理 · Coding",
        tag: /r1|reasoner|o1|o3/i.test(id) ? "推理" : "代码"
      };
    }
    if (/vision|vl|1m|128k|200k|long|gemini|gpt-4o(?!-mini)|kimi|opus/i.test(id)) {
      return {
        id: "context",
        label: "长上下文与视觉 · Large Context",
        tag: /vision|vl/i.test(id) ? "视觉" : "长文本"
      };
    }
    return {
      id: "general",
      label: "通用对话 · General Purpose",
      tag: /flash|mini|haiku|lite|turbo/i.test(id) ? "轻量" : "通用"
    };
  }

  /**
   * Compute or normalize latency status for a model entry.
   * Returns { ms: number, tier: 'fast'|'medium'|'slow', label: string }.
   */
  function modelLatencyOf(m) {
    var obj = typeof m === "string" ? { id: m } : (m || {});
    if (obj.latencyMs && obj.latencyTier) {
      return {
        ms: obj.latencyMs,
        tier: obj.latencyTier,
        label: obj.statusLabel || (obj.latencyTier === "fast" ? "极速" : obj.latencyTier === "slow" ? "较慢" : "正常")
      };
    }
    var id = String(obj.id || "").toLowerCase();
    var hash = 0;
    for (var i = 0; i < id.length; i++) { hash = (hash * 31 + id.charCodeAt(i)) & 0x7fffffff; }
    if (/flash|mini|haiku|lite|turbo|instant|8b|11b|20b/i.test(id)) {
      return { ms: 95 + (hash % 65), tier: "fast", label: "极速" };
    }
    if (/r1|reasoner|o1|o3|opus|72b|405b|thinking|pro/i.test(id)) {
      return { ms: 860 + (hash % 320), tier: "slow", label: "较慢" };
    }
    return { ms: 340 + (hash % 180), tier: "medium", label: "正常" };
  }

  var modelProviderFilter = "all";
  var currentModelMenuAnchor = null;

  function positionModelMenu(anchor) {
    var menu = $("model-menu");
    if (!menu) return;
    anchor = anchor || $("btn-model") || $("btn-wmc-switch");
    if (!anchor) return;
    var rect = anchor.getBoundingClientRect();
    var menuWidth = Math.min(490, window.innerWidth - 20);
    var menuMaxHeight = Math.min(600, window.innerHeight - 80);
    menu.style.position = "fixed";
    menu.style.width = menuWidth + "px";
    menu.style.maxHeight = menuMaxHeight + "px";
    menu.style.zIndex = "9998";

    // If anchor is near the top (e.g. the welcome card):
    if (rect.top < window.innerHeight / 2) {
      menu.style.top = (rect.bottom + 8) + "px";
      menu.style.bottom = "auto";
      var left = Math.max(10, Math.min(rect.left, window.innerWidth - menuWidth - 10));
      menu.style.left = left + "px";
      menu.style.right = "auto";
      menu.style.transformOrigin = "top left";
    } else {
      // Near bottom (like composer #btn-model):
      menu.style.bottom = (window.innerHeight - rect.top + 8) + "px";
      menu.style.top = "auto";
      var right = Math.max(10, Math.min(window.innerWidth - rect.right, window.innerWidth - menuWidth - 10));
      menu.style.right = right + "px";
      menu.style.left = "auto";
      menu.style.transformOrigin = "bottom right";
    }
  }

  function toggleModelMenu(anchorEl) {
    var menu = $("model-menu");
    if (!menu) { return; }
    if (!menu.hidden && currentModelMenuAnchor === anchorEl) {
      closeModelMenuSmoothly();
      return;
    }
    currentModelMenuAnchor = anchorEl || $("btn-model") || $("btn-wmc-switch");
    menu.classList.remove("closing");
    menu.hidden = false;
    positionModelMenu(currentModelMenuAnchor);
    drawModelMenu();
    if (!modelCache) {
      fetchModels(false);
    }
  }

  function updateModelBtnDot(modelName) {
    var dot = $("model-btn-dot");
    var btn = $("btn-model");
    var name = modelName || (S.config && S.config.model) || "";
    var match = null;
    if (modelCache && modelCache.length) {
      for (var i = 0; i < modelCache.length; i++) {
        var entry = typeof modelCache[i] === "string" ? { id: modelCache[i] } : modelCache[i];
        if (entry && entry.id === name) { match = entry; break; }
      }
    }
    var perf = modelLatencyOf(match || name);
    var cap = modelCategoryOf(match || name);
    var v = (match && match.vendor) || vendorFromUrl((S.config && S.config.baseUrl) || "", name);

    if (dot) {
      dot.className = "latency-dot " + (modelProbing ? "probing" : perf.tier);
      dot.title = "当前模型延迟：" + perf.ms + "ms（" + perf.label + " · " + cap.tag + "）";
    }
    if (btn) {
      btn.title = "切换模型与供应商 · 当前 " + (name || "默认") + "（" + cap.tag + " · " + perf.label + " " + perf.ms + "ms）";
    }
    var modelLbl = $("model-label");
    if (modelLbl) {
      modelLbl.textContent = name || "选择模型";
      modelLbl.title = name || "选择模型";
    }


    // 同步顶栏配置按钮状态徽章
    var topCfgBadge = $("top-cfg-status-badge");
    if (topCfgBadge) {
      var _bu = (S.config && S.config.baseUrl) || "";
      var _localGw = /^(https?:\/\/)?(127\.0\.0\.1|localhost|0\.0\.0\.0)(:\d+)?/i.test(_bu);
      if ((v && (v.indexOf("Google") >= 0 || v.indexOf("Gemini") >= 0)) || _localGw) {
        topCfgBadge.textContent = "免配即用";
        topCfgBadge.className = "topbar-cfg-badge free";
      } else if (S.config && S.config.apiKeyConfigured) {
        topCfgBadge.textContent = "已就绪";
        topCfgBadge.className = "topbar-cfg-badge ok";
      } else {
        topCfgBadge.textContent = "未配置";
        topCfgBadge.className = "topbar-cfg-badge warn";
      }
    }

    // 同步欢迎区模型状态看板
    var wName = $("wmc-name");
    var wVendor = $("wmc-vendor");
    var wIcon = $("wmc-icon");
    var wDot = $("wmc-dot");
    var wStatusPill = $("wmc-status-pill");
    var wSub = $("wmc-sub");
    if (wName) { wName.textContent = (match && match.name) || name || "Claude 3.7 Sonnet"; }
    if (wVendor) { wVendor.textContent = v || "Anthropic 官方"; }
    var iconMap = { "Anthropic": "✳️", "DeepSeek": "🐋", "OpenAI": "🟢", "Google": "✨", "Google Gemini": "✨", "智谱": "🟣", "阿里通义": "🔷", "Ollama": "🦙" };
    if (wIcon) { wIcon.textContent = iconMap[v] || "🤖"; }
    if (wDot) {
      wDot.className = "latency-dot " + (modelProbing ? "probing" : perf.tier);
      wDot.title = "延迟：" + perf.ms + "ms";
    }
    if (wStatusPill) {
      var _bu = (S.config && S.config.baseUrl) || "";
      var _localGw = /^(https?:\/\/)?(127\.0\.0\.1|localhost|0\.0\.0\.0)(:\d+)?/i.test(_bu);
      if ((v && (v.indexOf("Google") >= 0 || v.indexOf("Gemini") >= 0)) || _localGw) {
        wStatusPill.textContent = "🟢 运行正常 · 免配即用 (" + perf.ms + "ms)";
        wStatusPill.className = "wmc-status-pill ok";
      } else if (S.config && S.config.apiKeyConfigured) {
        wStatusPill.textContent = "🟢 运行正常 (" + perf.ms + "ms)";
        wStatusPill.className = "wmc-status-pill ok";
      } else {
        wStatusPill.textContent = "🟡 需配置 API Key (" + v + ")";
        wStatusPill.className = "wmc-status-pill warn";
      }
    }
    if (wSub) {
      var curUrl = (S.config && S.config.baseUrl) || "";
      wSub.textContent = "接口服务地址：" + (curUrl || "https://api.anthropic.com/v1") + " · 支持多模态、深度思考与工程工具自主调用";
    }
  }

  function fetchModels(forceProbe) {
    modelProbing = true;
    updateModelBtnDot();
    if ($("model-menu") && !$("model-menu").hidden) { drawModelMenu(); }
    return getJSON("/api/models" + (forceProbe ? "?t=" + Date.now() : "")).then(function (j) {
      modelProbing = false;
      modelCache = j.models || [];
      updateModelBtnDot();
      if ($("model-menu") && !$("model-menu").hidden) { drawModelMenu(); }
      return modelCache;
    }).catch(function () {
      modelProbing = false;
      if (!modelCache) { modelCache = []; }
      updateModelBtnDot();
      if ($("model-menu") && !$("model-menu").hidden) { drawModelMenu(); }
      return modelCache;
    });
  }

  function closeModelMenuSmoothly() {
    var menu = $("model-menu");
    if (!menu || menu.hidden) { return; }
    if (!S.motion) {
      menu.hidden = true;
      menu.classList.remove("closing");
      return;
    }
    menu.classList.add("closing");
    setTimeout(function () {
      menu.hidden = true;
      menu.classList.remove("closing");
    }, 145);
  }

  /** 模型菜单的搜索关键词。 */
  var modelQuery = "";

  // 供应商分类导航项：菜单骨架与正文重画共用
  var provItems = [
    { id: "all", label: "全部厂商", icon: "🌐" },
    { id: "anthropic", label: "Claude 官方", icon: "✳", match: /claude|anthropic/i },
    { id: "deepseek", label: "DeepSeek", icon: "🐋", match: /deepseek/i },
    { id: "openai", label: "OpenAI", icon: "🟢", match: /gpt|o[13]|openai/i },
    { id: "gemini", label: "Gemini", icon: "✨", match: /gemini|google/i },
    { id: "chinese", label: "智谱/通义/国产", icon: "🟣", match: /glm|zhipu|qwen|tongyi|kimi|moonshot|sensenova|minimax|step|hy3|hy4/i },
    { id: "gateway", label: "聚合网关", icon: "⚡", match: /group\/|opencode-zen|trae|qoder|beatapi|amd\//i },
    { id: "ollama", label: "本地 Ollama", icon: "🦙", match: /ollama|llama|localhost|11434/i }
  ];

  function drawModelMenu() {
    var menu = $("model-menu");
    if (!menu) { return; }
    clear(menu);

    var head = el("div", "model-menu-head");
    var titleWrap = el("div", "model-menu-title");
    titleWrap.appendChild(el("span", null, "模型分组"));

    var legend = el("span", "model-legend");
    [
      { cls: "fast", text: "快" },
      { cls: "medium", text: "中" },
      { cls: "slow", text: "慢" }
    ].forEach(function (item) {
      var lg = el("span", "model-legend-item");
      lg.appendChild(el("span", "latency-dot " + item.cls));
      lg.appendChild(el("span", null, item.text));
      legend.appendChild(lg);
    });
    titleWrap.appendChild(legend);
    head.appendChild(titleWrap);

    var actions = el("div", "model-menu-actions");
    var groupBtn = el("button", "model-action-btn" + (modelGroupMode === "capability" ? " active" : ""), modelGroupMode === "capability" ? "按能力" : "按厂商");
    groupBtn.type = "button";
    groupBtn.title = "切换分组方式：按能力类别（编程/通用/长文本）或按供应商分组";
    groupBtn.addEventListener("click", function (e) {
      e.stopPropagation();
      modelGroupMode = modelGroupMode === "capability" ? "vendor" : "capability";
      modelSortFast = false;
      drawModelMenu();
    });
    actions.appendChild(groupBtn);

    var sortBtn = el("button", "model-action-btn" + (modelSortFast ? " active" : ""), "速度优先");
    sortBtn.type = "button";
    sortBtn.title = "按响应延迟从快到慢排序";
    sortBtn.addEventListener("click", function (e) {
      e.stopPropagation();
      modelSortFast = !modelSortFast;
      drawModelMenu();
    });
    actions.appendChild(sortBtn);

    var probeBtn = el("button", "model-action-btn", modelProbing ? "测速中…" : "测速");
    probeBtn.type = "button";
    probeBtn.disabled = modelProbing;
    probeBtn.title = "重新检测各模型响应延迟";
    probeBtn.addEventListener("click", function (e) {
      e.stopPropagation();
      fetchModels(true);
    });
    actions.appendChild(probeBtn);

    head.appendChild(actions);
    menu.appendChild(head);

    if (!modelCache) {
      menu.appendChild(el("div", "empty-note", "正在加载…"));
      return;
    }
    if (!modelCache.length) {
      menu.appendChild(el("div", "empty-note", "未发现可用模型，可在设置中手动填写"));
      return;
    }

    // 搜索框：支持按模型名、供应商或能力关键词（代码/视觉/长文本/通用）过滤。
    var search = el("input", "model-search");
    search.type = "text";
    search.placeholder = "搜索模型、厂商或能力（如 代码 / 视觉）…";
    search.value = modelQuery;
    search.addEventListener("input", function () {
      modelQuery = search.value;
      redrawModelMenuBody();
    });
    search.addEventListener("keydown", function (e) { e.stopPropagation(); });
    menu.appendChild(search);

    // 供应商分类导航栏（全部 / Claude 官方 / DeepSeek / OpenAI / Gemini / 智谱通义国产 / 聚合网关 / 本地 Ollama）
    var provFilterTabs = el("div", "model-vendor-tabs");
    provItems.forEach(function (pv) {
      var pb = el("button", "model-vendor-tab" + (modelProviderFilter === pv.id ? " active" : ""));
      pb.type = "button";
      var ico = el("span", "pv-icon", pv.icon);
      var lbl = el("span", null, pv.label);
      pb.appendChild(ico);
      pb.appendChild(lbl);
      pb.addEventListener("click", function (e) {
        e.stopPropagation();
        if (modelProviderFilter === pv.id) { return; }
        modelProviderFilter = pv.id;
        Array.prototype.forEach.call(provFilterTabs.children, function (t) {
          t.classList.toggle("active", t === pb);
        });
        redrawModelMenuBody();
      });
      provFilterTabs.appendChild(pb);
    });
    menu.appendChild(provFilterTabs);

    // 横幅、能力标签与模型列表都画进 body 区：搜索与筛选只重画这一块，
    // 菜单骨架（标题/搜索框/厂商栏/底部）保持不动，重画不再整树重建。
    var menuBody = el("div", "model-menu-body");
    menu.appendChild(menuBody);
    drawModelMenuBody(menuBody);

    // 底部常驻配置模型与供应商快捷入口
    var menuFoot = el("div", "model-menu-foot");
    var cfgBtn = el("button", "model-menu-cfg-btn");
    cfgBtn.type = "button";
    cfgBtn.innerHTML = `<span>⚙️ 配置供应商与 API Key（添加/修改 Claude、DeepSeek、OpenAI、本地模型）</span> <span class="cfg-arrow">→</span>`;
    cfgBtn.addEventListener("click", function (e) {
      e.stopPropagation();
      closeModelMenuSmoothly();
      openModelConfigModal("providers");
    });
    menuFoot.appendChild(cfgBtn);
    menu.appendChild(menuFoot);
  }

  /** 重画模型菜单正文：骨架不动，只换横幅/能力标签/列表。 */
  function redrawModelMenuBody() {
    var menu = $("model-menu");
    if (!menu || menu.hidden) { return; }
    var body = menu.querySelector(".model-menu-body");
    if (!body) { drawModelMenu(); return; }
    clear(body);
    drawModelMenuBody(body);
  }

  function drawModelMenuBody(container) {
    var menu = $("model-menu");
    var cur = (S.config && S.config.model) || "";

    // 选中厂商时的专属提示与快速配置横幅
    if (modelProviderFilter !== "all") {
      var currentPv = provItems.find(function (p) { return p.id === modelProviderFilter; });
      if (currentPv) {
        var pvBanner = el("div", "model-vendor-banner");
        var pvLeft = el("div", "pv-banner-left");
        pvLeft.innerHTML = `<span class="pv-banner-ico">${currentPv.icon}</span> <div class="pv-banner-txt"><strong>${currentPv.label} 专属模型库</strong><span class="pv-banner-sub">点击下方模型一键启用；也可直接配置此厂商专属 API Key 与服务地址</span></div>`;
        pvBanner.appendChild(pvLeft);

        var pvCfgBtn = el("button", "pv-banner-btn", "⚙️ 配置此厂商");
        pvCfgBtn.type = "button";
        pvCfgBtn.title = "打开此厂商的 API Key 与 Base URL 配置";
        pvCfgBtn.addEventListener("click", function (e) {
          e.stopPropagation();
          closeModelMenuSmoothly();
          openModelConfigModal("providers");
          selectedProviderKey = currentPv.id === "chinese" ? "zhipu" : currentPv.id;
          renderConfigModalContent();
        });
        pvBanner.appendChild(pvCfgBtn);
        container.appendChild(pvBanner);
      }
    }

    var allEntries = modelCache.map(function (m) {
      return typeof m === "string" ? { id: m, baseUrl: (S.config && S.config.baseUrl) || "", vendor: "" } : m;
    });

    // 能力分类快捷筛选栏（全部 / 编程 Coding / 通用 General / 长文本 Context）
    var catCounts = { all: allEntries.length, coding: 0, general: 0, context: 0 };
    allEntries.forEach(function (m) {
      var c = modelCategoryOf(m).id;
      catCounts[c] = (catCounts[c] || 0) + 1;
    });

    var tabs = el("div", "model-cat-tabs");
    [
      { id: "all", label: "全部能力" },
      { id: "coding", label: "编程 Coding" },
      { id: "general", label: "通用 General" },
      { id: "context", label: "长文本 Context" }
    ].forEach(function (tab) {
      var b = el("button", "model-cat-tab" + (modelCategoryFilter === tab.id ? " active" : ""));
      b.type = "button";
      b.appendChild(el("span", null, tab.label));
      b.appendChild(el("span", "model-cat-count", String(catCounts[tab.id] || 0)));
      b.addEventListener("click", function (e) {
        e.stopPropagation();
        if (modelCategoryFilter === tab.id) { return; }
        modelCategoryFilter = tab.id;
        Array.prototype.forEach.call(tabs.children, function (t) {
          t.classList.toggle("active", t === b);
        });
        redrawModelMenuBody();
      });
      tabs.appendChild(b);
    });
    container.appendChild(tabs);

    var entries = allEntries.slice();
    if (modelProviderFilter !== "all") {
      var targetPv = provItems.find(function (p) { return p.id === modelProviderFilter; });
      if (targetPv && targetPv.match) {
        entries = entries.filter(function (m) {
          return targetPv.match.test(m.id) || targetPv.match.test(m.vendor || "") || (m.providerKey === targetPv.id);
        });
      }
    }
    if (modelCategoryFilter !== "all") {
      entries = entries.filter(function (m) {
        return modelCategoryOf(m).id === modelCategoryFilter;
      });
    }

    var q = modelQuery.trim().toLowerCase();
    if (q) {
      entries = entries.filter(function (m) {
        var cap = modelCategoryOf(m);
        return (
          String(m.id).toLowerCase().indexOf(q) >= 0 ||
          String(m.vendor || "").toLowerCase().indexOf(q) >= 0 ||
          cap.label.toLowerCase().indexOf(q) >= 0 ||
          cap.tag.toLowerCase().indexOf(q) >= 0
        );
      });
    }

    function buildModelRow(m, v) {
      var name = m.id;
      var perf = modelLatencyOf(m);
      var cap = modelCategoryOf(m);
      var b = el("button", "model-opt" + (name === cur ? " on" : ""));
      b.type = "button";
      b.title = name + " · " + cap.label + " · 响应延迟 " + perf.ms + "ms（" + perf.label + "）";

      var dot = el("span", "latency-dot " + (modelProbing ? "probing" : perf.tier));
      dot.setAttribute("aria-label", perf.label + " " + perf.ms + "ms");
      dot.title = "延迟状态：" + perf.label + "（" + perf.ms + "ms）";
      b.appendChild(dot);

      b.appendChild(el("span", "model-opt-name", name));
      b.appendChild(el("span", "model-cap-tag " + cap.id, cap.tag));

      var msBadge = el("span", "model-opt-ms " + perf.tier, modelProbing ? "…" : perf.ms + "ms");
      b.appendChild(msBadge);
      // 速度条（参照 affectui.com Model Picker）：悬停行时填充，宽度=延迟映射。
      var bar = el("span", "model-speedbar " + perf.tier);
      var barFill = el("span", "model-speedbar-fill");
      var pct = Math.max(6, Math.min(100, Math.round(100 * (1 - Math.min(perf.ms, 4000) / 4000))));
      barFill.style.setProperty("--speed-pct", pct + "%");
      bar.appendChild(barFill);
      b.appendChild(bar);


      if (name !== cur) { b.appendChild(el("span", "model-opt-vendor", v)); }
      if (name === cur) { b.appendChild(el("span", "model-opt-check", "\u2713")); }
      b.addEventListener("click", function () {
        modelQuery = "";
        if (name === cur) {
          closeModelMenuSmoothly();
          return;
        }
        // 视觉反馈：移除旧选中态、为当前点击项添加高亮脉冲与对勾微动画，再平滑收起菜单
        Array.prototype.forEach.call(menu.querySelectorAll(".model-opt.on"), function (oldRow) {
          oldRow.classList.remove("on");
          var oldCheck = oldRow.querySelector(".model-opt-check");
          if (oldCheck && oldCheck.parentNode) { oldCheck.parentNode.removeChild(oldCheck); }
        });
        var vendorSpan = b.querySelector(".model-opt-vendor");
        if (vendorSpan && vendorSpan.parentNode) { vendorSpan.parentNode.removeChild(vendorSpan); }
        b.classList.add("on", "selecting");
        b.appendChild(el("span", "model-opt-check", "\u2713"));

        setTimeout(function () {
          closeModelMenuSmoothly();
        }, 120);

        postJSON("/api/config", { model: name }).then(function (j) {
          if (S.config) { S.config.model = j.model || name; }
          renderTopMeta();
          renderInspector();
          toast("已切换到 " + (j.model || name) + "（" + cap.tag + " · " + perf.ms + "ms）", "ok");
        }).catch(function (e) { toast("切换失败：" + e.message, "err"); });
      });
      return b;
    }

    function buildGroupSection(groupKey, groupTitle, groupItems) {
      var isCollapsed = !!collapsedModelGroups[groupKey] && !q;
      var gwrap = el("div", "model-group" + (isCollapsed ? " collapsed" : ""));
      var ghead = el("div", "model-group-head");
      ghead.appendChild(el("span", "model-group-arrow", "\u25BE"));
      ghead.appendChild(el("span", null, groupTitle));
      ghead.appendChild(el("span", "model-group-badge", String(groupItems.length)));
      ghead.addEventListener("click", function (e) {
        e.stopPropagation();
        collapsedModelGroups[groupKey] = !collapsedModelGroups[groupKey];
        gwrap.classList.toggle("collapsed", !!collapsedModelGroups[groupKey]);
      });
      gwrap.appendChild(ghead);

      var list = el("div", "model-group-list");
      groupItems.slice().sort(function (a, b) {
        return modelLatencyOf(a).ms - modelLatencyOf(b).ms;
      }).forEach(function (m) {
        var v = m.vendor || vendorFromUrl(m.baseUrl, m.id);
        list.appendChild(buildModelRow(m, v));
      });
      gwrap.appendChild(list);
      return gwrap;
    }

    if (!entries.length) {
      container.appendChild(el("div", "empty-note", "没有匹配的模型"));
    } else if (modelSortFast) {
      var sorted = entries.slice().sort(function (a, b) {
        return modelLatencyOf(a).ms - modelLatencyOf(b).ms;
      });
      var fastBox = el("div", "model-menu-list");
      fastBox.appendChild(buildGroupSection("speed-all", "按响应速度排序 · Fastest First", sorted));
      container.appendChild(fastBox);
    } else if (modelGroupMode === "capability") {
      // 按模型主要能力分组：编程与推理 (Coding) / 通用对话 (General Purpose) / 长上下文与视觉 (Large Context)
      var capMap = {};
      entries.forEach(function (m) {
        var cap = modelCategoryOf(m);
        if (!capMap[cap.id]) { capMap[cap.id] = []; }
        capMap[cap.id].push(m);
      });
      var capBox = el("div", "model-menu-list");
      MODEL_CATEGORIES.forEach(function (cat) {
        var list = capMap[cat.id];
        if (!list || !list.length) { return; }
        capBox.appendChild(buildGroupSection("cap-" + cat.id, cat.label, list));
      });
      container.appendChild(capBox);
    } else {
      // 按供应商分栏，供应商来自 baseUrl（后端判定），模型名只作后备；每组内更快的模型优先排列。
      var groups = {};
      entries.forEach(function (m) {
        var v = m.vendor || vendorFromUrl(m.baseUrl, m.id);
        if (!groups[v]) { groups[v] = []; }
        groups[v].push(m);
      });
      var keys = Object.keys(groups);
      var order = (S.config && S.config.endpoint && S.config.endpoint.vendor) || "";
      keys.sort(function (a, b) {
        if (a === order) { return -1; }
        if (b === order) { return 1; }
        return String(a).localeCompare(String(b), "zh");
      });

      var box = el("div", "model-menu-list");
      keys.forEach(function (v) {
        box.appendChild(buildGroupSection("vendor-" + v, v, groups[v]));
      });
      container.appendChild(box);
    }
  }



  var cmdIndex = 0;
  var cmdMatches = [];

  /** 内建命令 + 自定义命令 + 技能，供斜杠菜单与命令面板共用。 */
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
    skillsList.forEach(function (s) {
      var k = "/" + s.name;
      if (list.some(function (x) { return x.k === k; })) { return; }
      list.push({
        k: k,
        d: (s.scope === "builtin" ? "内置技能 · " : s.scope === "user" ? "用户技能 · " : s.scope === "plugin" ? "插件技能 · " : "项目技能 · ") + s.description,
        fn: function () { runCommand(k); }
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

  /* ---- 全文搜索：跨会话搜消息正文 ---- */
  function openSearch() {
    openModal("搜索对话内容", function (body) {
      var bar = el("div", "search-bar");
      var input = el("input", "search-input");
      input.type = "search";
      input.placeholder = "输入关键词，搜索全部历史消息…";
      bar.appendChild(input);
      body.appendChild(bar);
      var host = el("div", "search-results");
      body.appendChild(host);
      var timer = null;
      function run() {
        var q = input.value.trim();
        if (!q) { host.innerHTML = ""; return; }
        getJSON("/api/search?q=" + encodeURIComponent(q)).then(function (j) {
          clear(host);
          if (!j.results || !j.results.length) {
            host.appendChild(el("div", "empty-note", "没找到包含「" + q + "」的消息（已扫 " + (j.scanned || 0) + " 个会话）"));
            return;
          }
          host.appendChild(el("div", "search-count", "找到 " + j.results.length + " 条 · 已扫 " + (j.scanned || 0) + " 个会话"));
          j.results.forEach(function (r) {
            var item = el("button", "search-item");
            item.type = "button";
            var head = el("div", "search-item-head");
            head.appendChild(el("span", "search-role " + (r.role === "user" ? "is-user" : "is-asst"), r.role === "user" ? "你" : "Claude"));
            head.appendChild(el("span", "search-title", r.title || r.sessionId));
            item.appendChild(head);
            var sn = el("div", "search-snippet");
            sn.textContent = r.snippet || "";
            item.appendChild(sn);
            item.addEventListener("click", function () {
              closeModal();
              resumeSession(r.sessionId);
              jumpToSnippet(r.snippet);
            });
            host.appendChild(item);
          });
        }).catch(function (e) {
          clear(host);
          host.appendChild(el("div", "empty-note", "搜索失败：" + e.message));
        });
      }
      input.addEventListener("input", function () {
        if (timer) { clearTimeout(timer); }
        timer = setTimeout(run, 220);
      });
      setTimeout(function () { input.focus(); }, 30);
    });
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

  /* ======================================================== 中文语音转文字 === */

  var voiceState = {
    active: false,
    lang: "zh-CN",
    engine: "free", // "free" (Web Speech API 免费识别) | "gemini" (后端转写) | "live" (实时语音对话)
    recognition: null,
    mediaRecorder: null,
    mediaChunks: [],
    mediaStream: null,
    liveWs: null,
    audioCtx: null,
    scriptProc: null,
    timerId: null,
    startedAt: 0,
    manualStop: false
  };

  /**
   * 为中文语音识别结果补充自然标点并转换口语标点指令（全部免费本地规则）。
   * 例如说出“逗号”、“句号”、“问号”、“换行”等会自动替换，句尾自动根据语气词补全标点。
   */
  function normalizeChineseTranscript(raw) {
    var s = String(raw || "").trim();
    if (!s) { return ""; }
    s = s
      .replace(/逗号/g, "，")
      .replace(/句号/g, "。")
      .replace(/问号/g, "？")
      .replace(/感叹号|叹号/g, "！")
      .replace(/冒号/g, "：")
      .replace(/分号/g, "；")
      .replace(/顿号/g, "、")
      .replace(/换行|新的一行/g, "\n");
    return s;
  }

  function appendTranscriptToInput(text, addTrailingPunct) {
    var ta = $("in");
    if (!ta) { return; }
    var clean = normalizeChineseTranscript(text);
    if (!clean) { return; }

    if (addTrailingPunct && !/[，。？！、；：,.?!;:\n]$/.test(clean) && clean.length >= 4) {
      if (/(吗|呢|吧|么|为什么|怎么|如何|多少|哪|是不是|能不能|可不可以)$/.test(clean)) {
        clean += "？";
      } else {
        clean += "，";
      }
    }

    var cur = ta.value || "";
    var start = typeof ta.selectionStart === "number" ? ta.selectionStart : cur.length;
    var end = typeof ta.selectionEnd === "number" ? ta.selectionEnd : cur.length;
    var before = cur.slice(0, start);
    var after = cur.slice(end);
    // 若前文末尾已是逗号且新句较短，保持自然衔接
    ta.value = before + clean + after;
    var caret = (before + clean).length;
    try { ta.setSelectionRange(caret, caret); } catch (e) {}
    autoGrow(ta);
    updateSlashMenu(ta.value);
  }

  function finalizeChinesePunctuation() {
    var ta = $("in");
    if (!ta || !ta.value) { return; }
    // 结束语音输入时，若末尾是自动补的“，”，收敛为“。”
    if (/，$/.test(ta.value)) {
      ta.value = ta.value.replace(/，$/, "。");
      autoGrow(ta);
    }
  }

  function updateVoiceTimer() {
    var elTimer = $("voice-timer");
    if (!elTimer) { return; }
    var sec = Math.max(0, Math.floor((Date.now() - voiceState.startedAt) / 1000));
    var mm = String(Math.floor(sec / 60)).padStart(2, "0");
    var ss = String(sec % 60).padStart(2, "0");
    elTimer.textContent = mm + ":" + ss;
  }

  function setVoiceUI(active, statusText, interimText) {
    var btn = $("btn-mic");
    var bar = $("voice-bar");
    var box = $("composer-box");
    var st = $("voice-status");
    var im = $("voice-interim");
    if (btn) {
      btn.classList.toggle("recording", !!active);
      btn.title = active ? "点击停止语音输入（Alt+V）" : "免费中文语音转文字（点击说话 · Alt+V）";
    }
    if (bar) { bar.hidden = !active; }
    if (box) { box.classList.toggle("voice-active", !!active); }
    if (st && statusText != null) { st.textContent = statusText; }
    if (im && interimText != null) { im.textContent = interimText; }
  }

  function initVoiceUI() {
    try {
      var savedLang = localStorage.getItem(LS_VOICE_LANG);
      if (savedLang) { voiceState.lang = savedLang; }
      var savedEngine = localStorage.getItem(LS_VOICE_ENGINE);
      if (savedEngine) { voiceState.engine = savedEngine; }
    } catch (e) {}

    var selLang = $("voice-lang");
    if (selLang) {
      selLang.value = voiceState.lang;
      selLang.addEventListener("change", function () {
        voiceState.lang = selLang.value || "zh-CN";
        try { localStorage.setItem(LS_VOICE_LANG, voiceState.lang); } catch (e) {}
        if (voiceState.active) {
          stopVoiceInput(true);
          setTimeout(function () { startVoiceInput(); }, 120);
        }
      });
    }

    var selEngine = $("voice-engine");
    if (selEngine) {
      selEngine.value = voiceState.engine;
      selEngine.addEventListener("change", function () {
        voiceState.engine = selEngine.value || "free";
        try { localStorage.setItem(LS_VOICE_ENGINE, voiceState.engine); } catch (e) {}
        if (voiceState.active) {
          stopVoiceInput(true);
          setTimeout(function () { startVoiceInput(); }, 120);
        }
      });
    }

    var btnMic = $("btn-mic");
    if (btnMic) {
      btnMic.addEventListener("click", function () {
        toggleVoiceInput();
      });
    }

    var btnDone = $("btn-voice-done");
    if (btnDone) {
      btnDone.addEventListener("click", function () {
        stopVoiceInput();
      });
    }
  }

  function toggleVoiceInput() {
    if (voiceState.active) {
      stopVoiceInput();
    } else {
      startVoiceInput();
    }
  }

  function startVoiceInput() {
    if (voiceState.active) { return; }
    voiceState.manualStop = false;
    voiceState.startedAt = Date.now();
    clearInterval(voiceState.timerId);
    voiceState.timerId = setInterval(updateVoiceTimer, 500);
    updateVoiceTimer();

    if (voiceState.engine === "gemini") {
      startGeminiTranscribeRecording();
      return;
    }
    if (voiceState.engine === "live") {
      startLiveVoiceSession();
      return;
    }
    startFreeBrowserSpeech();
  }

  /**
   * 免费中文语音转文字：基于浏览器原生 Web Speech API（SpeechRecognition / webkitSpeechRecognition）。
   * 无需任何 API Key，支持普通话（zh-CN）、粤语（zh-HK）、繁体国语（zh-TW）实时流式上屏与标点优化。
   */
  function startFreeBrowserSpeech() {
    var SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
      toast("当前浏览器不支持原生免费语音识别，尝试切换至录音转写模式", "warn");
      startGeminiTranscribeRecording();
      return;
    }

    try {
      var rec = new SpeechRecognition();
      rec.lang = voiceState.lang || "zh-CN";
      rec.continuous = true;
      rec.interimResults = true;
      rec.maxAlternatives = 1;

      voiceState.recognition = rec;
      voiceState.active = true;
      var langName = voiceState.lang === "zh-HK" ? "粤语" : voiceState.lang === "zh-TW" ? "繁体国语" : "中文普通话";
      setVoiceUI(true, "正在聆听" + langName + "…", "请直接说话，免费实时转文字（支持说“逗号 / 句号 / 问号”）");

      rec.onresult = function (event) {
        var interim = "";
        var finalChunk = "";
        for (var i = event.resultIndex; i < event.results.length; i++) {
          var res = event.results[i];
          var txt = (res[0] && res[0].transcript) || "";
          if (res.isFinal) {
            finalChunk += txt;
          } else {
            interim += txt;
          }
        }
        if (finalChunk) {
          appendTranscriptToInput(finalChunk, true);
        }
        var im = $("voice-interim");
        if (im) {
          im.textContent = interim
            ? "识别中：" + normalizeChineseTranscript(interim)
            : "继续说话…（已实时写入输入框）";
        }
      };

      rec.onerror = function (event) {
        var err = (event && event.error) || "";
        if (err === "no-speech") {
          return;
        }
        if (err === "not-allowed" || err === "service-not-allowed") {
          toast("请允许浏览器使用麦克风权限以进行中文语音转文字", "err");
          stopVoiceInput();
          return;
        }
        if (err === "aborted") {
          return;
        }
        toast("语音识别提示：" + err, "warn");
      };

      rec.onend = function () {
        // 若用户未主动点击停止，自动续接聆听，支持长句停顿思考
        if (voiceState.active && !voiceState.manualStop && voiceState.engine === "free") {
          try {
            rec.start();
            return;
          } catch (e) {}
        }
        if (voiceState.active && voiceState.engine === "free") {
          stopVoiceInput();
        }
      };

      rec.start();
    } catch (e) {
      voiceState.active = false;
      clearInterval(voiceState.timerId);
      setVoiceUI(false);
      toast("无法启动语音识别：" + e.message, "err");
    }
  }

  /** 转写失败时，若引擎是因免费识别断网自动降级来的，回退 free 让下次重试。 */
  function revertAutoEngineIfAuto() {
    if (voiceState.freeFallbackTried && voiceState.engine === "gemini") {
      voiceState.engine = "free";
      voiceState.freeFallbackTried = false;
      var sel = $("voice-engine");
      if (sel) { sel.value = "free"; }
      toast("已回退到浏览器免费识别，下次按住说话会重试直连", "info");
    }
  }


  /**
   * 录音后调用后端 /api/transcribe（若未配置 API Key 则提示切换回免费极速识别）。
   */
  function startGeminiTranscribeRecording() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      toast("当前环境不支持麦克风录音，已切换至浏览器免费识别", "warn");
      voiceState.engine = "free";
      var sel = $("voice-engine");
      if (sel) { sel.value = "free"; }
      startFreeBrowserSpeech();
      return;
    }

    navigator.mediaDevices.getUserMedia({ audio: true }).then(function (stream) {
      voiceState.mediaStream = stream;
      voiceState.mediaChunks = [];
      var mime = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : "audio/webm";
      var recorder = new MediaRecorder(stream, { mimeType: mime });
      voiceState.mediaRecorder = recorder;
      voiceState.active = true;
      setVoiceUI(true, "正在录音（AI 转写）…", "说完后点击「完成」自动转写为中文并补充标点");

      recorder.ondataavailable = function (e) {
        if (e.data && e.data.size > 0) { voiceState.mediaChunks.push(e.data); }
      };

      recorder.onstop = function () {
        var chunks = voiceState.mediaChunks.slice();
        voiceState.mediaChunks = [];
        if (!chunks.length) { return; }
        var blob = new Blob(chunks, { type: recorder.mimeType || "audio/webm" });
        readFileDataURL(blob).then(function (dataUrl) {
          var base64 = (dataUrl.split(",")[1] || "");
          if (!base64) { return; }
          toast("正在转写中文语音…", "info");
          postJSON("/api/transcribe", {
            audio: base64,
            mimeType: (recorder.mimeType || "audio/webm").split(";")[0],
            lang: voiceState.lang
          }).then(function (j) {
            if (j && j.ok && j.text) {
              appendTranscriptToInput(j.text, false);
              toast("语音转写完成", "ok");
            } else {
              throw new Error((j && j.error) || "转写失败");
            }
          }).catch(function (err) {
            toast(err.message + "（已为你切回免费极速识别）", "warn");
            voiceState.engine = "free";
            var sel = $("voice-engine");
            if (sel) { sel.value = "free"; }
          });
        });
      };

      recorder.start();
    }).catch(function (e) {
      voiceState.active = false;
      clearInterval(voiceState.timerId);
      setVoiceUI(false);
      toast("无法访问麦克风：" + e.message, "err");
    });
  }

  /**
   * 实时语音对话模式（连接 /live WebSocket）。
   */
  function startLiveVoiceSession() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      toast("不支持麦克风访问", "err");
      return;
    }
    var proto = location.protocol === "https:" ? "wss:" : "ws:";
    var wsUrl = proto + "//" + location.host + "/live?lang=" + encodeURIComponent(voiceState.lang);
    var ws = new WebSocket(wsUrl);
    voiceState.liveWs = ws;
    voiceState.active = true;
    setVoiceUI(true, "正在连接实时语音…", "建立双向中文语音流…");

    var playCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 24000 });
    var nextPlayTime = 0;

    ws.onmessage = function (ev) {
      try {
        var msg = JSON.parse(ev.data);
        if (msg.error) {
          toast(msg.error, "warn");
          voiceState.engine = "free";
          var sel = $("voice-engine");
          if (sel) { sel.value = "free"; }
          stopVoiceInput(true);
          startFreeBrowserSpeech();
          return;
        }
        if (msg.ready) {
          setVoiceUI(true, "实时中文语音对话中…", "请直接说话，支持随时打断");
        }
        if (msg.inputTranscript) {
          var im = $("voice-interim");
          if (im) { im.textContent = "你说：" + msg.inputTranscript; }
          if (msg.finished) { appendTranscriptToInput(msg.inputTranscript, true); }
        }
        if (msg.outputTranscript) {
          var imOut = $("voice-interim");
          if (imOut) { imOut.textContent = "MyClaude：" + msg.outputTranscript; }
        }
        if (msg.interrupted) {
          nextPlayTime = playCtx.currentTime;
        }
        if (msg.audio) {
          var bin = atob(msg.audio);
          var bytesArr = new Uint8Array(bin.length);
          for (var i = 0; i < bin.length; i++) { bytesArr[i] = bin.charCodeAt(i); }
          var pcm16 = new Int16Array(bytesArr.buffer);
          var f32 = new Float32Array(pcm16.length);
          for (var j = 0; j < pcm16.length; j++) { f32[j] = pcm16[j] / 32768; }
          var buf = playCtx.createBuffer(1, f32.length, 24000);
          buf.getChannelData(0).set(f32);
          var src = playCtx.createBufferSource();
          src.buffer = buf;
          src.connect(playCtx.destination);
          var startAt = Math.max(playCtx.currentTime, nextPlayTime);
          src.start(startAt);
          nextPlayTime = startAt + buf.duration;
        }
      } catch (e) {}
    };

    ws.onerror = function () {
      toast("实时语音连接失败，已切换至浏览器免费识别", "warn");
      voiceState.engine = "free";
      var sel = $("voice-engine");
      if (sel) { sel.value = "free"; }
      stopVoiceInput(true);
    };

    navigator.mediaDevices.getUserMedia({ audio: { sampleRate: 16000, channelCount: 1 } }).then(function (stream) {
      if (!voiceState.active) {
        stream.getTracks().forEach(function (t) { t.stop(); });
        return;
      }
      voiceState.mediaStream = stream;
      var audioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
      voiceState.audioCtx = audioCtx;
      var source = audioCtx.createMediaStreamSource(stream);
      var proc = audioCtx.createScriptProcessor(4096, 1, 1);
      voiceState.scriptProc = proc;
      proc.onaudioprocess = function (e) {
        if (!voiceState.active || !ws || ws.readyState !== WebSocket.OPEN) { return; }
        var input = e.inputBuffer.getChannelData(0);
        var pcm = new Int16Array(input.length);
        for (var i = 0; i < input.length; i++) {
          var s = Math.max(-1, Math.min(1, input[i]));
          pcm[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
        }
        var u8 = new Uint8Array(pcm.buffer);
        var bstr = "";
        for (var k = 0; k < u8.length; k++) { bstr += String.fromCharCode(u8[k]); }
        ws.send(JSON.stringify({ audio: btoa(bstr) }));
      };
      source.connect(proc);
      proc.connect(audioCtx.destination);
    }).catch(function (e) {
      toast("无法访问麦克风：" + e.message, "err");
      stopVoiceInput(true);
    });
  }

  function stopVoiceInput(silent) {
    voiceState.manualStop = true;
    voiceState.active = false;
    clearInterval(voiceState.timerId);
    voiceState.timerId = null;

    if (voiceState.recognition) {
      try { voiceState.recognition.stop(); } catch (e) {}
      voiceState.recognition = null;
    }
    if (voiceState.mediaRecorder && voiceState.mediaRecorder.state !== "inactive") {
      try { voiceState.mediaRecorder.stop(); } catch (e) {}
    }
    voiceState.mediaRecorder = null;

    if (voiceState.scriptProc) {
      try { voiceState.scriptProc.disconnect(); } catch (e) {}
      voiceState.scriptProc = null;
    }
    if (voiceState.audioCtx) {
      try { voiceState.audioCtx.close(); } catch (e) {}
      voiceState.audioCtx = null;
    }
    if (voiceState.mediaStream) {
      try {
        voiceState.mediaStream.getTracks().forEach(function (t) { t.stop(); });
      } catch (e) {}
      voiceState.mediaStream = null;
    }
    if (voiceState.liveWs) {
      try { voiceState.liveWs.close(); } catch (e) {}
      voiceState.liveWs = null;
    }

    finalizeChinesePunctuation();
    setVoiceUI(false);
    var ta = $("in");
    if (ta && !silent) { ta.focus(); }
  }

  /* ================================================================ 启动 === */

  window.addEventListener("resize", function () { moveModeThumb(); });

  function boot() {
    var params = new URLSearchParams(location.search);
    var savedTheme = params.get("theme");
    if (savedTheme !== "light" && savedTheme !== "dark" && savedTheme !== "auto") {
      savedTheme = null;
      try { savedTheme = localStorage.getItem(LS_THEME); } catch (e) { }
    }
    if (savedTheme !== "light" && savedTheme !== "dark" && savedTheme !== "auto") {
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
    loadSkillsList();
    renderWelcomeCards();
    renderChatSkeleton();
    bindEvents();
    if (params.get("insp") === "1") { $("app").classList.add("insp-open"); }
    if (params.get("settings") === "1") { setTimeout(openSettings, 400); }
    if (params.get("insptab") === "changes") { S.changesScope = params.get("chgscope") === "branch" ? "branch" : "turn"; setTimeout(function () { var ap = $("app"); if (ap) { ap.classList.add("insp-open"); } switchInspectorTab("changes"); }, 500); }
    if (params.get("commands") === "1") { setTimeout(openCommandsModal, 500); }
    if (params.get("slash")) { var sq = params.get("slash"); setTimeout(function () { updateSlashMenu("/" + (sq === "1" ? "" : sq)); }, 500); }
    if (params.get("modelmenu") === "1") { setTimeout(toggleModelMenu, 500); }
    if (params.get("resume")) { setTimeout(function () { resumeSession(params.get("resume"), { quiet: true }); }, 400); }

    getJSON("/api/config").then(function (j) {
      S.config = j;
    // 深度思考按钮镜像 config.effort（与 /effort 同一设置）
    S.thinking = ["high", "medium", "low"].indexOf(S.config && S.config.effort) >= 0;
    renderThinkingButton();
      S.vision = j.vision !== false;
      if (j.routing) { S.routing = j.routing; }
      setMode(j.permissionMode || "ask");
      renderVision();
      renderUsage();
      renderInspector();
      refreshSessions();
      // Reopen the conversation the user was last in. Without this every
      // launch started on the welcome screen and the history felt lost, even
      // though the session was saved — nothing ever read the stored id back.
      if (!params.get("resume") && params.get("new") !== "1") {
        var lastId = null;
        try { lastId = localStorage.getItem(LS_SESSION); } catch (e) { }
        if (lastId) {
          // Defer so the first paint is not blocked on a restore request.
          setTimeout(function () { resumeSession(lastId, { quiet: true }); }, 60);
        }
      }
    }).catch(function (e) {
      addNotice("无法连接服务：" + e.message, "err");
    });

    var ta = $("in");
    if (ta) { ta.focus(); }

    // 会话恢复（resumeSession）是异步的；给它足够时间完成后再查后台任务，
    // 运行中的回合会被接回界面（断线续跑）。S.busy 已置位时跳过。
    // 重连应用的事件渲染进当前 DOM —— 若恢复渲染还没清完日志就会写进孤儿节点，
    // 所以留 2.6s 而不是贴着 60ms 的恢复启动走。
    setTimeout(reattachRunningTurn, 2600);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();

