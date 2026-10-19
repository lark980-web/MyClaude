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
    histIdx: -1,
    style: "normal",
    artifacts: [],
    activeArtifactId: null,
    artifactView: "preview",
    inspTab: "info",
    welcomeCat: "code",
    archivePolicy: "smart",
    thinking: false,
    artifactFullscreen: false,
    project: { name: "当前项目", instructions: "", files: [], knowledge: [], totalTokens: 0, limitTokens: 128000, capacityPct: 0 }
  };

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
  var LS_THINKING = "myclaude.thinking";

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

  function collectTurnNodesAfter(userWrap) {
    var nodes = [];
    var cur = userWrap.nextElementSibling;
    while (cur && !cur.classList.contains("msg-user")) {
      nodes.push(cur);
      cur = cur.nextElementSibling;
    }
    return nodes;
  }

  function addUserMessage(text, files) {
    hideWelcome();
    var root = logRoot();
    var wrap = el("div", "msg msg-user");
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
      if (wrap._branches && wrap._branches.length > 1) {
        var nav = el("div", "msg-branch-nav");
        var prevB = el("button", "msg-branch-btn", "\u25C2");
        prevB.type = "button";
        prevB.title = "上一分支版本";
        prevB.disabled = wrap._branchIdx <= 0;
        prevB.addEventListener("click", function () {
          switchUserBranch(wrap, wrap._branchIdx - 1);
        });
        var nextB = el("button", "msg-branch-btn", "\u25B8");
        nextB.type = "button";
        nextB.title = "下一分支版本";
        nextB.disabled = wrap._branchIdx >= wrap._branches.length - 1;
        nextB.addEventListener("click", function () {
          switchUserBranch(wrap, wrap._branchIdx + 1);
        });
        nav.appendChild(prevB);
        nav.appendChild(el("span", null, (wrap._branchIdx + 1) + " / " + wrap._branches.length));
        nav.appendChild(nextB);
        actions.appendChild(nav);
      }
      actions.appendChild(mkMini("编辑", function () {
        openInlineUserEditor(wrap, bubble, renderUserActions);
      }));
      actions.appendChild(mkMini("复制", function () { copyText(wrap._text); }));
    }

    wrap._renderActions = renderUserActions;
    renderUserActions();
    wrap.appendChild(actions);
    root.appendChild(wrap);
    scrollStream(true);
    return wrap;
  }

  function openInlineUserEditor(wrap, bubble, renderUserActions) {
    if (S.busy) { toast("请等待当前回复结束", "warn"); return; }
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

    // Claude 风格连续工具聚合：若前一个兄弟节点已是工具或工具组，自动归入可折叠的「连续操作组」
    var prev = root.lastElementChild;
    if (prev && prev.classList && prev.classList.contains("tool-group")) {
      var listHost = prev.querySelector(".tool-group-list");
      listHost.appendChild(box);
      updateToolGroupHeader(prev);
    } else if (prev && prev.classList && prev.classList.contains("tool")) {
      var group = createToolGroup();
      root.replaceChild(group, prev);
      var gList = group.querySelector(".tool-group-list");
      gList.appendChild(prev);
      gList.appendChild(box);
      updateToolGroupHeader(group);
    } else {
      root.appendChild(box);
    }

    scrollStream();
    return { box: box, time: time, secOut: secOut, preOut: preOut, diffHost: diffHost, name: name, args: args };
  }

  function createToolGroup() {
    var group = el("div", "tool-group");
    var head = el("button", "tool-group-head");
    head.type = "button";
    head.appendChild(el("span", "tool-dot"));
    head.appendChild(el("span", "tool-group-title", "已执行多项工具操作"));
    head.appendChild(el("span", "tool-group-meta", ""));
    var chev = el("span", "tool-group-chev");
    chev.appendChild(icon("i-chev", 14));
    head.appendChild(chev);
    var list = el("div", "tool-group-list");
    head.addEventListener("click", function () {
      group.classList.toggle("open");
    });
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

  function buildFollowupPrompts(rawText, bodyEl) {
    var txt = String(rawText || "");
    var hasArtifact = bodyEl && bodyEl.querySelector(".artifact-card");
    var hasCode = /```/.test(txt) || (bodyEl && bodyEl.querySelector(".codeblock"));
    if (hasArtifact) {
      return [
        "优化当前 Artifact 的视觉细节、交互动效与配色",
        "为该组件增加响应式布局与深浅色主题切换",
        "解释核心实现思路并说明如何集成到现有项目"
      ];
    }
    if (hasCode) {
      return [
        "为上面的代码编写覆盖边界情况的单元测试",
        "检查是否存在潜在异常、性能瓶颈或安全隐患",
        "进一步精简重构代码并加上关键中文注释"
      ];
    }
    return [
      "展开说说具体的代码实现方案与步骤",
      "总结最关键的 3 个行动项与验证方法",
      "分析潜在的边界情况与替代方案对比"
    ];
  }

  function addCopyActions(handle) {
    handle.actions.appendChild(mkMini("复制", function () { copyText(handle.raw); }));
    handle.actions.appendChild(mkMini("重试", function () { retryLast(handle); }));

    if (handle.wrap && !handle.wrap.querySelector(".followup-row") && (handle.raw || "").trim().length > 20) {
      var fRow = el("div", "followup-row");
      fRow.appendChild(el("span", "followup-label", "继续追问："));
      buildFollowupPrompts(handle.raw, handle.body).forEach(function (promptText) {
        var chip = el("button", "followup-chip");
        chip.type = "button";
        chip.appendChild(el("span", null, promptText));
        chip.appendChild(el("span", "followup-arrow", "\u2192"));
        chip.addEventListener("click", function () {
          var ta = $("in");
          if (!ta) { return; }
          ta.value = promptText;
          autoGrow(ta);
          if (!S.busy) {
            sendMessage();
          } else {
            ta.focus();
          }
        });
        fRow.appendChild(chip);
      });
      handle.wrap.appendChild(fRow);
    }
  }

  function extractThinkTagContent(raw) {
    var s = String(raw || "");
    var mClosed = s.match(/^\s*<think>([\s\S]*?)<\/think>\s*/i);
    if (mClosed) {
      return { think: mClosed[1].trim(), rest: s.slice(mClosed[0].length), open: false };
    }
    var mOpen = s.match(/^\s*<think>([\s\S]*)$/i);
    if (mOpen) {
      return { think: mOpen[1].trim(), rest: "", open: true };
    }
    return null;
  }

  function flushAssistant(handle, text, streaming) {
    var full = text == null ? handle.raw : text;
    var parsed = extractThinkTagContent(full);
    var visibleText = parsed ? parsed.rest : full;
    handle.raw = visibleText;
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
      var txt = first ? (first.textContent || "").trim().replace(/\s+/g, " ") : "新对话";
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
    renderProjectSection(body);
    renderRoutingSection(body);
    renderTodoSection(body);
    renderMcpSection(body);
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
    s.body.appendChild(dl);
    root.appendChild(s.sec);
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
    btnProbe.title = "测试所有备用模型接口连通性与响应延迟";
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
  function renderChatList() {
    var list = $("chat-list");
    if (!list) { return; }
    clear(list);
    renderArchivePolicyButton();

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

    // Most recently touched active project first.
    var keys = Object.keys(activeGroups).sort(function (a, b) {
      return newestAt(activeGroups[b]) - newestAt(activeGroups[a]);
    });

    if (!keys.length && archivedEntries.length) {
      list.appendChild(el("div", "rail-empty", "近期无活跃对话（" + archivedEntries.length + " 条旧会话已自动归档）"));
    }

    keys.forEach(function (key) {
      var items = activeGroups[key];
      var open = expandedGroups[key] === true;
      var wrap = el("div", "chat-group");

      var head = el("button", "chat-group-head");
      head.type = "button";
      head.title = key;
      head.appendChild(el("span", "chat-group-arrow", open ? "\u25BE" : "\u25B8"));
      head.appendChild(el("span", "chat-group-name", projectName(key)));
      head.appendChild(el("span", "chat-group-n", String(items.length)));
      head.addEventListener("click", function () {
        expandedGroups[key] = !open;
        renderChatList();
      });
      wrap.appendChild(head);

      var shown = open ? items : items.slice(0, GROUP_LIMIT);
      shown.forEach(function (s) {
        wrap.appendChild(buildSessionRow(s, { archived: false }));
      });

      if (!open && items.length > GROUP_LIMIT) {
        var more = el("button", "chat-group-more", "再显示 " + (items.length - GROUP_LIMIT) + " 条");
        more.type = "button";
        more.addEventListener("click", function () {
          expandedGroups[key] = true;
          renderChatList();
        });
        wrap.appendChild(more);
      }

      list.appendChild(wrap);
    });

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
    S.artifacts = [];
    S.activeArtifactId = null;
    updateArtifactBadge();
    Array.prototype.slice.call(root.querySelectorAll(".msg, .tool, .tool-group, .notice, .ask, .thought")).forEach(function (n) {
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
        enhanceCodeblocksWithArtifacts(h.body);
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
    postJSON("/api/reset", {}).then(function () {
      S.sessionKey = null;
      S.todos = [];
      S.artifacts = [];
      S.activeArtifactId = null;
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
        // 按能力分类分栏展示（编程与推理 / 通用对话 / 长上下文与视觉）。
        var catOrder = ["coding", "general", "context"];
        var groups = {};
        models.forEach(function (m) {
          var cap = modelCategoryOf(m);
          if (!groups[cap.id]) { groups[cap.id] = { label: cap.label, items: [] }; }
          groups[cap.id].items.push(m);
        });
        catOrder.forEach(function (cid) {
          var grp = groups[cid];
          if (!grp || !grp.items.length) { return; }
          var gwrap = el("div", "model-group");
          var ghead = el("div", "model-group-head");
          ghead.appendChild(el("span", "model-group-arrow", "\u25BE"));
          ghead.appendChild(el("span", null, grp.label));
          ghead.appendChild(el("span", "model-group-badge", String(grp.items.length)));
          ghead.addEventListener("click", function () {
            gwrap.classList.toggle("collapsed");
          });
          gwrap.appendChild(ghead);
          var list = el("div", "model-group-list");
          grp.items.forEach(function (m) {
            var name = m.id;
            var v = m.vendor || vendorFromUrl(m.baseUrl, m.id);
            var perf = modelLatencyOf(m);
            var cap = modelCategoryOf(m);
            var b = el("button", "opt");
            b.type = "button";
            b.appendChild(el("span", "opt-mark", "\u2713"));
            var dot = el("span", "latency-dot " + perf.tier);
            dot.title = "响应延迟：" + perf.ms + "ms（" + perf.label + "）";
            b.appendChild(dot);
            b.appendChild(el("span", "opt-label", name));
            b.appendChild(el("span", "model-cap-tag " + cap.id, cap.tag));
            var msBadge = el("span", "model-opt-ms " + perf.tier, perf.ms + "ms");
            msBadge.title = perf.label + " · " + perf.ms + "ms";
            b.appendChild(msBadge);
            if (name !== c.model) { b.appendChild(el("span", "model-opt-vendor", v)); }
            if (name === c.model) { b.classList.add("picked"); }
            b.addEventListener("click", function () {
              modelInput.value = name;
              Array.prototype.forEach.call(modelList.querySelectorAll(".opt"), function (x) { x.classList.remove("picked"); });
              b.classList.add("picked");
            });
            list.appendChild(b);
          });
          gwrap.appendChild(list);
          modelList.appendChild(gwrap);
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
    { k: "/voice", d: "开启/关闭免费中文语音转文字（Alt+V）", fn: function () { toggleVoiceInput(); } },
    { k: "/theme", d: "切换深色 / 浅色", fn: function () { toggleTheme(); } }
  ];

  function runCommand(text) {
    var parts = text.slice(1).split(/\s+/);
    var cmd = (parts.shift() || "").toLowerCase();
    var arg = parts.join(" ").trim();
    switch (cmd) {
      case "help":
        addNotice("命令：/help /new /model /mode /tools /config /sessions /files /tasks /settings /voice /theme", "info");
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
      case "voice":
        toggleVoiceInput();
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
      ta.addEventListener("input", function () {
        autoGrow(ta);
        updateSlashMenu(ta.value);
        updateAtMenu(ta);
      });
      ta.addEventListener("keydown", function (e) {
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
    if (bModel) { bModel.addEventListener("click", function (e) { e.stopPropagation(); toggleModelMenu(); }); }
    document.addEventListener("click", function (e) {
      var m = $("model-menu");
      if (m && !m.hidden && !m.contains(e.target)) { closeModelMenuSmoothly(); }
      var sm = $("style-menu");
      if (sm && !sm.hidden && !sm.contains(e.target)) { sm.hidden = true; }
      var am = $("at-menu");
      if (am && !am.hidden && !am.contains(e.target) && e.target !== $("btn-at")) { closeAtMenu(); }
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
        if ($("model-menu") && !$("model-menu").hidden) { closeModelMenuSmoothly(); return; }
        if (S.busy) { stopGeneration(); return; }
      }
      if (e.altKey && e.key.toLowerCase() === "v") { e.preventDefault(); toggleVoiceInput(); return; }
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
    // 1. 项目专属指令与常驻知识库（首轮自动挂载知识文件上下文）
    if (S.project && S.project.instructions && S.project.instructions.trim()) {
      parts.push("[项目专属指令 (Project Instructions)：\n" + S.project.instructions.trim() + "]");
    }
    var isFirstTurn = !S.stats || !S.stats.messages;
    if (isFirstTurn && S.project && Array.isArray(S.project.knowledge) && S.project.knowledge.length) {
      var kText = S.project.knowledge.map(function (k) {
        return "--- 知识库文件: " + k.rel + " ---\n" + (k.content || "").slice(0, 6000);
      }).join("\n\n");
      parts.push("[项目常驻知识库 (Project Knowledge)：\n" + kText + "]");
    }
    // 2. 深度思考模式（Extended Thinking）
    if (S.thinking) {
      parts.push("[深度思考模式已开启：在正式回答前，请先在 <think>...</think> 标签内进行结构化、多角度的严密推理与方案权衡，再输出最终解答]");
    }
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
    try { localStorage.setItem(LS_THINKING, S.thinking ? "1" : "0"); } catch (e) {}
    renderThinkingButton();
    toast(S.thinking ? "已开启「深度思考 (Extended Thinking)」模式" : "已关闭深度思考模式", S.thinking ? "ok" : "info");
  }

  /* ---- Claude Projects：项目知识库与专属指令 ---- */
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
    var badge = $("project-count");
    if (!badge) { return; }
    var p = S.project || {};
    var count = ((p.files && p.files.length) || 0) + (p.instructions && p.instructions.trim() ? 1 : 0);
    badge.textContent = String(count);
  }

  function renderProjectSection(root) {
    var p = S.project || {};
    var s = section("项目知识库 (Projects)");
    var headBar = el("div", "fb-head-bar");
    headBar.appendChild(el("span", "empty-note", "专属指令与常驻上下文文件"));
    var editBtn = el("button", "model-action-btn", "管理知识库");
    editBtn.type = "button";
    editBtn.addEventListener("click", openProjectModal);
    headBar.appendChild(editBtn);
    s.body.appendChild(headBar);

    var capBox = el("div", "proj-cap-box");
    var capTop = el("div", "proj-cap-top");
    capTop.appendChild(el("span", null, "知识库容量占用"));
    capTop.appendChild(el("span", "proj-cap-pct", (p.capacityPct || 0) + "% · " + (p.totalTokens || 0) + " tok"));
    capBox.appendChild(capTop);
    var bar = el("div", "progress");
    var fill = el("i");
    fill.style.width = Math.min(100, Math.max(2, p.capacityPct || 0)) + "%";
    bar.appendChild(fill);
    capBox.appendChild(bar);
    s.body.appendChild(capBox);

    var dl = el("dl", "kv");
    kv(dl, "项目指令", p.instructions && p.instructions.trim() ? "已配置 (" + p.instructions.trim().length + " 字)" : "未设置");
    kv(dl, "常驻文件", String((p.files && p.files.length) || 0) + " 个文件");
    s.body.appendChild(dl);

    if (p.knowledge && p.knowledge.length) {
      var flist = el("div", "proj-files-list");
      p.knowledge.forEach(function (k) {
        var row = el("div", "proj-file-item");
        row.appendChild(el("span", "proj-file-name", k.rel));
        row.appendChild(el("span", "proj-file-meta", k.lines + " 行"));
        flist.appendChild(row);
      });
      s.body.appendChild(flist);
    }

    root.appendChild(s.sec);
  }

  function openProjectModal() {
    refreshProjectKnowledge().then(function () {
      var p = S.project || { instructions: "", files: [], knowledge: [] };
      var filesCopy = (p.files || []).slice();
      openModal("项目知识库与专属指令 · Claude Projects", function (body) {
        body.appendChild(el("div", "hint", "在这里配置当前项目的专属指令（Custom Instructions）与常驻知识库文件（Project Knowledge）。每次开启新对话时，MyClaude 都会自动遵循这些规范并参考挂载的文件。"));

        var capBox = el("div", "proj-cap-box");
        var capTop = el("div", "proj-cap-top");
        capTop.appendChild(el("span", null, "当前项目知识容量"));
        var capPctEl = el("span", "proj-cap-pct", (p.capacityPct || 0) + "%（约 " + (p.totalTokens || 0) + " tokens）");
        capTop.appendChild(capPctEl);
        capBox.appendChild(capTop);
        var bar = el("div", "progress");
        var fill = el("i");
        fill.style.width = Math.min(100, Math.max(2, p.capacityPct || 0)) + "%";
        bar.appendChild(fill);
        capBox.appendChild(bar);
        body.appendChild(capBox);

        var instTa = el("textarea", "msg-edit-ta");
        instTa.style.minHeight = "110px";
        instTa.placeholder = "例如：请始终使用 TypeScript 和中文注释；回答时先给架构简图再给代码；遵循函数式不可变数据风格…";
        instTa.value = p.instructions || "";
        body.appendChild(field("项目专属指令（Custom Instructions）", instTa));

        var fileAddRow = el("div", "fb-head-bar");
        fileAddRow.style.marginTop = "8px";
        fileAddRow.appendChild(el("span", "hint", "已挂载的常驻知识库文件："));
        var addSelect = el("select", "archive-policy-select");
        addSelect.style.maxWidth = "240px";
        var defaultOpt = document.createElement("option");
        defaultOpt.value = "";
        defaultOpt.textContent = "+ 从工作区选择文件加入知识库…";
        addSelect.appendChild(defaultOpt);
        fileAddRow.appendChild(addSelect);
        body.appendChild(fileAddRow);

        var filesBox = el("div", "proj-files-list");
        body.appendChild(filesBox);

        function renderModalFiles() {
          clear(filesBox);
          if (!filesCopy.length) {
            filesBox.appendChild(el("div", "empty-note", "暂未挂载常驻文件。可在上方下拉框中选择 README.md、package.json 或核心源码加入知识库。"));
            return;
          }
          filesCopy.forEach(function (rel, idx) {
            var row = el("div", "proj-file-item");
            row.appendChild(el("span", "proj-file-name", rel));
            var del = el("button", "fb-op-btn del", "移除");
            del.type = "button";
            del.addEventListener("click", function () {
              filesCopy.splice(idx, 1);
              renderModalFiles();
            });
            row.appendChild(del);
            filesBox.appendChild(row);
          });
        }
        renderModalFiles();

        getJSON("/api/fs/search?q=").then(function (j) {
          ((j && j.files) || []).forEach(function (f) {
            var opt = document.createElement("option");
            opt.value = f.rel;
            opt.textContent = f.rel + " (" + bytes(f.size) + ")";
            addSelect.appendChild(opt);
          });
        }).catch(function () {});

        addSelect.addEventListener("change", function () {
          var v = addSelect.value;
          addSelect.value = "";
          if (v && filesCopy.indexOf(v) < 0) {
            filesCopy.push(v);
            renderModalFiles();
          }
        });

        body._saveProject = function () {
          postJSON("/api/project", {
            instructions: instTa.value,
            files: filesCopy
          }).then(function (res) {
            if (res && res.ok) {
              S.project = res;
              updateProjectBadge();
              renderInspector();
              toast("已保存项目知识库与专属指令", "ok");
              closeModal();
            }
          }).catch(function (e) {
            toast("保存失败：" + e.message, "err");
          });
        };
      }, [
        { label: "取消", cls: "ghost", fn: closeModal },
        {
          label: "保存项目配置",
          cls: "primary",
          fn: function () {
            var b = $("modal-body");
            if (b && b._saveProject) { b._saveProject(); }
          }
        }
      ]);
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
    getJSON("/api/fs/search?q=" + encodeURIComponent(query || "")).then(function (j) {
      atMatches = (j && j.files) || [];
      if (!atMatches.length) { closeAtMenu(); return; }
      atIndex = Math.min(atIndex, atMatches.length - 1);
      atOpen = true;
      drawAtMenu();
    }).catch(function () { closeAtMenu(); });
  }

  function drawAtMenu() {
    var host = $("at-menu");
    if (!host) { return; }
    host.hidden = false;
    clear(host);
    atMatches.slice(0, 10).forEach(function (f, i) {
      var row = el("button", "slash-item" + (i === atIndex ? " sel" : ""));
      row.type = "button";
      row.appendChild(el("span", "slash-k", "@" + f.rel));
      row.appendChild(el("span", "slash-d", bytes(f.size)));
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
    var ta = $("in");
    if (ta && atStartPos >= 0) {
      var caret = typeof ta.selectionStart === "number" ? ta.selectionStart : ta.value.length;
      ta.value = ta.value.slice(0, atStartPos) + ta.value.slice(caret);
      ta.setSelectionRange(atStartPos, atStartPos);
      autoGrow(ta);
    }
    closeAtMenu();
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

  /* ---- Artifacts 右侧分屏画布与对话内卡片 ---- */
  function isPreviewableArtifact(lang, code) {
    var l = String(lang || "").toLowerCase();
    if (/^(html|htm|svg|xml|markdown|md)$/.test(l)) { return true; }
    if (/^\s*(<!doctype html|<html|<svg)/i.test(code || "")) { return true; }
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
      if (lines < 5 && !isPreviewableArtifact(lang, code)) { return; }

      var ver = S.artifacts.length + 1;
      var artId = "art-" + Date.now() + "-" + ver;
      var previewable = isPreviewableArtifact(lang, code);
      var title = inferArtifactTitle(lang, code, ver);
      var item = {
        id: artId,
        version: ver,
        title: title,
        lang: lang,
        lines: lines,
        code: code,
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

  function switchInspectorTab(tab) {
    S.inspTab = tab === "artifact" ? "artifact" : "info";
    var app = $("app");
    var tInfo = $("tab-insp-info");
    var tArt = $("tab-insp-artifact");
    var bInfo = $("insp-body");
    var bArt = $("artifact-pane");
    if (tInfo) { tInfo.classList.toggle("active", S.inspTab === "info"); }
    if (tArt) { tArt.classList.toggle("active", S.inspTab === "artifact"); }
    if (bInfo) { bInfo.hidden = S.inspTab !== "info"; }
    if (bArt) { bArt.hidden = S.inspTab !== "artifact"; }
    if (app) {
      app.classList.toggle("artifact-open", app.classList.contains("insp-open") && S.inspTab === "artifact");
    }
    if (S.inspTab === "artifact") { renderArtifactStage(); }
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

  function renderArtifactStage() {
    var sel = $("artifact-select");
    var stage = $("artifact-stage");
    var btnPrev = $("btn-art-preview");
    var btnCode = $("btn-art-code");
    var btnEdit = $("btn-art-edit");
    if (!stage || !sel) { return; }
    clear(sel);
    clear(stage);

    if (!S.artifacts.length) {
      stage.appendChild(el("div", "empty-note", "当前对话尚无 Artifact。让 MyClaude 生成 HTML 页面、SVG 图形或代码模块即可在此分屏预览、在线编辑或局部迭代。"));
      return;
    }

    var active = S.artifacts.filter(function (a) { return a.id === S.activeArtifactId; })[0];
    if (!active) {
      active = S.artifacts[S.artifacts.length - 1];
      S.activeArtifactId = active.id;
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
    if (btnEdit) { btnEdit.classList.toggle("active", S.artifactView === "edit"); }

    if (S.artifactView === "edit") {
      var wrap = el("div", "artifact-editor-wrap");
      var head = el("div", "artifact-editor-head");
      head.appendChild(el("span", null, "在线编辑代码 · 修改后点击右侧应用即可实时刷新预览（Ctrl+Enter）"));
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
        toast("已更新 Artifact 代码并刷新预览", "ok");
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
      if (l === "html" || l === "htm" || l === "svg" || l === "xml" || /^\s*(<!doctype html|<html|<svg)/i.test(active.code)) {
        var iframe = document.createElement("iframe");
        iframe.className = "artifact-iframe";
        iframe.setAttribute("sandbox", "allow-scripts allow-modals");
        iframe.srcdoc = active.code;
        stage.appendChild(iframe);
      } else if (l === "md" || l === "markdown") {
        var mdBox = el("div", "artifact-md-preview md");
        mdBox.innerHTML = MD.render(active.code);
        stage.appendChild(mdBox);
      } else {
        // 对于普通代码，在预览模式下提供带行数与语法高亮的清爽阅读画布
        var pre = el("pre", "artifact-code-view");
        pre.textContent = active.code;
        stage.appendChild(pre);
      }
    } else {
      var codePre = el("pre", "artifact-code-view");
      codePre.textContent = active.code;
      stage.appendChild(codePre);
    }
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

  function initClaudeFeatures() {
    try {
      var savedStyle = localStorage.getItem(LS_STYLE);
      if (savedStyle) { S.style = savedStyle; }
      var savedArchive = localStorage.getItem(LS_ARCHIVE_POLICY);
      if (savedArchive) { S.archivePolicy = savedArchive; }
      var savedThinking = localStorage.getItem(LS_THINKING);
      if (savedThinking === "1") { S.thinking = true; }
    } catch (e) {}
    renderStyleButton();
    renderThinkingButton();
    renderArchivePolicyButton();
    refreshProjectKnowledge();

    var btnThinking = $("btn-thinking");
    if (btnThinking) {
      btnThinking.addEventListener("click", function (e) {
        e.stopPropagation();
        toggleThinkingMode();
      });
    }

    var btnProject = $("btn-project");
    if (btnProject) {
      btnProject.addEventListener("click", function () {
        openProjectModal();
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

    var btnAt = $("btn-at");
    if (btnAt) {
      btnAt.addEventListener("click", function (e) {
        e.stopPropagation();
        var ta = $("in");
        if (!ta) { return; }
        var cur = ta.value || "";
        var needSpace = cur.length > 0 && !/\s$/.test(cur);
        ta.value = cur + (needSpace ? " @" : "@");
        ta.focus();
        ta.setSelectionRange(ta.value.length, ta.value.length);
        updateAtMenu(ta);
      });
    }

    var tabInfo = $("tab-insp-info");
    var tabArt = $("tab-insp-artifact");
    if (tabInfo) { tabInfo.addEventListener("click", function () { switchInspectorTab("info"); }); }
    if (tabArt) { tabArt.addEventListener("click", function () { switchInspectorTab("artifact"); }); }

    var selArt = $("artifact-select");
    if (selArt) {
      selArt.addEventListener("change", function () {
        S.activeArtifactId = selArt.value;
        renderArtifactStage();
      });
    }
    var btnPrev = $("btn-art-preview");
    var btnCode = $("btn-art-code");
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
    if (btnEdit) {
      btnEdit.addEventListener("click", function () {
        S.artifactView = "edit";
        renderArtifactStage();
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
  var modelGroupMode = "capability"; // "capability" | "vendor"
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

  function updateModelBtnDot(modelName) {
    var dot = $("model-btn-dot");
    var btn = $("btn-model");
    if (!dot) { return; }
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
    dot.className = "latency-dot " + (modelProbing ? "probing" : perf.tier);
    dot.title = "当前模型延迟：" + perf.ms + "ms（" + perf.label + " · " + cap.tag + "）";
    if (btn) {
      btn.title = "切换模型 · 当前 " + (name || "默认") + "（" + cap.tag + " · " + perf.label + " " + perf.ms + "ms）";
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

  function toggleModelMenu() {
    var menu = $("model-menu");
    if (!menu) { return; }
    if (!menu.hidden) {
      closeModelMenuSmoothly();
      return;
    }
    menu.classList.remove("closing");
    menu.hidden = false;
    drawModelMenu();
    if (!modelCache) {
      fetchModels(false);
    }
  }

  /** 模型菜单的搜索关键词。 */
  var modelQuery = "";

  function drawModelMenu() {
    var menu = $("model-menu");
    if (!menu) { return; }
    clear(menu);
    var cur = (S.config && S.config.model) || "";

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
      drawModelMenu();
      var again = menu.querySelector(".model-search");
      if (again) { again.focus(); again.setSelectionRange(again.value.length, again.value.length); }
    });
    search.addEventListener("keydown", function (e) { e.stopPropagation(); });
    menu.appendChild(search);

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
      { id: "all", label: "全部" },
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
        modelCategoryFilter = tab.id;
        drawModelMenu();
      });
      tabs.appendChild(b);
    });
    menu.appendChild(tabs);

    var entries = allEntries.slice();
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
      menu.appendChild(el("div", "empty-note", "没有匹配的模型"));
    } else if (modelSortFast) {
      var sorted = entries.slice().sort(function (a, b) {
        return modelLatencyOf(a).ms - modelLatencyOf(b).ms;
      });
      var fastBox = el("div", "model-menu-list");
      fastBox.appendChild(buildGroupSection("speed-all", "按响应速度排序 · Fastest First", sorted));
      menu.appendChild(fastBox);
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
      menu.appendChild(capBox);
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
      menu.appendChild(box);
    }
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
    if (params.get("modelmenu") === "1") { setTimeout(toggleModelMenu, 500); }
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

