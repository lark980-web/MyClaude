/**
 * Iteration round 4: settings-modal layout bug + editorial style alignment.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const css = readFileSync(join(ROOT, "src", "ui", "web", "css", "styles.css"), "utf8");

test("provider grid cannot overflow its 3-column container", () => {
  const rule = css.slice(css.indexOf(".cfg-provider-card {"), css.indexOf(".cfg-provider-card:hover"));
  assert.match(rule, /min-width:\s*0/, "grid items need min-width:0 (long names pushed col 3 out)");
  assert.match(rule, /overflow:\s*hidden/, "card clips its own content");
  assert.match(css, /@media \(max-width: 420px\) \{\s*\.cfg-provider-grid \{ grid-template-columns: 1fr; \}/, "very narrow falls back to one column");
  assert.match(css, /\.cfg-provider-grid \{[^}]*repeat\(3, minmax\(0, 1fr\)\)/, "grid columns are zero-min too");
});

test("other modal/welcome grids cannot repeat the same overflow bug", () => {
  assert.match(css, /\.welcome-suggestions \{[^}]*repeat\(2, minmax\(0, 1fr\)\)/, "welcome grid uses zero-min columns");
  const welcome = css.slice(css.indexOf(".welcome-sug-card {"), css.indexOf(".welcome-sug-card:hover"));
  assert.match(welcome, /box-shadow: var\(--card-shadow\)/, "welcome cards use theme-aware shadow");
  assert.ok(!/rgba\(0, 0, 0/.test(welcome), "no hardcoded dark-only shadow left");
});

test("input shortcut chips share the 8px / hairline / theme-shadow language", () => {
  // 注意：文件里另有 media 覆盖规则 .welcome-cat-btn（2279 行），
  // 不能用 indexOf 取「第一个」来切片，否则会拿到空串。
  assert.match(css, /\.welcome-cats \{[^}]*gap:\s*6px/, "tighter chip rhythm");
  const main = css.indexOf(".welcome-cats {");
  const chip = css.slice(css.indexOf(".welcome-cat-btn {", main), css.indexOf(".welcome-cat-btn:hover", main));
  assert.match(chip, /border-radius: 8px/, "chip radius aligned");
  assert.match(chip, /border: 1px solid var\(--line\)/, "hairline border, not line-strong");
  assert.match(css, /\.welcome-cat-btn\.active \{[^}]*box-shadow: var\(--card-shadow\)/, "active chip uses theme shadow");
});

test("settings modal now uses the shared editorial language", () => {
  assert.match(css, /\.cfg-pane-title::after/, "section titles carry a hairline rule");
  assert.match(css, /\.cfg-form-card \{[^}]*box-shadow: var\(--card-shadow\)/, "form cards use theme-aware layered shadow");
  assert.ok(!/\.cfg-general-row \{[^}]*dashed/.test(css), "rows use solid hairlines, not dashed");
  const modal = css.slice(css.indexOf(".modal-card {"), css.indexOf(".modal-card.modal-wide"));
  assert.match(modal, /border-radius: 12px/, "modal radius aligned with 8px cards");
});
