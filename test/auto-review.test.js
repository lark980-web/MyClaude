/**
 * The auto-mode reviewer.
 *
 * Claude describes auto mode as "no routine prompts; a reviewer model screens
 * actions". These tests pin the rule that makes the reviewer safe: an answer
 * that carries a condition is not a yes.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { reviewToolCall } from "../src/agent/auto-review.js";

/** A provider stub that answers with fixed text. */
function stub(text, shouldThrow = false) {
  return {
    async complete() {
      if (shouldThrow) { throw new Error("backend down"); }
      return { text };
    },
  };
}

test("reading never needs a review", async () => {
  // Asking about every Read would add a request to every turn for nothing.
  for (const tool of ["Read", "LS", "Glob", "Grep", "TaskOutput"]) {
    const r = await reviewToolCall(stub("ASK"), tool, { file_path: "a.js" });
    assert.equal(r.allow, true, tool + " should not be reviewed");
    assert.equal(r.reason, "read-only");
  }
});

test("an ALLOW answer allows the call", async () => {
  const r = await reviewToolCall(stub("ALLOW"), "Bash", { command: "npm test" });
  assert.equal(r.allow, true);
});

test("an ASK answer sends the call to the user", async () => {
  const r = await reviewToolCall(stub("ASK"), "Bash", { command: "rm -rf /" });
  assert.equal(r.allow, false);
});

test("a plain answer is understood in its usual spellings", async () => {
  // The reviewer may answer with a period or in past tense; both mean the same.
  for (const answer of ["ALLOW", "allowed", "Allow.", " ask", "ASK."]) {
    const r = await reviewToolCall(stub(answer), "Bash", { command: "npm test" });
    assert.notEqual(r.allow, null, JSON.stringify(answer) + " should be understood");
  }
});

test("an answer with a reason attached is not a yes", async () => {
  // A prefix match would read "ALLOW because it is safe" as permission, but the
  // reviewer was asked for one word and did not give one. Undecided is the
  // honest reading, and the caller then asks the user.
  for (const answer of ["ALLOW because it is safe", "I would allow this"]) {
    const r = await reviewToolCall(stub(answer), "Write", { file_path: "a.js" });
    assert.equal(r.allow, null, JSON.stringify(answer) + " must not allow");
  }
});

test("an unusable answer is not permission", async () => {
  for (const answer of ["", "maybe", "yes", "I think it is fine?"]) {
    const r = await reviewToolCall(stub(answer), "Write", { file_path: "a.js" });
    assert.equal(r.allow, null, JSON.stringify(answer) + " must not allow");
  }
});

test("a failed review is not permission either", async () => {
  const r = await reviewToolCall(stub("", true), "Write", { file_path: "a.js" });
  assert.equal(r.allow, null);
  assert.match(r.reason, /reviewer failed/);
});

test("no reviewer available means no decision", async () => {
  // Without a way to ask, the caller must fall back to the normal flow rather
  // than treating the absence as an allow.
  const r = await reviewToolCall(null, "Write", { file_path: "a.js" });
  assert.equal(r.allow, null);
  assert.match(r.reason, /no reviewer/);
});

test("the reviewer is told what the call does", async () => {
  let seen = null;
  const provider = { async complete(args) { seen = args.prompt; return { text: "ASK" }; } };
  await reviewToolCall(provider, "Bash", { command: "git push --force" });
  assert.match(seen, /git push --force/, "the command reaches the reviewer");
  assert.match(seen, /ALLOW|ASK/, "the answer format is stated");
});
