/**
 * UI consistency audit.
 *
 * The composer once held a 28px pill beside two 32px squares, and nothing in
 * the suite noticed: the CSS is valid either way. This script is the check that
 * was missing, so a control no longer has to be eyeballed by hand.
 *
 * What it enforces, and why that is the rule:
 *   - Controls sharing a row sit on one line, so their HEIGHT has to agree.
 *     A different height reads as misalignment whatever the control is for.
 *   - Shape does not have to agree. The send button is a circle and a tab is a
 *     low pill because they play different roles, so radius and border are
 *     checked only for the rows that ask for it, and every exemption records
 *     the reason.
 *
 * Rows are discovered from the page, not listed here, so a control added to a
 * row is audited without touching this file. Vertical containers are skipped:
 * a list is meant to hold items of different heights, and comparing those
 * invents problems nobody can see.
 *
 * Reading the stylesheet: only top-level rules count, because @media and
 * @container bodies are deliberate responsive overrides; group selectors count
 * (".a, .b" styles both); later rules win, as the cascade does.
 *
 * The bundle is audited too - the browser only ever loads src/ui/assets.js, so
 * a fixed stylesheet beside a stale bundle still looks wrong on screen. That is
 * not hypothetical: it is exactly what happened once here.
 *
 * Flags: --dump prints resolved tokens, --json prints findings,
 * --selftest proves the auditor can still see a planted drift.
 * Exit 1 when drift is found.
 */
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Every horizontal row must agree on height. */
const HARD_TOKEN = "height";

/** Tokens a row may additionally require, where the controls play one role. */
const OPTIONAL_TOKENS = ["border-radius", "border"];

/**
 * Rows that hold controls of a single role, so shape must agree too.
 *
 * The composer's left group is a row of equal-weight toggles, so a pill among
 * squares is the bug this is meant to catch. The right group is not listed: its
 * send button is deliberately a circle.
 */
const STRICT_ROWS = { "prompt-left": OPTIONAL_TOKENS };

/**
 * Deliberate differences, recorded with the reason, so the audit does not
 * demand uniformity where uniformity would be wrong.
 */
const EXEMPT = {
  // The row's primary action, drawn as a filled circle.
  ".send-btn": ["border-radius", "border"],
  ".stop-btn": ["border-radius", "border"],
  // A wide pill whose edge appears only on hover.
  ".model-btn": ["border"],
};

/**
 * Per-row exemptions, each with the reason it is a choice rather than drift.
 *
 * A tab or a segment sits beside an icon button in several headers. The tab is
 * deliberately the lighter, shorter element of the pair - that is what makes it
 * read as a tab - so height is not compared across them in those rows. This is
 * narrower than a global role rule: it applies only where the pairing exists.
 */
const ROW_EXEMPT = {
  "insp-head": [".insp-tab", ".icon-btn"],
  "artifact-actions": [".artifact-view-btn", ".icon-btn"],
  "projects-head-right": [".proj-mode-tab", ".icon-btn"],
  "proj-list-toolbar": [".proj-tab", ".archive-policy-select"],
};
const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input",
  "link", "meta", "param", "source", "track", "wbr"]);
const CONTROLS = new Set(["button", "select", "textarea", "label"]);

/**
 * Parse the top-level rules of a stylesheet, in document order.
 *
 * Depth counts how many blocks we are inside: a rule at depth 0 is top level,
 * anything deeper belongs to an at-rule and is skipped. Comments go first so a
 * brace inside one cannot skew the count.
 *
 * @param {string} css
 * @returns {Array<{selectors: string[], decls: Object}>}
 */
export function topLevelRules(css) {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, " ");
  const rules = [];
  let depth = 0;
  let selector = "";
  let body = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "{") {
      if (depth === 0) { selector = body.trim(); body = ""; }
      else { body += ch; }
      depth++;
      continue;
    }
    if (ch === "}") {
      depth--;
      if (depth === 0) {
        if (selector && !/^@/.test(selector)) {
          rules.push({
            selectors: selector.split(",").map((s) => s.trim()).filter(Boolean),
            decls: parseDecls(body),
          });
        }
        selector = "";
        body = "";
      } else if (depth > 0) {
        body += ch;
      }
      continue;
    }
    if (ch === ";" && depth === 0) { selector = ""; body = ""; continue; }
    body += ch;
  }
  return rules;
}

function parseDecls(text) {
  const out = {};
  for (const piece of text.split(";")) {
    const m = /^\s*([a-z-]+)\s*:\s*(.+?)\s*$/.exec(piece);
    if (m) { out[m[1]] = m[2].replace(/\s+/g, " ").trim(); }
  }
  return out;
}

/**
 * Declarations that apply to one simple class selector.
 *
 * Only rules naming it exactly are taken: ".a:hover" or ".b .a" is a state or
 * context variation, not the base look being compared.
 *
 * @param {Array} rules from topLevelRules
 * @param {string} selector e.g. ".round-btn"
 */
export function effective(rules, selector) {
  const out = {};
  for (const rule of rules) {
    if (rule.selectors.includes(selector)) { Object.assign(out, rule.decls); }
  }
  return out;
}

/**
 * Parse the page into a node tree.
 *
 * HTML is not a regular language, so this is a tolerant scan: void tags and
 * self-closed SVG children never push the stack, and a close tag pops to the
 * nearest open tag of that name rather than being trusted.
 *
 * @param {string} html
 * @returns {Array<Object>} roots
 */
function parseHtml(html) {
  const roots = [];
  const stack = [];
  const re = /<\/?([a-zA-Z][\w-]*)\b([^>]*)\/?>/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const tag = m[1].toLowerCase();
    const attrs = m[2] || "";
    if (m[0][1] === "/") {
      for (let k = stack.length - 1; k >= 0; k--) {
        if (stack[k].tag === tag) { stack.length = k; break; }
      }
      continue;
    }
    const cls = (/class="([^"]*)"/.exec(attrs) || [])[1];
    const node = {
      tag,
      classes: cls ? cls.split(/\s+/).filter(Boolean) : [],
      id: (/id="([^"]*)"/.exec(attrs) || [])[1] || null,
      children: [],
    };
    const parent = stack[stack.length - 1];
    if (parent) { parent.children.push(node); } else { roots.push(node); }
    if (!m[0].endsWith("/>") && !VOID.has(tag)) { stack.push(node); }
  }
  return roots;
}

function findByClass(nodes, wanted) {
  for (const n of nodes) {
    if (n.classes.includes(wanted)) { return n; }
    const hit = findByClass(n.children, wanted);
    if (hit) { return hit; }
  }
  return null;
}

/**
 * The controls that share a row.
 *
 * Direct children that are controls count; a wrapper such as
 * <div class="model-pick"> is descended once, because the control inside it
 * still sits in the same row. Controls sharing a class share a rule and so
 * cannot disagree with each other: the class is audited once.
 *
 * @param {Array} nodes parsed page
 * @param {string} containerClass
 * @param {number} [maxWrap]
 * @returns {Array<{sel: string, tag: string}>}
 */
export function rowControls(nodes, containerClass, maxWrap = 1) {
  const container = findByClass(nodes, containerClass);
  if (!container) { return []; }
  const seen = new Set();
  const out = [];
  let frontier = [container];
  for (let level = 0; level <= maxWrap; level++) {
    const next = [];
    for (const node of frontier) {
      for (const child of node.children) {
        if (CONTROLS.has(child.tag)) {
          const sel = child.classes.length ? "." + child.classes[0]
            : (child.id ? "#" + child.id : child.tag);
          if (!seen.has(sel)) { seen.add(sel); out.push({ sel, tag: child.tag }); }
        } else {
          next.push(child);
        }
      }
    }
    frontier = next;
  }
  return out;
}

/**
 * True when a container lays its children out in a row.
 *
 * Only side-by-side controls have to agree on height. The direction is read
 * from the page rather than hard-coded, so a container that later changes
 * layout is judged by what it now does.
 *
 * @param {Array} rules from topLevelRules
 * @param {Array} nodes parsed page
 * @param {string} containerClass
 * @returns {boolean}
 */
export function isHorizontalRow(rules, nodes, containerClass) {
  const container = findByClass(nodes, containerClass);
  if (!container) { return false; }
  const d = effective(rules, "." + containerClass);
  if (!d.display || !/^(flex|inline-flex|grid|inline-grid)$/.test(d.display.trim())) { return false; }
  return !/^(column|column-reverse)$/.test((d["flex-direction"] || "").trim());
}

/** Every class in the page, in document order and deduplicated. */
function allClasses(nodes) {
  const seen = new Set();
  const walk = (list) => {
    for (const n of list) {
      for (const c of n.classes) { if (!seen.has(c)) { seen.add(c); } }
      walk(n.children);
    }
  };
  walk(nodes);
  return [...seen];
}

/** Reduce the border shorthand to the parts the eye compares. */
function borderFace(value) {
  if (!value) { return null; }
  const m = /^(\d+px)\s+(\w+)\s+(.+)$/.exec(value);
  return m ? m[1] + " " + m[2] + " " + m[3] : value;
}

function tokenOf(decls, token) {
  if (token === "border") { return borderFace(decls.border); }
  return decls[token] == null ? null : decls[token];
}

/**
 * Compare the controls of every horizontal row.
 *
 * @param {string} css
 * @param {string} html
 * @returns {{findings: Array, rows: number, notes: string[]}}
 */
export function audit(css, html) {
  const rules = topLevelRules(css);
  const nodes = parseHtml(html);
  const findings = [];
  const notes = [];
  let rowCount = 0;
  for (const cls of allClasses(nodes)) {
    const controls = rowControls(nodes, cls);
    if (controls.length < 2) { continue; }
    if (!isHorizontalRow(rules, nodes, cls)) { continue; }
    rowCount++;
    const taken = controls.map((c) => ({ sel: c.sel, decls: effective(rules, c.sel) }));
    const unknown = taken.filter((t) => !Object.keys(t.decls).length).map((t) => t.sel);
    if (unknown.length) { notes.push("row " + cls + ": no top-level rule for " + unknown.join(", ")); }
    const tokens = [HARD_TOKEN].concat(STRICT_ROWS[cls] || []);
    // Controls listed here pair with a deliberately shorter element in this row.
    const rowSkip = ROW_EXEMPT[cls];
    for (const token of tokens) {
      const byValue = new Map();
      for (const p of taken) {
        if (!Object.keys(p.decls).length) { continue; }
        if ((EXEMPT[p.sel] || []).includes(token)) { continue; }
        if (rowSkip && token === HARD_TOKEN && rowSkip.includes(p.sel)) { continue; }
        const v = tokenOf(p.decls, token);
        if (v == null) { continue; }
        if (!byValue.has(v)) { byValue.set(v, []); }
        byValue.get(v).push(p.sel);
      }
      if (byValue.size < 2) { continue; }
      const sorted = [...byValue.entries()].sort((a, b) => b[1].length - a[1].length);
      const [major, majorSel] = sorted[0];
      for (const [value, sels] of sorted.slice(1)) {
        findings.push({ row: cls, token, value, sels, major, majorOf: majorSel.length });
      }
    }
  }
  return { findings, rows: rowCount, notes };
}

/** The stylesheet the browser actually receives. */
export function bundledCss() {
  const file = join(ROOT, "src", "ui", "assets.js");
  if (!existsSync(file)) { return null; }
  const m = /styles:\s*"((?:[^"\\]|\\.)*)"/.exec(readFileSync(file, "utf8"));
  if (!m) { return null; }
  try { return JSON.parse('"' + m[1] + '"'); } catch { return null; }
}

function readPage() {
  return readFileSync(join(ROOT, "src", "ui", "web", "page.html"), "utf8");
}

function readStyles() {
  return readFileSync(join(ROOT, "src", "ui", "web", "css", "styles.css"), "utf8");
}

/**
 * Prove the auditor still sees a planted drift.
 *
 * A guard that cannot fail is worse than none: it reports success forever. The
 * plant is appended rather than edited, because within one block the last
 * declaration wins - planting before the real height would be overridden and
 * the test would prove nothing.
 *
 * @returns {string[]} problems found with the auditor itself
 */
export function selfTest() {
  const problems = [];
  const css = readStyles();
  const html = readPage();
  const base = audit(css, html);
  if (!base.rows) { problems.push("the auditor found no horizontal rows at all"); }
  if (base.notes.length) {
    for (const n of base.notes) {
      // A control without a rule is not blindness, but it is worth reporting.
      problems.push(n);
    }
  }
  const planted = css + "\n.mode-select-wrap {\n  height: 21px;\n}\n";
  const seen = audit(planted, html).findings;
  if (!seen.some((f) => f.token === "height" && f.sels.includes(".mode-select-wrap"))) {
    problems.push("a planted height drift was NOT reported: the auditor is blind");
  }
  return problems;
}

/** Run only when executed directly, so importing the helpers stays silent. */
const isMain = process.argv[1]
  && process.argv[1].replace(/\\/g, "/").endsWith("audit-ui-consistency.mjs");
if (isMain) {
  const html = readPage();
  const source = readStyles();
  const args = process.argv.slice(2);
  if (args.includes("--dump")) {
    const rules = topLevelRules(source);
    const nodes = parseHtml(html);
    console.log("top-level rules:", rules.length);
    for (const cls of allClasses(nodes)) {
      const controls = rowControls(nodes, cls);
      if (controls.length < 2 || !isHorizontalRow(rules, nodes, cls)) { continue; }
      console.log("\n." + cls);
      for (const c of controls) {
        const d = effective(rules, c.sel);
        if (!Object.keys(d).length) { console.log("  " + c.sel.padEnd(22) + "(no top-level rule)"); continue; }
        console.log("  " + c.sel.padEnd(22)
          + [HARD_TOKEN].concat(STRICT_ROWS[cls] || [])
            .map((t) => t + "=" + (tokenOf(d, t) ?? "-")).join("  "));
      }
    }
    process.exit(0);
  }
  if (args.includes("--selftest")) {
    const problems = selfTest();
    console.log(problems.length
      ? "self test FAILED:\n  " + problems.join("\n  ")
      : "self test ok: the auditor sees a planted height drift");
    process.exit(problems.length ? 1 : 0);
  }
  const src = audit(source, html);
  const bundle = bundledCss();
  const bun = bundle ? audit(bundle, html) : null;
  if (args.includes("--json")) {
    console.log(JSON.stringify({ rows: src.rows, source: src.findings, bundle: bun && bun.findings }, null, 2));
  } else {
    console.log("horizontal rows audited: " + src.rows);
    for (const [label, res] of [["styles.css", src], ["bundle", bun]]) {
      if (!res) { continue; }
      if (!res.findings.length) { console.log(label + ": no drift"); continue; }
      console.log(label + ":");
      for (const f of res.findings) {
        console.log("  ." + f.row + " " + f.token + ": " + f.sels.join(", ")
          + " = " + f.value + "  (the rest use " + f.major + ")");
      }
    }
    for (const n of src.notes) { console.log("note: " + n); }
    if (bun && src.findings.length !== bun.findings.length) {
      console.log("\nstyles.css and the bundle disagree: rebuild it (npm run build:embed).");
    }
    if (src.findings.length) {
      console.log("\nControls sharing a row must agree on height. Fix it, or record the role in EXEMPT with the reason.");
    }
  }
  process.exit(src.findings.length + (bun ? bun.findings.length : 0) ? 1 : 0);
}
