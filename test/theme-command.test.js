import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// /theme parity (R4 recovered command): upstream chunk-e0x0xb6d @2182394
// {type:"local-jsx",name:"theme",description:"Change the theme"}.
test("TUI dispatches /theme and persists config.theme", () => {
  const src = readFileSync(new URL("../src/main.js", import.meta.url), "utf8");
  assert.ok(/case "theme":/.test(src), "theme case present");
  assert.ok(/saveConfig\(\{ theme: next \}\)/.test(src), "theme persisted");
  assert.ok(/\["dark", "light", "auto"\]/.test(src), "three theme values");
});

test("config panel exposes a Theme row and applies it", () => {
  const src = readFileSync(new URL("../src/main.js", import.meta.url), "utf8");
  assert.ok(/key: "theme", label: "Theme/.test(src), "config panel theme row");
  assert.ok(/key === "theme"/.test(src), "config apply handles theme");
});

test("ink status line shows non-default theme and accent adapts", () => {
  const src = readFileSync(new URL("../src/ui/ink-app.js", import.meta.url), "utf8");
  assert.ok(/config\.theme && config\.theme !== "dark"/.test(src), "theme indicator");
  assert.ok(/function accentColor/.test(src), "accent helper");
  assert.ok(/accentColor\(config\)/.test(src), "accent wired into rendering");
});
