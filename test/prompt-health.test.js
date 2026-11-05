import test from "node:test";
import assert from "node:assert/strict";
import { auditPrompt, buildPrompt, inspect } from "../scripts/inspect-prompt.mjs";

test("the real assembled prompt passes every health check", () => {
  const res = inspect();
  const errors = res.findings.filter((f) => f.level === "error");
  assert.deepEqual(errors, [], "health errors: " + JSON.stringify(errors));
  assert.equal(res.reports.length, 2, "both autoRun modes inspected");
});

test("project memory appears exactly once in the real prompt", () => {
  const prompt = buildPrompt({ autoRun: false });
  const n = (prompt.match(/^# From /gm) || []).length;
  assert.equal(n, 1, "memory loaded once, not twice (case-insensitive fs collision)");
});

test("the auditor catches a duplicated memory file", () => {
  // 用一份人造提示词反证体检本身是有效的：同样的文件出现两次必须报错。
  const bad = "# System\n\nx\n\n# From C:\\a\\MYCLAUDE.md\n\nbody\n\n# From C:\\a\\myclaude.md\n\nbody\n";
  const findings = auditPrompt(bad, { autoRun: false, skills: [] });
  assert.ok(findings.some((f) => f.code === "memory-duplicate" && f.level === "error"),
    "duplicate memory is an error: " + JSON.stringify(findings));
});

test("the auditor catches a missing required section", () => {
  const findings = auditPrompt("# System\n\nx\n", { autoRun: false, skills: [] });
  assert.ok(findings.some((f) => f.code === "section-missing"), "missing sections reported");
});

test("the auditor catches autonomy leaking into a non-autonomous prompt", () => {
  const withAuto = buildPrompt({ autoRun: true });
  const findings = auditPrompt(withAuto, { autoRun: false, skills: [] });
  assert.ok(findings.some((f) => f.code === "autonomy-leak"), "leak reported");
});
