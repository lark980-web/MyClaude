import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  attachmentFromPath,
  resolveAttachments,
  buildUserContent,
  buildToolAttachmentContent,
  describeAttachment,
  isImagePath,
  isTextPath,
  mimeFromPath,
} from "../src/attachments.js";
import { Agent } from "../src/agent/agent.js";

const PNG_1PX = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
);

function tmp() {
  return mkdtempSync(join(tmpdir(), "myclaude-attach-"));
}

function fakeUi() {
  const events = [];
  return {
    events,
    streamText: (t) => events.push(["text", t]),
    endStream: () => events.push(["end"]),
    info: (t) => events.push(["info", t]),
    warn: (t) => events.push(["warn", t]),
    error: (t) => events.push(["error", t]),
    success: (t) => events.push(["success", t]),
    toolStart: (n) => events.push(["toolStart", n]),
    toolEnd: () => events.push(["toolEnd"]),
    confirmTool: async () => true,
  };
}

function baseConfig(overrides = {}) {
  return {
    model: "test-model",
    provider: "openai",
    maxTurns: 5,
    contextWindow: 1000,
    compactThreshold: 0.8,
    permissionMode: "auto",
    permissions: {},
    ...overrides,
  };
}

/* ------------------------------------------------------------- mime helpers */

test("mime detection by extension", () => {
  assert.equal(mimeFromPath("a.PNG"), "image/png");
  assert.equal(mimeFromPath("a.jpeg"), "image/jpeg");
  assert.equal(mimeFromPath("a.md"), "text/plain");
  assert.equal(mimeFromPath("a.xyz"), "application/octet-stream");
  assert.ok(isImagePath("shot.webp"));
  assert.ok(!isImagePath("notes.txt"));
  assert.ok(isTextPath("main.js"));
});

/* -------------------------------------------------------------- file loading */

test("attachmentFromPath reads images as base64", async () => {
  const dir = tmp();
  const file = join(dir, "dot.png");
  writeFileSync(file, PNG_1PX);
  const a = await attachmentFromPath(file);
  assert.equal(a.kind, "image");
  assert.equal(a.mime, "image/png");
  assert.equal(a.name, "dot.png");
  assert.equal(Buffer.from(a.data, "base64").equals(PNG_1PX), true);
  assert.match(describeAttachment(a), /dot\.png \(image/);
  rmSync(dir, { recursive: true, force: true });
});

test("attachmentFromPath reads text files inline", async () => {
  const dir = tmp();
  const file = join(dir, "notes.md");
  writeFileSync(file, "# hello\nworld");
  const a = await attachmentFromPath(file);
  assert.equal(a.kind, "text");
  assert.equal(a.text, "# hello\nworld");
  rmSync(dir, { recursive: true, force: true });
});

test("attachmentFromPath rejects oversized images", async () => {
  const dir = tmp();
  const file = join(dir, "big.png");
  writeFileSync(file, PNG_1PX);
  await assert.rejects(() => attachmentFromPath(file, { maxImageBytes: 4 }), /image too large/);
  rmSync(dir, { recursive: true, force: true });
});

test("resolveAttachments turns failures into error entries", async () => {
  const dir = tmp();
  const good = join(dir, "a.txt");
  writeFileSync(good, "hi");
  const list = await resolveAttachments([good, join(dir, "missing.txt"), null]);
  assert.equal(list.length, 2);
  assert.equal(list[0].kind, "text");
  assert.equal(list[1].kind, "error");
  assert.match(list[1].error, /ENOENT|no such file/i);
  rmSync(dir, { recursive: true, force: true });
});

/* ------------------------------------------------------------ content parts */

test("buildUserContent returns a plain string without attachments", () => {
  assert.equal(buildUserContent("hello"), "hello");
  assert.equal(buildUserContent("hello", []), "hello");
});

test("buildUserContent builds multi-part content with images", () => {
  const parts = buildUserContent("what is this?", [
    { kind: "image", name: "a.png", mime: "image/png", data: "AAA", size: 3 },
    { kind: "text", name: "b.md", mime: "text/plain", text: "body", size: 4 },
    { kind: "file", name: "c.pdf", mime: "application/pdf", path: "/tmp/c.pdf", size: 9 },
  ]);
  assert.ok(Array.isArray(parts));
  assert.deepEqual(parts[0], { type: "text", text: "what is this?" });
  assert.equal(parts[1].type, "image_url");
  assert.equal(parts[1].image_url.url, "data:image/png;base64,AAA");
  assert.match(parts[2].text, /\[attached file: b\.md\]\nbody/);
  assert.match(parts[3].text, /c\.pdf.*use Read/);
});

test("buildUserContent drops images when vision is disabled", () => {
  const parts = buildUserContent("look", [{ kind: "image", name: "a.png", mime: "image/png", data: "AAA" }], {
    vision: false,
  });
  assert.equal(parts.length, 2);
  assert.equal(parts[0].type, "text");
  assert.equal(parts[1].type, "text");
  assert.match(parts[1].text, /skipped: vision disabled/);
  assert.ok(!parts.some((p) => p.type === "image_url"));
});

test("buildToolAttachmentContent wraps images in a user message", () => {
  assert.equal(buildToolAttachmentContent([]), null);
  const content = buildToolAttachmentContent([{ kind: "image", mime: "image/png", data: "AAA" }]);
  assert.equal(content[1].image_url.url, "data:image/png;base64,AAA");
});

/* ------------------------------------------------------------------- Agent */

test("Agent.run sends attachments as multi-part user content", async () => {
  let seen = null;
  const provider = {
    async streamChat({ messages }) {
      seen = messages;
      return { text: "ok", toolCalls: [] };
    },
  };
  const agent = new Agent({ provider, config: baseConfig(), ui: fakeUi() });
  await agent.run("describe", {
    attachments: [{ kind: "image", name: "x.png", mime: "image/png", data: "AAA" }],
  });
  const user = seen.find((m) => m.role === "user");
  assert.ok(Array.isArray(user.content));
  assert.equal(user.content[0].text, "describe");
  assert.equal(user.content[1].type, "image_url");
});

test("Agent.run warns about unreadable attachments but continues", async () => {
  const provider = { async streamChat() { return { text: "ok", toolCalls: [] }; } };
  const ui = fakeUi();
  const agent = new Agent({ provider, config: baseConfig(), ui });
  await agent.run("hi", { attachments: [join(tmpdir(), "definitely-missing.png")] });
  assert.ok(ui.events.some(([k, t]) => k === "warn" && /attachment skipped/.test(t)));
});

test("Agent forwards images returned by tools as a user message", async () => {
  const requests = [];
  let turn = 0;
  const provider = {
    async streamChat({ messages }) {
      requests.push(messages.map((m) => ({ role: m.role, content: m.content })));
      turn++;
      if (turn === 1) {
        return {
          text: "",
          toolCalls: [{ id: "c1", name: "ReadStub", arguments: { file_path: "x.png" }, raw: "{}" }],
        };
      }
      return { text: "done", toolCalls: [] };
    },
  };

  const agent = new Agent({ provider, config: baseConfig(), ui: fakeUi() });
  // Swap in a stub tool that returns an image attachment.
  agent.tools = [
    {
      type: "function",
      function: {
        name: "ReadStub",
        description: "stub",
        parameters: { type: "object", properties: { file_path: { type: "string" } } },
      },
    },
  ];
  const { registerTools } = await import("../src/tools/index.js");
  registerTools([
    {
      name: "ReadStub",
      description: "stub",
      input_schema: { type: "object", properties: {} },
      async run() {
        return {
          ok: true,
          content: "[image x.png]",
          attachments: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "AAA" } }],
        };
      },
    },
  ]);

  const result = await agent.run("look at x.png");
  assert.equal(result.text, "done");
  const last = requests.at(-1);
  const imageMsg = last.find((m) => m.role === "user" && Array.isArray(m.content));
  assert.ok(imageMsg, "image follow-up user message was sent");
  assert.equal(imageMsg.content[1].image_url.url, "data:image/png;base64,AAA");
});

/* ------------------------------------------------------------ mode switching */

test("setMode rebuilds the system prompt and rejects bad values", () => {
  const provider = { async streamChat() { return { text: "", toolCalls: [] }; } };
  const agent = new Agent({ provider, config: baseConfig({ permissionMode: "ask" }), ui: fakeUi() });
  assert.doesNotMatch(agent.systemPrompt, /# Plan mode/);
  agent.setMode("plan");
  assert.equal(agent.mode, "plan");
  assert.match(agent.systemPrompt, /# Plan mode/);
  agent.setMode("ask");
  assert.doesNotMatch(agent.systemPrompt, /# Plan mode/);
  assert.throws(() => agent.setMode("yolo"), /invalid mode/);
});

test("plan mode allows read-only tools and blocks mutations", async () => {
  const ui = fakeUi();
  const agent = new Agent({ provider: {}, config: baseConfig({ permissionMode: "plan" }), ui });
  assert.equal(await agent.askPermission("Read", { file_path: "a.js" }), true);
  assert.equal(await agent.askPermission("Grep", { pattern: "x" }), true);
  assert.equal(await agent.askPermission("Write", { file_path: "a.js" }), false);
  assert.equal(await agent.askPermission("Bash", { command: "ls" }), false);
  assert.ok(ui.events.some(([k, t]) => k === "warn" && /plan mode/.test(t)));
});

test("ask mode still prompts for mutations", async () => {
  const ui = fakeUi();
  ui.confirmTool = async () => false;
  const agent = new Agent({ provider: {}, config: baseConfig({ permissionMode: "ask" }), ui });
  assert.equal(await agent.askPermission("Write", { file_path: "a.js" }), false);
});

test("auto mode approves without prompting", async () => {
  const agent = new Agent({ provider: {}, config: baseConfig({ permissionMode: "auto" }), ui: fakeUi() });
  assert.equal(await agent.askPermission("Bash", { command: "echo hi" }), true);
});

test("setVision toggles the system prompt note", () => {
  const agent = new Agent({ provider: {}, config: baseConfig(), ui: fakeUi() });
  assert.equal(agent.vision, true);
  agent.setVision(false);
  assert.equal(agent.vision, false);
  assert.match(agent.systemPrompt, /# Vision disabled/);
  agent.setVision(true);
  assert.doesNotMatch(agent.systemPrompt, /# Vision disabled/);
});
