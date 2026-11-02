/**
 * Turn-end closure and the follow-up cards.
 *
 * Two user-reported defects: a finished turn ended with no visible closure,
 * and the follow-up suggestions were ellipsis-truncated pills. Both are
 * locked here: the CSS must lay the suggestions out as full-text cards, and
 * endTurn must stamp a closure marker that a new turn clears.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const app = readFileSync(join(here, "..", "src", "ui", "web", "js", "app.js"), "utf8");
const css = readFileSync(join(here, "..", "src", "ui", "web", "css", "styles.css"), "utf8");

test("follow-up suggestions render as designed cards with full text", () => {
  assert.match(css, /\.followup-row \{[^}]*display: grid/);
  assert.match(css, /\.followup-row \{[^}]*grid-template-columns: repeat\(3, minmax\(0, 1fr\)\)/);
  // 卡片体系：编号 + 标题 + 描述 三层结构，全部存在
  for (const sel of [".followup-card", ".fc-top", ".fc-num", ".fc-arrow", ".fc-title", ".fc-desc"]) {
    assert.ok(css.includes(sel + " {"), sel + " must exist");
  }
  // 截断三件套在 followup 区域绝迹（老药丸把追问切成半句）。
  const zone = css.slice(css.indexOf(".followup-row"), css.indexOf(".fc-desc") + 400);
  assert.ok(!/text-overflow: ellipsis/.test(zone), "no ellipsis truncation");
  assert.ok(!/white-space: nowrap/.test(zone), "no forced single line");
  // 交互态齐全：hover 抬升、focus-visible、active。
  assert.match(css, /\.followup-card:hover \{[^}]*translateY\(-2px\)/);
  assert.match(css, /\.followup-card:focus-visible/);
  // 窄屏塌成一列，卡片永不裁字。
  assert.match(css, /@media \(max-width: 720px\) \{\s*\.followup-row \{ grid-template-columns: 1fr; \}/);
});

test("endTurn stamps a turn-end marker", () => {
  assert.match(app, /function addTurnEndMarker\(state\)/);
  // endTurn body must call it before setBusy(false).
  const end = app.slice(app.indexOf("function endTurn(state)"));
  const body = end.slice(0, end.indexOf("\n  }"));
  assert.match(body, /addTurnEndMarker\(state\);/);
  assert.ok(body.indexOf("addTurnEndMarker") < body.indexOf("setBusy(false)"), "marker before busy release so it lands in order");
});

test("a new turn clears the stale marker", () => {
  const run = app.slice(app.indexOf("function runTurn(payload)"));
  const head = run.slice(0, 1200);
  assert.match(head, /querySelector\("\.turn-end"\)/);
  assert.match(head, /removeChild/);
});

test("the marker distinguishes 'waiting for you' from 'done'", () => {
  assert.match(app, /Claude 在等你回复/);
  assert.match(app, /回合完成/);
  // Asking detection: trailing question mark (ASCII or full-width), optional quote/bracket.
  assert.match(app, /\[\?？\]/);
  assert.match(css, /\.turn-end\.waiting \.te-dot \{ background: var\(--accent\); \}/);
  assert.match(css, /\.turn-end \{[^}]*font-size: 11\.5px/);
});

test("the marker reuses existing tokens only (no invented palette)", () => {
  const rule = css.match(/\.turn-end \{[^}]*\}/)[0];
  const vars = [...rule.matchAll(/var\(--([a-z0-9-]+)\)/g)].map((m) => m[1]);
  const root = css.match(/:root \{([\s\S]*?)\n\}/)[1];
  for (const v of vars) {
    assert.ok(root.includes("--" + v + ":"), "token --" + v + " must exist in :root");
  }
});
