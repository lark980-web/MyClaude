/**
 * Extended tool set: WebSearch, NotebookEdit, AskUserQuestion, ExitPlanMode.
 * These complete the Claude Code-style tool surface alongside the core
 * file/bash tools in index.js and the task tools in tasks.js.
 */

function ok(content, extra = {}) {
  return { ok: true, content, ...extra };
}
function err(content) {
  return { ok: false, content };
}

/* ------------------------------------------------------------------ WebSearch */

const SEARCH_ENGINES = [
  {
    name: "duckduckgo",
    url: "https://html.duckduckgo.com/html/?q=",
    parse: (html) => {
      const out = [];
      const re = /<a[^>]+class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
      let m;
      while ((m = re.exec(html)) && out.length < 12) {
        const title = decodeEntities(m[2].replace(/<[^>]+>/g, ""));
        let href = decodeEntities(m[1]);
        const uddg = /[?&]uddg=([^&]+)/.exec(href);
        if (uddg) href = decodeURIComponent(uddg[1]);
        out.push({ title, url: href });
      }
      return out;
    },
  },
];

function decodeEntities(s) {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
}

export const webSearchTool = {
  name: "WebSearch",
  description:
    "Search the web for a query and return result titles, URLs and snippets. " +
    "Use allowed_domains to restrict or block_domains to exclude specific sites.",
  input_schema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Search query" },
      allowed_domains: {
        type: "array",
        items: { type: "string" },
        description: "Only return results from these domains",
      },
      block_domains: {
        type: "array",
        items: { type: "string" },
        description: "Exclude results from these domains",
      },
      max_results: { type: "number", description: "Maximum results (default 10)" },
    },
    required: ["query"],
  },
  async run({ query, allowed_domains, block_domains, max_results = 10 }) {
    if (!query || !String(query).trim()) return err("query is required");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30000);
    try {
      const engine = SEARCH_ENGINES[0];
      const res = await fetch(engine.url + encodeURIComponent(query), {
        signal: controller.signal,
        headers: { "User-Agent": "Mozilla/5.0 (compatible; MyClaude/0.2)" },
      });
      const html = await res.text();
      let results = engine.parse(html);
      const allow = (allowed_domains || []).map((d) => d.replace(/^www\./, ""));
      const block = (block_domains || []).map((d) => d.replace(/^www\./, ""));
      if (allow.length) results = results.filter((r) => allow.some((d) => host(r.url).includes(d)));
      if (block.length) results = results.filter((r) => !block.some((d) => host(r.url).includes(d)));
      if (!results.length) return ok(`(no results for: ${query})`);
      const lines = results.slice(0, max_results).map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}`);
      return ok(`Search results for "${query}"\n\n${lines.join("\n")}`);
    } catch (e) {
      if (e.name === "AbortError") return err("search timed out after 30s");
      return err(`search failed: ${e.message}`);
    } finally {
      clearTimeout(timer);
    }
  },
};

function host(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

/* --------------------------------------------------------------- NotebookEdit */

export const notebookEditTool = {
  name: "NotebookEdit",
  description:
    "Edit a Jupyter notebook (.ipynb) cell: replace, insert or delete a cell identified by cell_id, " +
    "cell index, or a markdown/code heading. Works on both classic .ipynb and percent-format scripts.",
  input_schema: {
    type: "object",
    properties: {
      notebook_path: { type: "string", description: "Absolute path to .ipynb file" },
      cell_id: { type: "string", description: "Cell id (for .ipynb) or heading text (for percent scripts)" },
      cell_index: { type: "number", description: "Zero-based cell index (alternative to cell_id)" },
      new_source: { type: "string", description: "New cell contents" },
      cell_type: { type: "string", enum: ["code", "markdown"], description: "Cell type when inserting" },
      edit_mode: {
        type: "string",
        enum: ["replace", "insert", "delete"],
        description: "replace (default), insert, or delete",
      },
    },
    required: ["notebook_path", "new_source"],
  },
  async run({ notebook_path, cell_id, cell_index, new_source, cell_type = "code", edit_mode = "replace" }) {
    const { readFile, writeFile, stat } = await import("node:fs/promises");
    let text;
    try {
      await stat(notebook_path);
      text = await readFile(notebook_path, "utf8");
    } catch (e) {
      return err(`${e.code || "ERR"}: ${e.message}`);
    }

    if (notebook_path.endsWith(".ipynb") || text.trimStart().startsWith("{")) {
      let nb;
      try {
        nb = JSON.parse(text);
      } catch {
        return err("notebook is not valid JSON");
      }
      if (!nb.cells || !Array.isArray(nb.cells)) return err("notebook has no cells array");
      let idx = -1;
      if (cell_id) idx = nb.cells.findIndex((c) => c.id === cell_id);
      if (idx < 0 && typeof cell_index === "number") idx = cell_index;
      if (idx < 0 && cell_id) {
        idx = nb.cells.findIndex((c) =>
          (c.source || []).join("").toLowerCase().includes(String(cell_id).toLowerCase())
        );
      }
      if (edit_mode === "insert") {
        const at = idx < 0 ? nb.cells.length : idx + 1;
        nb.cells.splice(at, 0, {
          cell_type,
          metadata: {},
          source: String(new_source).split("\n").map((l, i, a) => (i < a.length - 1 ? l + "\n" : l)),
          ...(cell_type === "code" ? { outputs: [], execution_count: null } : {}),
        });
        await writeFile(notebook_path, JSON.stringify(nb, null, 1) + "\n", "utf8");
        return ok(`inserted ${cell_type} cell at index ${at}`);
      }
      if (idx < 0) return err(`cell not found (cell_id=${cell_id ?? "-"} cell_index=${cell_index ?? "-"})`);
      if (edit_mode === "delete") {
        nb.cells.splice(idx, 1);
        await writeFile(notebook_path, JSON.stringify(nb, null, 1) + "\n", "utf8");
        return ok(`deleted cell ${idx}`);
      }
      nb.cells[idx].source = String(new_source)
        .split("\n")
        .map((l, i, a) => (i < a.length - 1 ? l + "\n" : l));
      await writeFile(notebook_path, JSON.stringify(nb, null, 1) + "\n", "utf8");
      return ok(`replaced cell ${idx} in ${notebook_path}`);
    }

    // percent-format fallback
    const cells = splitPercentCells(text);
    let idx = typeof cell_index === "number" ? cell_index : cells.findIndex((c) => c.heading === cell_id);
    if (edit_mode === "insert") {
      const at = idx < 0 ? cells.length : idx + 1;
      cells.splice(at, 0, { heading: cell_type, body: String(new_source) });
    } else if (idx < 0) {
      return err(`cell not found: ${cell_id ?? cell_index}`);
    } else if (edit_mode === "delete") {
      cells.splice(idx, 1);
    } else {
      cells[idx] = { heading: cells[idx].heading, body: String(new_source) };
    }
    await writeFile(notebook_path, cells.map((c) => `# %% ${c.heading}\n${c.body}\n`).join("\n"), "utf8");
    return ok(`${edit_mode} percent cell at index ${Math.max(0, idx)} in ${notebook_path}`);
  },
};

function splitPercentCells(text) {
  const parts = text.split(/^# %%.*$/m);
  const heads = [...text.matchAll(/^# %%.*$/gm)].map((m) => m[0].replace(/^# %%\s*/, "").trim());
  return parts
    .slice(1)
    .map((body, i) => ({ heading: heads[i] || "code", body: body.trim() }));
}

/* ------------------------------------------------------------ AskUserQuestion */

let pendingQuestion = null;
let pendingResolver = null;

export function setQuestionPresenter(presenter) {
  pendingQuestion = presenter;
}

export function answerQuestion(answer) {
  const r = pendingResolver;
  pendingResolver = null;
  r?.(answer);
}

export const askUserQuestionTool = {
  name: "AskUserQuestion",
  description:
    "Ask the user one or more clarifying questions and wait for their answers. " +
    "Use when requirements are ambiguous before acting.",
  input_schema: {
    type: "object",
    properties: {
      questions: {
        type: "array",
        minItems: 1,
        items: {
          type: "object",
          properties: {
            question: { type: "string" },
            header: { type: "string", description: "Short label, max 30 chars" },
            options: {
              type: "array",
              minItems: 2,
              items: {
                type: "object",
                properties: {
                  label: { type: "string" },
                  description: { type: "string" },
                },
                required: ["label", "description"],
              },
            },
            multi_select: { type: "boolean" },
          },
          required: ["question", "header", "options"],
        },
      },
    },
    required: ["questions"],
  },
  async run({ questions }) {
    if (!Array.isArray(questions) || !questions.length) return err("questions must be a non-empty array");
    if (!pendingQuestion) {
      return err("no interactive presenter available (AskUserQuestion requires a TUI or GUI session)");
    }
    const answers = await pendingQuestion(questions);
    if (answers == null) return err("question was dismissed without an answer");
    const text = questions
      .map((q, i) => {
        const a = answers[i];
        return `Q: ${q.question}\nA: ${Array.isArray(a) ? a.join(", ") : a}`;
      })
      .join("\n\n");
    return ok(text);
  },
};

/* --------------------------------------------------------------- ExitPlanMode */

export const exitPlanModeTool = {
  name: "ExitPlanMode",
  description:
    "Call when you have finished planning in plan mode and are ready to execute. " +
    "Presents the plan for user approval; the agent must not edit files until approved.",
  input_schema: {
    type: "object",
    properties: {
      plan: { type: "string", description: "The proposed plan in markdown" },
    },
    required: ["plan"],
  },
  async run({ plan }) {
    if (!pendingQuestion) {
      // Non-interactive: treat as an immediate refusal to leave plan mode.
      return err("plan approval requires an interactive session");
    }
    const answer = await pendingQuestion([
      {
        question: "Approve this plan?",
        header: "Plan approval",
        options: [
          { label: "Approve", description: "Execute the plan and start editing files" },
          { label: "Reject", description: "Stay in plan mode and keep refining" },
        ],
      },
    ]);
    const first = Array.isArray(answer) ? answer[0] : answer;
    if (String(first).toLowerCase().startsWith("approve")) {
      return ok("plan approved — you may now execute");
    }
    return err("plan rejected — stay in plan mode");
  },
};

/* ------------------------------------------------------------------ NotebookRead */

export const notebookReadTool = {
  name: "NotebookRead",
  description: "Read a Jupyter notebook and return each cell with its index, type, source and outputs.",
  input_schema: {
    type: "object",
    properties: {
      notebook_path: { type: "string", description: "Absolute path to .ipynb file" },
    },
    required: ["notebook_path"],
  },
  async run({ notebook_path }) {
    const { readFile, stat } = await import("node:fs/promises");
    try {
      await stat(notebook_path);
      const text = await readFile(notebook_path, "utf8");
      const nb = JSON.parse(text);
      if (!nb.cells?.length) return err("(empty notebook)");
      const lines = nb.cells.map((c, i) => {
        const src = (c.source || []).join("");
        let out = "";
        if (c.cell_type === "code" && c.outputs?.length) {
          out =
            "\n   " +
            c.outputs
              .map((o) => {
                const t = o.text || (o.data ? Object.values(o.data).flat().join("") : "");
                return String(t).split("\n").slice(0, 10).join("\n   ");
              })
              .join("\n   ");
        }
        return `${i}. [${c.cell_type}] ${src.split("\n")[0].slice(0, 100)}${out ? `\n   ⎿ ${out.trim()}` : ""}`;
      });
      return ok(`${nb.cells.length} cells in ${notebook_path}\n\n${lines.join("\n")}`);
    } catch (e) {
      return err(`${e.code || "ERR"}: ${e.message}`);
    }
  },
};

export const EXTENDED_TOOLS = [
  webSearchTool,
  notebookReadTool,
  notebookEditTool,
  askUserQuestionTool,
  exitPlanModeTool,
];
