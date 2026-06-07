import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { OsmStore } from "../packages/store/dist/index.js";
import {
  completeDelegatedTask,
  createChildTrackedTask,
  createTrackedTask,
  delegateTrackedTask,
  recomputeParentTaskStatus,
  setDelegatedTaskWaitingApproval,
} from "../packages/cli/dist/task-runtime.js";

const root = mkdtempSync(join(tmpdir(), "osm-task-smoke-"));
const dbPath = join(root, "task-smoke.db");

const store = new OsmStore({
  dbPath,
  createDirs: true,
  embedding: { providerId: "local-stub", modelId: "stub", dim: 8 },
});

try {
  const now = new Date().toISOString();
  const approvalId = randomUUID();
  const parent = createTrackedTask(store, {
    kind: "manual",
    title: "Smoke task",
    goal: "Verify task tracking schema and store APIs",
    ownerType: "user",
    ownerId: "smoke",
  });

  store.appendRuntimeEvent({
    id: randomUUID(),
    taskId: parent.taskId,
    taskRunId: parent.runId,
    type: "task.started",
    summary: "Smoke task started",
    ts: now,
  });

  const child = createChildTrackedTask(store, parent, {
    kind: "delegated",
    title: "Child smoke task",
    goal: "Verify child task linkage",
    ownerType: "agent",
    ownerId: "subagent",
  });
  store.updateTaskStatus(child.taskId, "completed", { endedAt: now, resultSummary: "done" });

  const delegated = delegateTrackedTask(store, parent, {
    title: "Auto delegated smoke task",
    goal: "Verify delegate flow",
    ownerType: "agent",
    ownerId: "delegate-smoke",
  });
  completeDelegatedTask(store, parent, delegated, "delegate done");

  const delegatedApproval = delegateTrackedTask(store, parent, {
    title: "Approval delegated smoke task",
    goal: "Verify approval rollup",
    ownerType: "agent",
    ownerId: "delegate-approval",
  });
  setDelegatedTaskWaitingApproval(store, parent, delegatedApproval, "needs approval");

  const delegatedFail = delegateTrackedTask(store, parent, {
    title: "Failure delegated smoke task",
    goal: "Verify failure rollup",
    ownerType: "agent",
    ownerId: "delegate-fail",
  });
  store.updateTaskStatus(delegatedFail.taskId, "failed", { endedAt: now, resultSummary: "boom" });
  recomputeParentTaskStatus(store, parent);

  store.createApprovalRequest({
    id: approvalId,
    taskId: parent.taskId,
    taskRunId: parent.runId,
    actionType: "tool_call",
    target: "exec:echo hello",
    reason: "Needs shell execution",
    riskLevel: "high",
    status: "pending",
    requestedAt: now,
  });

  store.updateTaskStatus(parent.taskId, "waiting_approval");

  const task = store.getTask(parent.taskId);
  const children = store.listTaskChildren(parent.taskId);
  const events = store.listRuntimeEvents(parent.taskId);
  const approvals = store.listApprovalRequests(parent.taskId);
  const roots = store.listRootTasks(10);
  const latest = store.getLatestTask();
  const allEvents = store.listRuntimeEventsByTaskIds(
    [parent.taskId, child.taskId, delegated.taskId, delegatedApproval.taskId, delegatedFail.taskId],
    100
  );
  const rollup = recomputeParentTaskStatus(store, parent);

  if (!task) throw new Error("task missing");
  if (children.length !== 4) throw new Error(`expected 4 children, got ${children.length}`);
  if (events.length < 1) throw new Error(`expected >=1 event, got ${events.length}`);
  if (approvals.length !== 1) throw new Error(`expected 1 approval, got ${approvals.length}`);
  if (roots.length !== 1) throw new Error(`expected 1 root task, got ${roots.length}`);
  if (!latest || latest.id !== delegatedFail.taskId) throw new Error(`expected latest task to be delegated fail task`);
  if (!allEvents.some((e) => e.type === "delegate.started")) throw new Error("missing delegate.started event");
  if (!allEvents.some((e) => e.type === "delegate.completed")) throw new Error("missing delegate.completed event");
  if (!allEvents.some((e) => e.type === "delegate.waiting_approval")) throw new Error("missing delegate.waiting_approval event");
  if (!allEvents.some((e) => e.type === "task.rollup.updated")) throw new Error("missing task.rollup.updated event");
  if (rollup.nextStatus !== "waiting_approval") throw new Error(`expected parent rollup waiting_approval, got ${rollup.nextStatus}`);

  console.log(
    JSON.stringify(
      {
        ok: true,
        taskId: parent.taskId,
        childTaskId: child.taskId,
        approvalId,
        dbPath,
      },
      null,
      2
    )
  );
} finally {
  store.close();
  rmSync(root, { recursive: true, force: true });
}
