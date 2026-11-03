/**
 * The follow-up suggestion cards.
 *
 * buildFollowupPrompts lives inside app.js's IIFE, so it cannot be imported.
 * Exporting it just for a test would put a hook in production code for the
 * sake of the suite, which is the wrong trade for three fixed sets. What
 * actually matters about them is visible in the source: each context offers a
 * coherent set of three {t, d} pairs — a short label plus a full sentence
 * (点击发送的是完整句子) — and the row reads as three cards, not one card
 * plus two afterthoughts.
 *
 * 07dc76f 把胶囊升级为美工卡片，数据形状从字符串变为 {t, d}；本文件随之
 * 更新断言对象。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const app = readFileSync(join(ROOT, "src", "ui", "web", "js", "app.js"), "utf8");

/** The three groups buildFollowupPrompts can return: arrays of { t, d }. */
function groups() {
  // 只在 buildFollowupPrompts 函数体内匹配：app.js 里还有别的 return [
  // 数组带中文串（快捷键说明、重试菜单项等），全文件粗匹配会把它们混成
  // 假建议组。
  const fnAt = app.indexOf("function buildFollowupPrompts");
  assert.ok(fnAt >= 0, "buildFollowupPrompts exists");
  const scope = app.slice(fnAt, app.indexOf("/* ---- 语音朗读", fnAt));
  const out = [];
  const re = /return\s*\[([^\]]*)\]/g;
  let m;
  while ((m = re.exec(scope)) !== null) {
    const body = m[1];
    const items = [...body.matchAll(/\{\s*t:\s*"([^"]*)",\s*d:\s*"([^"]*)"\s*\}/g)]
      .map((x) => ({ t: x[1], d: x[2] }));
    if (items.length >= 3) { out.push(items); }
  }
  return out;
}

test("every suggestion group offers a full set of three {t,d} cards", () => {
  const gs = groups();
  assert.ok(gs.length >= 3, "found " + gs.length + " groups (artifact/code/generic)");
  for (const g of gs) {
    assert.equal(g.length, 3, "each group offers three: " + g.map((x) => x.t).join(" / "));
    for (const s of g) {
      assert.ok(s.t.trim().length > 0, "no empty label");
      assert.ok(s.d.trim().length > 0, "no empty description");
    }
  }
});

test("labels within a group are close in length", () => {
  // 三张卡并排，一行里的标签长度接近才不会显得头重脚轻。
  for (const g of groups()) {
    const lens = g.map((s) => s.t.length);
    const shortest = Math.min(...lens);
    const longest = Math.max(...lens);
    assert.ok(longest - shortest <= 4,
      "uneven label lengths " + lens.join("/") + " in: " + g.map((x) => x.t).join(" / "));
  }
});

test("labels are short; descriptions stay one sentence", () => {
  // 标签是卡片首行的短词；说明是完整句子，但再长也会截断可读性。
  for (const g of groups()) {
    for (const s of g) {
      assert.ok(s.t.length <= 8, "label too long (" + s.t.length + "): " + s.t);
      assert.ok(s.d.length <= 24, "description too long (" + s.d.length + "): " + s.d);
    }
  }
});

test("each group's three descriptions are distinct", () => {
  // 三张卡说同一件事会像重复渲染；一一互异是这条产品线的底线。
  for (const g of groups()) {
    const ds = new Set(g.map((x) => x.d));
    assert.equal(ds.size, 3, "descriptions must differ within a group");
  }
});

test("the card grid keeps one suggestion from swallowing the row", () => {
  // 07dc76f 把追问胶囊升级为美工卡片（followup-card）：三张卡并排由网格约束，
  // 单卡不再可能撑满整行；hover 有抬升动效，键盘可达。
  const css = readFileSync(join(ROOT, "src", "ui", "web", "css", "styles.css"), "utf8");
  const i = css.indexOf(".followup-row {");
  assert.ok(i >= 0, "the followup row has a rule");
  const rowRule = css.slice(i, css.indexOf("}", i));
  assert.match(rowRule, /grid-template-columns/, "the row is a grid that caps each card");
  const j = css.indexOf(".followup-card {");
  assert.ok(j >= 0, "the card has a rule");
  const card = css.slice(j, css.indexOf("}", j));
  assert.match(card, /border-radius/, "a card is a rounded panel");
  assert.match(css.slice(j, j + 700), /hover/, "the card has hover affordance");
});
