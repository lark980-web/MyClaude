/**
 * The task kinds beyond a shell command.
 *
 * The registry holds every task the same way; these tests pin how each kind
 * is started and what its fields mean. The shapes follow Claude Code:
 * an mcp_task shows "server/tool", a monitor carries a status message, and a
 * workflow validates its script before it becomes a task.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import { TASK_TYPES, TASK_TYPE_LIST, TASK_STATUS, TaskRegistry } from "../src/tasks/registry.js";
import {
  startMcpTask,
  startMonitor,
  setMonitorStatus,
  startWorkflow,
  setWorkflowStep,
  workflowScriptBlocker,
} from "../src/tasks/kinds.js";

const scratch = () => mkdtempSync(join(process.env.TEMP || ".", "kind-"));

test("the kinds Claude models that MyClaude implements are all known", () => {
  // The ones implemented so far. Still missing: in_process_teammate, teammate,
  // remote_agent (the last two depend on Claude's cloud team feature).
  assert.deepEqual([...TASK_TYPE_LIST].sort(), [
    "auto_mode_scan", "dream", "local_agent", "local_bash",
    "mcp_task", "monitor_mcp", "monitor_ws", "workflow",
  ]);
});

test("an mcp task is labelled server/tool", () => {
  const task = startMcpTask({ serverName: "notion", toolName: "search" });
  assert.equal(task.type, TASK_TYPES.MCP_TASK);
  assert.equal(task.label, "notion/search");
  assert.equal(task.status, TASK_STATUS.RUNNING);
  assert.equal(task.meta.serverName, "notion");
  assert.equal(task.meta.toolName, "search");
});

test("a monitor starts running and carries a status message", () => {
  const task = startMonitor({ kind: "mcp", description: "watch the board" });
  assert.equal(task.type, TASK_TYPES.MONITOR_MCP);
  assert.equal(task.status, TASK_STATUS.RUNNING, "a monitor never waits to start");
  assert.equal(task.meta.statusMessage, "");
  setMonitorStatus(task, "connected");
  assert.equal(task.meta.statusMessage, "connected");
});

test("the two monitor kinds are distinct", () => {
  const a = startMonitor({ kind: "mcp", description: "a" });
  const b = startMonitor({ kind: "ws", description: "b" });
  assert.equal(a.type, TASK_TYPES.MONITOR_MCP);
  assert.equal(b.type, TASK_TYPES.MONITOR_WS);
  assert.notEqual(a.id, b.id);
});

test("a workflow refuses a script that is not there", () => {
  const root = scratch();
  try {
    const res = startWorkflow({ scriptPath: join(root, "missing.js"), cwd: root });
    assert.equal(res.ok, false);
    assert.match(res.error, /no such script/);
    // A rejected workflow must not leave a task behind.
    assert.equal(new TaskRegistry().list().length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a workflow needs a path at all", () => {
  assert.equal(workflowScriptBlocker("", process.cwd()), "a workflow needs a script path");
});

test("a workflow runs a script that exists", () => {
  const root = scratch();
  try {
    const script = join(root, "wf.js");
    writeFileSync(script, "// a workflow script", "utf8");
    const res = startWorkflow({ scriptPath: "wf.js", steps: ["build", "test"], cwd: root });
    assert.equal(res.ok, true);
    assert.equal(res.task.type, TASK_TYPES.WORKFLOW);
    assert.equal(res.task.meta.scriptPath, script, "the path is resolved");
    assert.equal(res.task.meta.currentStep, -1, "no step has run yet");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a step is recorded as progress and as output", () => {
  const root = scratch();
  try {
    const script = join(root, "wf.js");
    writeFileSync(script, "// wf", "utf8");
    const { task } = startWorkflow({ scriptPath: "wf.js", steps: ["build", "test"], cwd: root });
    setWorkflowStep(task, 0, "build");
    assert.equal(task.meta.currentStep, 0);
    assert.match(task.output, /step 1/);
    assert.match(task.output, /build/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a directory is not a workflow script", () => {
  const root = scratch();
  try {
    const why = workflowScriptBlocker(root, root);
    assert.match(why, /not a file/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
