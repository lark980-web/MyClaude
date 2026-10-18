/* =============================================================================
   markdown.js — a small, dependency-free Markdown renderer.
   Escapes all input first; never trusts model output. Works in the browser
   (window.MyClaudeMarkdown) and in Node (require("../ui/web/js/markdown.js")).
   ========================================================================== */
var MyClaudeMarkdown = (function () {
  "use strict";


  const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

  /** Escape text before it reaches innerHTML. */
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return ESC[c]; });
  }

  /* ------------------------------------------------------- highlighting --- */

  const KEYWORDS = new Set(
    ("abstract as async await break case catch class const continue debugger def default del delete do elif else " +
      "enum except export extends False false finally for from function global if import in instanceof interface is " +
      "lambda let match namespace new None none not null of or pass private protected public raise return self static " +
      "super switch this throw True true try type typeof var void while with yield val fn impl struct trait use mut " +
      "pub mod where loop Some Ok Err").split(" ")
  );

  /**
   * Very small tokeniser: colours comments, strings, numbers, keywords and
   * call-like identifiers. Not a real parser, but it carries the visual signal
   * that matters when reading code in a chat transcript.
   */
  function highlight(code, lang) {
    const text = String(code == null ? "" : code);
    if (!text) return "";
    if (/\b(text|txt|plain|log|diff)\b/i.test(lang || "")) return esc(text);

    let out = "";
    let i = 0;
    const n = text.length;
    const push = function (cls, s) {
      out += cls ? '<span class="' + cls + '">' + esc(s) + "</span>" : esc(s);
    };

    while (i < n) {
      const c = text[i];
      // line comment
      if ((c === "/" && text[i + 1] === "/") || (c === "#" && /python|py|sh|bash|shell|yaml|yml|rb|ruby|toml|conf|ini|ps1|powershell/.test(lang || ""))) {
        const end = text.indexOf("\n", i);
        const stop = end === -1 ? n : end;
        push("tok-c", text.slice(i, stop));
        i = stop;
        continue;
      }
      // block comment
      if (c === "/" && text[i + 1] === "*") {
        const end = text.indexOf("*/", i + 2);
        const stop = end === -1 ? n : end + 2;
        push("tok-c", text.slice(i, stop));
        i = stop;
        continue;
      }
      // strings
      if (c === '"' || c === "'" || c === "`") {
        let j = i + 1;
        while (j < n) {
          if (text[j] === "\\") { j += 2; continue; }
          if (text[j] === c) { j++; break; }
          if (text[j] === "\n" && c !== "`") break;
          j++;
        }
        push("tok-s", text.slice(i, j));
        i = j;
        continue;
      }
      // numbers
      if (/[0-9]/.test(c) && !/[\w$]/.test(text[i - 1] || "")) {
        let j = i;
        while (j < n && /[0-9a-fA-FxXoObB._]/.test(text[j])) j++;
        push("tok-n", text.slice(i, j));
        i = j;
        continue;
      }
      // identifiers / keywords / calls
      if (/[A-Za-z_$]/.test(c)) {
        let j = i;
        while (j < n && /[\w$]/.test(text[j])) j++;
        const word = text.slice(i, j);
        if (KEYWORDS.has(word)) push("tok-k", word);
        else if (text[j] === "(") push("tok-f", word);
        else push("", word);
        i = j;
        continue;
      }
      if ("{}()[];,.<>+-*/%=!&|^~?:".indexOf(c) >= 0) { push("tok-p", c); i++; continue; }
      push("", c);
      i++;
    }
    return out;
  }

  /* ------------------------------------------------------------ inline --- */

  const SCHEME = /^(https?:|mailto:|#|\/|\.{0,2}\/|data:image\/)/i;

  /** Inline spans. Runs on already-escaped text. */
  function inline(raw) {
    let s = esc(raw);
    const stash = [];
    const keep = function (html) { stash.push(html); return "\u0000" + (stash.length - 1) + "\u0000"; };

    // inline code first: its content must not be interpreted further
    s = s.replace(new RegExp("`([^`\n]+)`", "g"), function (m, code) {
      return keep('<code class="inline">' + code + "</code>");
    });

    // Reject dangerous schemes outright (javascript:, vbscript:, file:, data: for
    // anything that is not an image) before link syntax is considered at all.
    s = s.replace(/(!?\[[^\]]*\]\()\s*(javascript|vbscript|file|data)\s*:/gi, function (m, head, scheme) {
      return head + "#blocked-";
    });

    // images
    s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)/g, function (m, alt, src, title) {
      if (!SCHEME.test(src)) return m;
      return keep('<img src="' + src + '" alt="' + alt + '"' + (title ? ' title="' + title + '"' : "") + ' style="max-width:100%;border-radius:8px">');
    });

    // links
    s = s.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)/g, function (m, text, href, title) {
      if (!SCHEME.test(href) && /^[a-z][a-z0-9+.-]*:/i.test(href)) return m;
      const external = /^https?:/i.test(href);
      return keep('<a href="' + href + '"' + (title ? ' title="' + title + '"' : "") + (external ? ' target="_blank" rel="noopener noreferrer"' : "") + ">" + text + "</a>");
    });

    // bare autolinks
    s = s.replace(/(^|[\s(])(https?:\/\/[^\s<)\]]+)/g, function (m, pre, url) {
      return pre + keep('<a href="' + url + '" target="_blank" rel="noopener noreferrer">' + url + "</a>");
    });

    // emphasis (strong before em so ***x*** becomes strong+em)
    s = s.replace(/\*\*\*([^*]+)\*\*\*/g, "<strong><em>$1</em></strong>");
    s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    s = s.replace(/(^|[^\w*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
    s = s.replace(/(^|[^\w_])__([^_]+)__/g, "$1<strong>$2</strong>");
    s = s.replace(/(^|[^\w_])_([^_\n]+)_/g, "$1<em>$2</em>");
    s = s.replace(/~~([^~]+)~~/g, "<del>$1</del>");

    s = s.replace(/\u0000(\d+)\u0000/g, function (m, i) { return stash[Number(i)] || ""; });
    return s;
  }

  /* ------------------------------------------------------------ blocks --- */

  function isTableSep(line) {
    return /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{1,}:?\s*)+\|?\s*$/.test(line || "");
  }

  function splitRow(line) {
    let s = String(line).trim();
    if (s.charAt(0) === "|") s = s.slice(1);
    if (s.charAt(s.length - 1) === "|") s = s.slice(0, -1);
    const cells = [];
    let cur = "";
    for (let i = 0; i < s.length; i++) {
      if (s[i] === "\\" && s[i + 1] === "|") { cur += "|"; i++; continue; }
      if (s[i] === "|") { cells.push(cur); cur = ""; continue; }
      cur += s[i];
    }
    cells.push(cur);
    return cells.map(function (c) { return c.trim(); });
  }

  function codeBlock(lang, code) {
    const l = String(lang || "").trim();
    return (
      '<div class="codeblock"><div class="cb-head"><span class="cb-lang">' + esc(l || "text") +
      '</span><button class="cb-copy" type="button" data-copy>复制</button></div>' +
      "<pre><code>" + highlight(code.replace(/\n$/, ""), l) + "</code></pre></div>"
    );
  }

  /**
   * Render Markdown to HTML.
   * @param {string} src
   * @returns {string}
   */
  function render(src) {
    const lines = String(src == null ? "" : src).replace(/\r\n?/g, "\n").split("\n");
    const out = [];
    let i = 0;
    const para = [];

    const flush = function () {
      if (!para.length) return;
      const text = para.join("\n").replace(/( {2,}|\\)\n/g, "<br>");
      out.push("<p>" + inline(text) + "</p>");
      para.length = 0;
    };

    while (i < lines.length) {
      const line = lines[i];
      const fence = /^\s*(`{3,}|~{3,})\s*([\w+-]*)\s*$/.exec(line);

      if (fence) {
        flush();
        const marker = fence[1].charAt(0);
        const lang = fence[2] || "";
        const body = [];
        i++;
        const close = new RegExp("^\\s*" + (marker === "`" ? "`{3,}" : "~{3,}") + "\\s*$");
        while (i < lines.length && !close.test(lines[i])) { body.push(lines[i]); i++; }
        i++;
        out.push(codeBlock(lang, body.join("\n")));
        continue;
      }

      if (!line.trim()) { flush(); i++; continue; }

      const h = /^(#{1,6})\s+(.*)$/.exec(line);
      if (h && !para.length) {
        const level = h[1].length;
        const text = h[2].replace(/\s+#+\s*$/, "");
        out.push("<h" + level + ">" + inline(text) + "</h" + level + ">");
        i++;
        continue;
      }

      if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { flush(); out.push("<hr>"); i++; continue; }

      if (line.indexOf("|") >= 0 && i + 1 < lines.length && isTableSep(lines[i + 1])) {
        flush();
        const head = splitRow(line);
        i += 2;
        const rows = [];
        while (i < lines.length && lines[i].indexOf("|") >= 0 && lines[i].trim()) { rows.push(splitRow(lines[i])); i++; }
        let html = "<table><thead><tr>" + head.map(function (c) { return "<th>" + inline(c) + "</th>"; }).join("") + "</tr></thead><tbody>";
        rows.forEach(function (r) {
          html += "<tr>" + head.map(function (_, k) { return "<td>" + inline(r[k] == null ? "" : r[k]) + "</td>"; }).join("") + "</tr>";
        });
        out.push(html + "</tbody></table>");
        continue;
      }

      if (/^\s*>\s?/.test(line)) {
        flush();
        const body = [];
        while (i < lines.length && /^\s*>\s?/.test(lines[i])) { body.push(lines[i].replace(/^\s*>\s?/, "")); i++; }
        out.push("<blockquote>" + render(body.join("\n")) + "</blockquote>");
        continue;
      }

      const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
      const ordered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
      if (bullet || ordered) {
        flush();
        const isOrdered = !!ordered && !bullet;
        const items = [];
        while (i < lines.length) {
          const m = isOrdered ? /^\s*\d+[.)]\s+(.*)$/.exec(lines[i]) : /^\s*[-*+]\s+(.*)$/.exec(lines[i]);
          if (!m) break;
          items.push(m[1]);
          i++;
          while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !/^\s*([-*+]|\d+[.)])\s+/.test(lines[i])) {
            items[items.length - 1] += "\n" + lines[i].trim();
            i++;
          }
        }
        const tag = isOrdered ? "ol" : "ul";
        const rendered = items.map(function (raw) {
          const task = /^\[([ xX])\]\s+(.*)$/.exec(raw);
          if (task) {
            const done = task[1].toLowerCase() === "x";
            return '<li class="task' + (done ? " done" : "") + '"><span class="task-box">&#10003;</span><span>' + inline(task[2].replace(/\n/g, " ")) + "</span></li>";
          }
          return "<li>" + inline(raw.replace(/\n/g, "<br>")) + "</li>";
        }).join("");
        out.push("<" + tag + ">" + rendered + "</" + tag + ">");
        continue;
      }

      para.push(line);
      i++;
    }
    flush();
    return out.join("\n");
  }

  /** Plain-text projection, used for chat titles and clipboard fallbacks. */
  function toText(src) {
    return String(src == null ? "" : src)
      .replace(new RegExp("`{3}[\\s\\S]*?`{3}", "g"), " ")
      .replace(new RegExp("`([^`]+)`", "g"), "$1")
      .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      .replace(/[*_~#>|]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }


  /* ------------------------------------------------------------------ diff --- */

  /**
   * Parse a unified diff into per-file hunks the GUI can colour.
   * Mirrors src/tools/git.js so a restored transcript renders the same way it
   * did live.
   */
  function parseUnifiedDiff(text) {
    var files = [];
    var current = null;
    var lines = String(text == null ? "" : text).split(/\r?\n/);

    for (var i = 0; i < lines.length; i++) {
      var raw = lines[i];
      if (raw.indexOf("diff --git") === 0) {
        var m = /b\/(.+)$/.exec(raw);
        current = { name: m ? m[1] : raw, added: 0, removed: 0, hunks: [] };
        files.push(current);
        continue;
      }
      if (!current) { continue; }

      if (raw.indexOf("@@") === 0) {
        current.hunks.push({ header: raw, lines: [] });
        continue;
      }
      if (raw.indexOf("--- ") === 0 || raw.indexOf("+++ ") === 0 ||
          raw.indexOf("index ") === 0 || raw.indexOf("new file") === 0 ||
          raw.indexOf("deleted file") === 0 || raw.indexOf("old mode") === 0 ||
          raw.indexOf("new mode") === 0 || raw.indexOf("similarity") === 0 ||
          raw.indexOf("rename ") === 0 || raw.indexOf("copy ") === 0) {
        current.hunks.push({ header: null, lines: [{ type: "meta", text: raw }] });
        continue;
      }
      var hunk = current.hunks[current.hunks.length - 1];
      if (!hunk || hunk.header === null) {
        current.hunks.push({ header: null, lines: [{ type: "meta", text: raw }] });
        continue;
      }
      if (raw.charAt(0) === "+") {
        hunk.lines.push({ type: "add", text: raw.slice(1) });
        current.added++;
      } else if (raw.charAt(0) === "-") {
        hunk.lines.push({ type: "del", text: raw.slice(1) });
        current.removed++;
      } else if (raw.charAt(0) === "\\") {
        hunk.lines.push({ type: "meta", text: raw });
      } else {
        hunk.lines.push({ type: "ctx", text: raw.replace(/^ /, "") });
      }
    }
    return files;
  }

  return { render: render, toText: toText, esc: esc, highlight: highlight, parseUnifiedDiff: parseUnifiedDiff };
})();

if (typeof module === "object" && module.exports) module.exports = MyClaudeMarkdown;
if (typeof window !== "undefined") window.MyClaudeMarkdown = MyClaudeMarkdown;
