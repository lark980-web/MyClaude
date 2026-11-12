/**
 * Extended tool set: WebSearch, NotebookEdit, AskUserQuestion, ExitPlanMode,
 * EnterPlanMode, Skill.
 * These complete the Claude Code-style tool surface alongside the core
 * file/bash tools in index.js and the task tools in tasks.js.
 */

import { upstreamSchema, upstreamDescription } from "./upstream-schemas.js";
import { findSkill, skillCatalogue } from "../skills.js";

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
  async run({ query, allowed_domains, blocked_domains, block_domains, max_results = 10 }) {
    // 上游 2.1.302 用 blocked_domains（带 ed），自研用 block_domains —— 两套都收。
    if (blocked_domains !== undefined && block_domains === undefined) { block_domains = blocked_domains; }
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

/**
 * The plan most recently proposed through ExitPlanMode.
 *
 * Claude keeps the plan in a file and offers "/plan open" to edit it. Here the
 * approved plan is held so /plan can show it again, and saved to disk when a
 * session id is known.
 */
// An autonomous run cannot answer questions: a pending dialog would stall
// the walk for its whole timeout. When the flag is on the tool refuses
// instead, telling the model to decide and carry on.
let autonomousMode = false;

/** Toggle AskUserQuestion off for autonomous runs. */
export function setAutonomous(v) { autonomousMode = !!v; return autonomousMode; }

let lastPlan = null;

/** The plan most recently proposed, or null when there is none. */
export function getLastPlan() {
  return lastPlan;
}

let planSessionId = null;

/**
 * Tell the tools which session a plan belongs to, so an approved plan can be
 * written to disk and shown again later by /plan.
 *
 * @param {string|null} id
 */
export function setPlanSessionId(id) {
  planSessionId = id || null;
  return planSessionId;
}


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
      if (autonomousMode) {
        return { ok: false, content: "自主模式运行中：不要提问，请自行做出合理决策并继续任务。" };
      }
    if (!Array.isArray(questions) || !questions.length) return err("questions must be a non-empty array");
    // 上游 2.1.302 的 schema 用 multiSelect（camelCase），MyClaude 的 TUI/GUI presenter
    // 读 multi_select —— run 入口一次性归一，两边命名都能到达 presenter。
    for (const q of questions) {
      if (q && q.multiSelect !== undefined && q.multi_select === undefined) {
        q.multi_select = q.multiSelect;
      }
    }
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
      // Remember the approved plan: /plan shows it again, and "/plan open"
      // hands it to the editor the way Claude does.
      lastPlan = String(plan || "");
      if (planSessionId) {
        try {
          const { savePlan } = await import("../session.js");
          savePlan(planSessionId, lastPlan);
        } catch { /* a lost plan must not block execution */ }
      }
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

/* --------------------------------------------------------------- EnterPlanMode */

let modeController = null;
/** runtime 把 agent.setMode 交进来：工具自身不持有 agent 引用（与 presenter 同模式）。 */
export function setModeController(fn) {
  modeController = typeof fn === "function" ? fn : null;
}

export const enterPlanModeTool = {
  name: "EnterPlanMode",
  description:
    upstreamDescription("EnterPlanMode") ||
    "Requests permission to enter plan mode for complex tasks requiring exploration and design",
  input_schema:
    upstreamSchema("EnterPlanMode") || { type: "object", properties: {}, additionalProperties: false },
  async run() {
    if (!pendingQuestion) {
      // 非交互会话没有提问通道：如实拒绝，不静默切模式。
      return err("plan mode requires an interactive session");
    }
    const answer = await pendingQuestion([
      {
        question: "Enter plan mode?",
        header: "Plan mode",
        options: [
          { label: "Enter plan mode", description: "Explore and design first; no file edits until the plan is approved" },
          { label: "Stay", description: "Keep the current permission mode" },
        ],
      },
    ]);
    const first = Array.isArray(answer) ? answer[0] : answer;
    if (String(first).toLowerCase().startsWith("enter")) {
      if (modeController) { modeController("plan"); }
      return ok("entered plan mode — explore the code, design an approach, then call ExitPlanMode");
    }
    return err("stayed in the current mode");
  },
};

/* --------------------------------------------------------------- Skill */

export const skillTool = {
  name: "Skill",
  // 上游按注册的 skill 动态生成 description（运行时抽到 "Execute skill: undefined" ——
  // 这是上游注册器的生成残渣，不能照抄）。这里用上游 Skill 工具的**真实**静态描述
  // （chunk-e0x0xb6d.js var dpr，逐字），只把 ${system-reminder} 占位符填回字面量。
  description:
    `Invoke a skill.

A skill is a packaged set of instructions the user or project has set up for a particular kind of task (deploy steps, a review checklist, a repo-specific workflow). Available skills appear in a system-reminder listing with one-line descriptions. When the task at hand is one a listed skill covers, call this tool first \u2014 the skill's instructions load into the turn for you to follow in place of your default approach; some skills instead run in a subagent and return the finished result. A skill that runs in the background returns only the agent's name \u2014 its result arrives later as a task notification, so don't wait on it or invoke it again in the meantime. Users may also ask for one by name (\`/<name>\`, or "slash command"); that's a request to invoke it.

- \`skill\`: exact name from the listing, no leading slash. Plugin skills use \`plugin:skill\`.
- \`args\`: optional arguments to pass through.

Only names from the listing (or that the user typed explicitly) are valid. Built-in CLI commands (\`/help\`, \`/clear\`, \u2026) aren't skills. If a \`<system-reminder>\` block is already present this turn, the skill is loaded \u2014 follow it directly rather than calling again.`,
  input_schema:
    upstreamSchema("Skill") || {
      type: "object",
      properties: {
        skill: { type: "string", description: "The name of a skill from the available-skills list. Do not guess names." },
        args: { type: "string", description: "Optional arguments for the skill" },
      },
      required: ["skill"],
      additionalProperties: false,
    },
  async run({ skill, args }) {
    const name = String(skill || "").trim();
    if (!name) { return err("skill name is required"); }
    const s = findSkill(name);
    if (!s) {
      const avail = skillCatalogue().map((x) => x.name).slice(0, 15).join(", ");
      return err("unknown skill: " + name + (avail ? " — available: " + avail : ""));
    }
    const header = "skill: " + s.name + (s.description ? " — " + s.description : "");
    const tail = args ? "\n\n[skill args]: " + String(args) : "";
    return ok(header + "\n\n" + String(s.body || "") + tail);
  },
};

export const EXTENDED_TOOLS = [
  webSearchTool,
  notebookReadTool,
  notebookEditTool,
  askUserQuestionTool,
  exitPlanModeTool,
  enterPlanModeTool,
  skillTool,
];
