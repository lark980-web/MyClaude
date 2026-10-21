import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import {
  readManifest,
  pluginComponents,
  loadPlugins,
  pluginComponentPaths,
  pluginSummaries,
  PLUGIN_PROBLEM,
} from "../src/plugins.js";
import { loadCommands } from "../src/commands.js";

/** Build a plugin directory and return its path. */
function makePlugin(root, name, manifest, components = {}) {
  const dir = join(root, ".myclaude", "plugins", name);
  mkdirSync(dir, { recursive: true });
  if (manifest !== null) {
    writeFileSync(join(dir, "plugin.json"), JSON.stringify(manifest), "utf8");
  }
  for (const [kind, files] of Object.entries(components)) {
    const sub = join(dir, kind);
    mkdirSync(sub, { recursive: true });
    for (const [file, body] of Object.entries(files)) {
      writeFileSync(join(sub, file), body, "utf8");
    }
  }
  return dir;
}

const scratch = () => mkdtempSync(join(process.env.TEMP || ".", "plug-"));

test("a manifest with a name is valid", () => {
  const root = scratch();
  try {
    const dir = makePlugin(root, "demo", { name: "demo", version: "1.0.0", description: "A demo" });
    const read = readManifest(dir);
    assert.equal(read.ok, true);
    assert.equal(read.manifest.name, "demo");
    assert.equal(read.manifest.version, "1.0.0");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a missing or broken manifest is reported, not ignored", () => {
  const root = scratch();
  try {
    const noManifest = makePlugin(root, "bare", null);
    const read = readManifest(noManifest);
    assert.equal(read.ok, false);
    assert.equal(read.problem, PLUGIN_PROBLEM.MANIFEST_INVALID);

    const badJson = makePlugin(root, "bad", null);
    writeFileSync(join(badJson, "plugin.json"), "{not json", "utf8");
    assert.equal(readManifest(badJson).ok, false);

    const noName = makePlugin(root, "anon", { version: "1" });
    assert.equal(readManifest(noName).ok, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("component directories are found", () => {
  const root = scratch();
  try {
    const dir = makePlugin(root, "demo", { name: "demo" }, {
      commands: { "hi.md": "hello" },
      skills: { "sk": "SKILL.md" },
    });
    const comps = pluginComponents(dir);
    assert.ok(comps.includes("commands"));
    assert.ok(comps.includes("skills"));
    assert.ok(!comps.includes("hooks"), "a directory that is not there is not a component");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a plugin is found from the project directory", () => {
  const root = scratch();
  try {
    makePlugin(root, "demo", { name: "demo", description: "d" }, { commands: { "x.md": "body" } });
    const list = loadPlugins(root);
    assert.equal(list.length, 1);
    assert.equal(list[0].name, "demo");
    assert.equal(list[0].scope, "project");
    assert.equal(list[0].problem, null);
    assert.ok(list[0].components.includes("commands"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a plugin with a broken manifest shows up with its problem", () => {
  const root = scratch();
  try {
    makePlugin(root, "broken", null);
    const list = loadPlugins(root);
    assert.equal(list.length, 1);
    assert.equal(list[0].problem, PLUGIN_PROBLEM.MANIFEST_INVALID);
    assert.ok(list[0].reason.length > 0, "the reason is explained");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a plugin that is disabled does not contribute components", () => {
  const root = scratch();
  try {
    makePlugin(root, "off", { name: "off", enabled: false }, { commands: { "x.md": "body" } });
    const list = loadPlugins(root);
    assert.equal(list[0].problem, PLUGIN_PROBLEM.DISABLED_BY_DEFAULT);
    assert.deepEqual(pluginComponentPaths(root).commands, [], "a disabled plugin contributes nothing");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("plugin commands join the ordinary ones", () => {
  const root = scratch();
  try {
    makePlugin(root, "demo", { name: "demo" }, {
      commands: { "plugged.md": "---\ndescription: from a plugin\n---\nbody" },
    });
    const names = loadCommands(root).map((c) => c.name);
    assert.ok(names.includes("plugged"), "the plugin command is loaded: " + names.join(","));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the summary line names the plugin and its components", () => {
  const root = scratch();
  try {
    makePlugin(root, "demo", { name: "demo", description: "A demo" }, { commands: { "x.md": "b" } });
    const lines = pluginSummaries(root);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /demo/);
    assert.match(lines[0], /commands/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
