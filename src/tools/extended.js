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

/* --------------------------------------------- Computer Use（浏览器动作面） */

// 上游 2.1.302 的 computer 工具族（Claude in Chrome）：schema 从
// chunk-1h2r50md.js 逐字提取。执行宿主不同 —— 上游走扩展桥，MyClaude 走
// 本机 CDP（browser-cdp.js），动作面与 schema 保持逐字对齐。
// 仅当 config.computerUse 开启时注册（runtime.createAgent / gui-server）。

const UP = {
  clickHint:
    "* Whenever you intend to click on an element like an icon, you should consult a screenshot to determine the coordinates of the element before moving the cursor.\n" +
    "* If you tried clicking on a program or link but it failed to load, even after waiting, try adjusting your click location so that the tip of the cursor visually falls on the element that you want to click.\n" +
    "* Make sure to click any buttons, links, icons, etc with the cursor tip in the center of the element. Don't click boxes on their edges unless asked.",
  tabHint: "Use tabs_context_mcp first if you don't have a valid tab ID.",
};

export const computerTool = {
  name: "computer",
  description: `Use a mouse and keyboard to interact with a web browser, and take screenshots. If you don't have a valid tab ID, use tabs_context_mcp first to get available tabs.\n${UP.clickHint}`,
  input_schema: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["left_click", "right_click", "type", "screenshot", "wait", "scroll", "key", "left_click_drag", "double_click", "triple_click", "zoom", "scroll_to", "hover"],
        description:
          "The action to perform:\n* `left_click`: Click the left mouse button at the specified coordinates.\n* `right_click`: Click the right mouse button at the specified coordinates to open context menus.\n* `double_click`: Double-click the left mouse button at the specified coordinates.\n* `triple_click`: Triple-click the left mouse button at the specified coordinates.\n* `type`: Type a string of text.\n* `screenshot`: Take a screenshot of the screen.\n* `wait`: Wait for a specified number of seconds.\n* `scroll`: Scroll up, down, left, or right at the specified coordinates.\n* `key`: Press a specific keyboard key.\n* `left_click_drag`: Drag from start_coordinate to coordinate.\n* `zoom`: Take a screenshot of a specific region for closer inspection.\n* `scroll_to`: Scroll an element into view using its element reference ID from read_page or find tools.\n* `hover`: Move the mouse cursor to the specified coordinates or element without clicking. Useful for revealing tooltips, dropdown menus, or triggering hover states.",
      },
      coordinate: { type: "array", items: { type: "number" }, minItems: 2, maxItems: 2, description: "(x, y): The x (pixels from the left edge) and y (pixels from the top edge) coordinates. Required for `left_click`, `right_click`, `double_click`, `triple_click`, and `scroll`. For `left_click_drag`, this is the end position." },
      text: { type: "string", description: "The text to type (for `type` action) or the key(s) to press (for `key` action). For `key` action: Provide space-separated keys (e.g., \"Backspace Backspace Delete\"). Supports keyboard shortcuts using the platform's modifier key (use \"cmd\" on Mac, \"ctrl\" on Windows/Linux, e.g., \"cmd+a\" or \"ctrl+a\" for select all). Page zoom shortcuts (e.g. \"cmd+=\", \"ctrl+-\", \"cmd+0\") are not supported and will return an error - use the `zoom` action to magnify a region of the page instead." },
      duration: { type: "number", minimum: 0, maximum: 10, description: "The number of seconds to wait. Required for `wait`. Maximum 10 seconds." },
      scroll_direction: { type: "string", enum: ["up", "down", "left", "right"], description: "The direction to scroll. Required for `scroll`." },
      scroll_amount: { type: "number", minimum: 1, maximum: 10, description: "The number of scroll wheel ticks. Optional for `scroll`, defaults to 3." },
      start_coordinate: { type: "array", items: { type: "number" }, minItems: 2, maxItems: 2, description: "(x, y): The starting coordinates for `left_click_drag`." },
      region: { type: "array", items: { type: "number" }, minItems: 4, maxItems: 4, description: "(x0, y0, x1, y1): The rectangular region to capture for `zoom`. Coordinates define a rectangle from top-left (x0, y0) to bottom-right (x1, y1) in pixels from the viewport origin. Required for `zoom` action. Useful for inspecting small UI elements like icons, buttons, or text." },
      scale: { type: "number", minimum: 0.1, maximum: 1, description: "For `screenshot` and `zoom` only. Scale factor in [0.1, 1] for the returned image; 1 (default) uses the full image token budget, 0.5 returns an image at half the width and height (~quarter of the tokens). This backend returns the full-resolution image regardless." },
      repeat: { type: "number", minimum: 1, maximum: 100, description: "Number of times to repeat the key sequence. Only applicable for `key` action. Must be a positive integer between 1 and 100. Default is 1. Useful for navigation tasks like pressing arrow keys multiple times." },
      ref: { type: "string", description: "Element reference ID from read_page or find tools (e.g., \"ref_1\", \"ref_2\"). Required for `scroll_to` action. Can be used as alternative to `coordinate` for click actions." },
      modifiers: { type: "string", description: "Modifier keys for click actions. Supports: \"ctrl\", \"shift\", \"alt\", \"cmd\" (or \"meta\"), \"win\" (or \"windows\"). Can be combined with \"+\" (e.g., \"ctrl+shift\", \"cmd+alt\"). Optional." },
      tabId: { type: "number", description: "Tab ID to execute the action on. Must be a tab in the current group. Use tabs_context_mcp first if you don't have a valid tab ID." },
      save_to_disk: { type: "boolean", description: "For screenshot/zoom actions: save the image to disk so it can be attached to a message for the user. Returns the saved path in the tool result. Only set this when you intend to share the image \u2014 screenshots you're just looking at don't need saving." },
    },
    required: ["action", "tabId"],
  },
  async run(input) {
    const { runComputerAction, persistScreenshot } = await import("./browser-cdp.js");
    const out = await runComputerAction(input);
    if ((input.action === "screenshot" || input.action === "zoom") && input.save_to_disk && out.attachments?.[0]?.source?.data) {
      const file = persistScreenshot(out.attachments[0].source.data);
      out.content += ` — saved to ${file}`;
      out.persistedOutputPath = file;
    }
    return out.attachments ? ok(out.content, { attachments: out.attachments }) : ok(out.content);
  },
};

export const navigateTool = {
  name: "navigate",
  description: `Navigate to a URL, or go forward/back in browser history. tabId may be omitted for URL navigation when calling navigate STANDALONE (not inside browser_batch): tabs_context_mcp{createIfEmpty:true} is called for you and the first tab in the session's group is navigated \u2014 its result is appended to this call's output so you have the tab list and ids for subsequent calls. Inside browser_batch, navigate (and other tools that act on a page) requires an explicit tabId. Pass an explicit tabId when you need a specific tab or when the session's group has multiple tabs whose state you must preserve. tabId is required for url:"back"/"forward".`,
  input_schema: {
    type: "object",
    properties: {
      url: { type: "string", description: "The URL to navigate to. Can be provided with or without protocol (defaults to https://). Use \"forward\" to go forward in history or \"back\" to go back in history." },
      tabId: { type: "number", description: "Tab ID to navigate. Must be a tab in the current group. If omitted for URL navigation when calling navigate standalone, tabs_context_mcp{createIfEmpty:true} is called for you. Required for url:\"back\"/\"forward\" and for navigate (and other tools that act on a page) inside browser_batch." },
    },
    required: ["url"],
  },
  async run(input) {
    const { runNavigate, listTabs } = await import("./browser-cdp.js");
    const out = await runNavigate(input);
    if (input.tabId === undefined) {
      const tabs = await listTabs();
      return ok(out.content + "\n" + (out.content ? "" : "") + tabs.map((t) => `- tabId ${t.tabId}: ${t.url}`).join("\n"));
    }
    return ok(out.content);
  },
};

export const tabsContextTool = {
  name: "tabs_context_mcp",
  title: "Tabs Context",
  description: "Get context information about the current MCP tab group. Returns all tab IDs inside the group if it exists. CRITICAL: You must get the context at least once before using other browser automation tools so you know what tabs exist.",
  input_schema: { type: "object", properties: {}, additionalProperties: false },
  async run() {
    const { runTabsList } = await import("./browser-cdp.js");
    const out = await runTabsList();
    return ok(out.content);
  },
};

export const tabsCreateTool = {
  name: "tabs_create_mcp",
  description: "Create a new browser tab. Returns the new tab's ID for use with other browser tools.",
  input_schema: {
    type: "object",
    properties: { url: { type: "string", description: "URL to open in the new tab (defaults to a blank page)." } },
    additionalProperties: false,
  },
  async run(input) {
    const { runTabsCreate } = await import("./browser-cdp.js");
    const out = await runTabsCreate(input);
    return ok(out.content);
  },
};

export const tabsCloseTool = {
  name: "tabs_close_mcp",
  description: "Close a browser tab by ID. Clean up tabs you created once you no longer need them.",
  input_schema: {
    type: "object",
    properties: { tabId: { type: "number", description: "Tab ID to close." } },
    required: ["tabId"],
  },
  async run(input) {
    const { runTabsClose } = await import("./browser-cdp.js");
    const out = await runTabsClose(input);
    return ok(out.content);
  },
};

export const getPageTextTool = {
  name: "get_page_text",
  description: "Extract raw text content from the page, prioritizing article content. Ideal for reading articles, blog posts, or other text-heavy pages. Returns plain text without HTML formatting. If you don't have a valid tab ID, use tabs_context_mcp first to get available tabs.",
  input_schema: {
    type: "object",
    properties: { tabId: { type: "number", description: "Tab ID to extract text from. Must be a tab in the current group. Use tabs_context_mcp first if you don't have a valid tab ID." } },
    required: ["tabId"],
  },
  async run(input) {
    const { runGetPageText } = await import("./browser-cdp.js");
    const out = await runGetPageText(input);
    return ok(out.content);
  },
};

export const resizeWindowTool = {
  name: "resize_window",
  description: "Resize the current browser window to specified dimensions. Useful for testing responsive designs or setting up specific screen sizes. If you don't have a valid tab ID, use tabs_context_mcp first to get available tabs.",
  input_schema: {
    type: "object",
    properties: {
      width: { type: "number", description: "Target window width in pixels" },
      height: { type: "number", description: "Target window height in pixels" },
      tabId: { type: "number", description: "Tab ID to get the window for. Must be a tab in the current group. Use tabs_context_mcp first if you don't have a valid tab ID." },
    },
    required: ["width", "height", "tabId"],
  },
  async run(input) {
    const { runResizeWindow } = await import("./browser-cdp.js");
    const out = await runResizeWindow(input);
    return ok(out.content);
  },
};

/** browser_batch：一次往返顺序执行 computer 工具族（不允许嵌套）。 */
export const browserBatchTool = {
  name: "browser_batch",
  description: "Execute a sequence of browser tool calls in ONE round trip. Each item is {name, input} where input is exactly what you'd pass to that tool standalone. Actions execute SEQUENTIALLY (not in parallel) and stop on the first error. Use this tool extensively to quickly execute work whenever you can predict two or more steps ahead \u2014 e.g. navigate, click a field, type, press Return, screenshot. Screenshots and other images are returned interleaved with outputs; coordinates you write in THIS batch refer to the screenshot taken BEFORE this call. browser_batch cannot be nested.",
  input_schema: {
    type: "object",
    properties: {
      actions: {
        type: "array",
        minItems: 1,
        items: {
          type: "object",
          properties: {
            name: { type: "string", description: "Tool name (e.g. computer, navigate, tabs_create_mcp). browser_batch cannot be nested." },
            input: { type: "object", description: "That tool's input \u2014 same shape you'd pass when calling it directly." },
          },
          required: ["name", "input"],
        },
        description: "List of tool calls to execute sequentially. Example: [{\"name\":\"computer\",\"input\":{\"action\":\"left_click\",\"coordinate\":[100,200],\"tabId\":123}},{\"name\":\"computer\",\"input\":{\"action\":\"type\",\"text\":\"hello\",\"tabId\":123}},{\"name\":\"navigate\",\"input\":{\"url\":\"https://example.com\",\"tabId\":123}}]",
      },
    },
    required: ["actions"],
  },
  async run({ actions }) {
    const registry = {
      computer: computerTool,
      navigate: navigateTool,
      tabs_context_mcp: tabsContextTool,
      tabs_create_mcp: tabsCreateTool,
      tabs_close_mcp: tabsCloseTool,
      get_page_text: getPageTextTool,
      resize_window: resizeWindowTool,
    };
    const outputs = [];
    for (const step of Array.isArray(actions) ? actions : []) {
      if (step && step.name === "browser_batch") {
        return err("browser_batch cannot be nested");
      }
      const tool = registry[step && step.name];
      if (!tool) {
        return err(`unknown browser tool "${step && step.name}" in batch (stopped after ${outputs.length} step(s))`);
      }
      try {
        const r = await tool.run(step.input || {});
        outputs.push({ name: step.name, ok: r.ok !== false, content: String(r.content || "") });
        if (r.ok === false) {
          return err(`batch stopped at "${step.name}": ${r.content}\n\nCompleted steps:\n` + outputs.map((o) => `- ${o.name}: ${o.content}`).join("\n"));
        }
      } catch (e) {
        return err(`batch stopped at "${step.name}": ${e.message}\n\nCompleted steps:\n` + outputs.map((o) => `- ${o.name}: ${o.content}`).join("\n"));
      }
    }
    return ok(outputs.map((o) => `[${o.name}] ${o.content}`).join("\n"));
  },
};

/** computer 工具族（config.computerUse 开启时由 runtime/gui 注册）。 */
export const COMPUTER_TOOLS = [
  tabsContextTool,
  tabsCreateTool,
  tabsCloseTool,
  computerTool,
  navigateTool,
  getPageTextTool,
  resizeWindowTool,
  browserBatchTool,
];
