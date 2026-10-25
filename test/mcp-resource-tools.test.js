/**
 * MCP resources, exposed to the model as tools.
 *
 * The transport layer could always list and read resources, but nothing
 * bridged that into model-callable tools - Claude exposes
 * ListMcpResources/ReadMcpResource and MyClaude did not. These pin the
 * bridge against a fake manager carrying one resource.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { createResourceTools } from "../src/mcp/resource-tools.js";

function fakeMcp() {
  return {
    allResources: () => [
      { server: "srv", uri: "file:///alpha", name: "alpha", description: "A doc" },
      { server: "other", uri: "db://beta", name: "beta", description: "" },
    ],
    readResourceBy: async (uri) => uri === "file:///alpha"
      ? { ok: true, content: "alpha contents" }
      : { ok: false, content: "unknown resource: " + uri },
  };
}

test("the bridge yields exactly ListMcpResources and ReadMcpResource", () => {
  const [list, read] = createResourceTools(fakeMcp());
  assert.equal(list.name, "ListMcpResources");
  assert.equal(read.name, "ReadMcpResource");
});

test("ListMcpResources lists every resource with its server", async () => {
  const [list] = createResourceTools(fakeMcp());
  const out = await list.run({});
  assert.equal(out.ok, true);
  assert.match(out.content, /file:\/\/\/alpha/);
  assert.match(out.content, /\[srv\]/);
  assert.match(out.content, /db:\/\/beta/);
});

test("ListMcpResources filters by server and reports empty cleanly", async () => {
  const [list] = createResourceTools(fakeMcp());
  const out = await list.run({ server: "srv" });
  assert.match(out.content, /file:\/\/\/alpha/);
  assert.doesNotMatch(out.content, /db:\/\/beta/);
  const empty = await list.run({ server: "nope" });
  assert.match(empty.content, /no resources/i);
});

test("ReadMcpResource returns the contents behind a uri", async () => {
  const [, read] = createResourceTools(fakeMcp());
  const out = await read.run({ uri: "file:///alpha" });
  assert.equal(out.ok, true);
  assert.equal(out.content, "alpha contents");
});

test("ReadMcpResource reports an unknown uri instead of throwing", async () => {
  const [, read] = createResourceTools(fakeMcp());
  const out = await read.run({ uri: "db://gone" });
  assert.equal(out.ok, false);
  assert.match(out.content, /unknown resource/);
});
