import { randomUUID } from "node:crypto";

import type {
  ApprovalActionType,
  ApprovalRiskLevel,
  ApprovalStatus,
  RuntimeEvent,
  Task,
  TaskKind,
  TaskRun,
  TaskStatus,
} from "@osm/core";
import { OsmStore } from "@osm/store";

export interface TaskRuntimeHandle {
  taskId: string;
  runId: string;
}

export interface DelegateTrackedTaskOptions {
  sessionKey?: string;
  title: string;
  goal: string;
  ownerType?: "user" | "agent" | "system";
  ownerId?: string;
  childKind?: TaskKind;
}

export interface ParentStatusRollup {
  nextStatus: Extract<TaskStatus, "running" | "waiting_approval" | "waiting_input" | "blocked" | "failed" | "completed">;
  summary: string;
  counts: Record<string, number>;
}

export interface CreateTrackedTaskOptions {
  kind: TaskKind;
  title: string;
  goal: string;
  sessionKey?: string;
  ownerType?: "user" | "agent" | "system";
  ownerId?: string;
  parentTaskId?: string;
  rootTaskId?: string;
}

export function createTrackedTask(
  store: OsmStore,
  opts: CreateTrackedTaskOptions
): TaskRuntimeHandle {
  const now = new Date().toISOString();
  const taskId = randomUUID();
  const runId = randomUUID();
  const task: Task = {
    id: taskId,
    kind: opts.kind,
    title: opts.title,
    goal: opts.goal,
    status: "running",
    parentTaskId: opts.parentTaskId,
    rootTaskId: opts.rootTaskId ?? taskId,
    sessionKey: opts.sessionKey,
    ownerType: opts.ownerType ?? "system",
    ownerId: opts.ownerId ?? "osm",
    createdAt: now,
    updatedAt: now,
    startedAt: now,
  };
  const run: TaskRun = {
    id: runId,
    taskId,
    attempt: 1,
    status: "running",
    sessionKey: opts.sessionKey,
    startedAt: now,
  };
  store.createTask(task);
  store.createTaskRun(run);
  appendTaskEvent(store, {
    id: randomUUID(),
    taskId,
    taskRunId: runId,
    sessionKey: opts.sessionKey,
    type: "task.created",
    summary: `Task created: ${opts.title}`,
    payloadJson: JSON.stringify({ goal: opts.goal, kind: opts.kind }),
    ts: now,
  });
  appendTaskEvent(store, {
    id: randomUUID(),
    taskId,
    taskRunId: runId,
    sessionKey: opts.sessionKey,
    type: "task.started",
    summary: `Task started: ${opts.title}`,
    ts: now,
  });
  return { taskId, runId };
}

export function createChildTrackedTask(
  store: OsmStore,
  parent: TaskRuntimeHandle,
  opts: Omit<CreateTrackedTaskOptions, "parentTaskId" | "rootTaskId">
): TaskRuntimeHandle {
  const parentTask = store.getTask(parent.taskId);
  return createTrackedTask(store, {
    ...opts,
    parentTaskId: parent.taskId,
    rootTaskId: parentTask?.rootTaskId ?? parent.taskId,
  });
}

export function delegateTrackedTask(
  store: OsmStore,
  parent: TaskRuntimeHandle,
  opts: DelegateTrackedTaskOptions
): TaskRuntimeHandle {
  const child = createChildTrackedTask(store, parent, {
    kind: opts.childKind ?? "delegated",
    title: opts.title,
    goal: opts.goal,
    sessionKey: opts.sessionKey,
    ownerType: opts.ownerType ?? "agent",
    ownerId: opts.ownerId ?? "delegate",
  });
  appendTaskEvent(store, {
    id: randomUUID(),
    taskId: parent.taskId,
    taskRunId: parent.runId,
    sessionKey: opts.sessionKey,
    type: "delegate.started",
    summary: `Delegated child task: ${opts.title}`,
    payloadJson: JSON.stringify({ childTaskId: child.taskId, goal: opts.goal }),
    ts: new Date().toISOString(),
  });
  return child;
}

export function appendTaskEvent(store: OsmStore, event: RuntimeEvent): void {
  store.appendRuntimeEvent(event);
  store.appendAudit("task", event);
}

export function completeTrackedTask(
  store: OsmStore,
  handle: TaskRuntimeHandle,
  resultSummary?: string
): void {
  const now = new Date().toISOString();
  store.updateTaskRunStatus(handle.runId, "completed", { endedAt: now });
  store.updateTaskStatus(handle.taskId, "completed", {
    endedAt: now,
    resultSummary,
  });
  appendTaskEvent(store, {
    id: randomUUID(),
    taskId: handle.taskId,
    taskRunId: handle.runId,
    type: "task.completed",
    summary: resultSummary ? `Task completed: ${resultSummary}` : "Task completed",
    ts: now,
  });
}

export function completeDelegatedTask(
  store: OsmStore,
  parent: TaskRuntimeHandle,
  child: TaskRuntimeHandle,
  resultSummary?: string
): void {
  completeTrackedTask(store, child, resultSummary);
  appendTaskEvent(store, {
    id: randomUUID(),
    taskId: parent.taskId,
    taskRunId: parent.runId,
    type: "delegate.completed",
    summary: resultSummary
      ? `Delegated child completed: ${resultSummary}`
      : "Delegated child completed",
    payloadJson: JSON.stringify({ childTaskId: child.taskId }),
    ts: new Date().toISOString(),
  });
}

export function failDelegatedTask(
  store: OsmStore,
  parent: TaskRuntimeHandle,
  child: TaskRuntimeHandle,
  error: unknown,
  status: Extract<TaskStatus, "failed" | "blocked" | "cancelled"> = "failed"
): void {
  failTrackedTask(store, child, error, status);
  appendTaskEvent(store, {
    id: randomUUID(),
    taskId: parent.taskId,
    taskRunId: parent.runId,
    type: "delegate.failed",
    summary: error instanceof Error ? error.message : String(error),
    payloadJson: JSON.stringify({ childTaskId: child.taskId, status }),
    ts: new Date().toISOString(),
  });
}

export function recomputeParentTaskStatus(
  store: OsmStore,
  parent: TaskRuntimeHandle
): ParentStatusRollup {
  const counts = Object.fromEntries(
    store.countTaskChildrenByStatus(parent.taskId).map((row) => [row.status, row.count])
  ) as Record<string, number>;
  const total = Object.values(counts).reduce((sum, n) => sum + n, 0);

  let nextStatus: ParentStatusRollup["nextStatus"] = "running";
  if ((counts["waiting_approval"] ?? 0) > 0) {
    nextStatus = "waiting_approval";
  } else if ((counts["waiting_input"] ?? 0) > 0) {
    nextStatus = "waiting_input";
  } else if ((counts["failed"] ?? 0) > 0) {
    nextStatus = "failed";
  } else if ((counts["blocked"] ?? 0) > 0) {
    nextStatus = "blocked";
  } else if (total > 0 && total === (counts["completed"] ?? 0)) {
    nextStatus = "completed";
  } else {
    nextStatus = "running";
  }

  const summary = [
    `children=${total}`,
    `completed=${counts["completed"] ?? 0}`,
    `running=${counts["running"] ?? 0}`,
    `waiting_approval=${counts["waiting_approval"] ?? 0}`,
    `waiting_input=${counts["waiting_input"] ?? 0}`,
    `failed=${counts["failed"] ?? 0}`,
    `blocked=${counts["blocked"] ?? 0}`,
  ].join(" ");

  const current = store.getTask(parent.taskId);
  if (current && current.status !== nextStatus) {
    const endAt = nextStatus === "completed" || nextStatus === "failed" || nextStatus === "blocked"
      ? new Date().toISOString()
      : undefined;
    store.updateTaskStatus(parent.taskId, nextStatus, {
      ...(endAt ? { endedAt: endAt } : {}),
      resultSummary: summary,
    });
    appendTaskEvent(store, {
      id: randomUUID(),
      taskId: parent.taskId,
      taskRunId: parent.runId,
      type: "task.rollup.updated",
      summary: `Parent status -> ${nextStatus} (${summary})`,
      payloadJson: JSON.stringify({ nextStatus, counts }),
      ts: new Date().toISOString(),
    });
  }

  return { nextStatus, summary, counts };
}

export function setDelegatedTaskWaitingApproval(
  store: OsmStore,
  parent: TaskRuntimeHandle,
  child: TaskRuntimeHandle,
  summary: string
): void {
  setTrackedTaskStatus(store, child, "waiting_approval", summary);
  appendTaskEvent(store, {
    id: randomUUID(),
    taskId: parent.taskId,
    taskRunId: parent.runId,
    type: "delegate.waiting_approval",
    summary,
    payloadJson: JSON.stringify({ childTaskId: child.taskId }),
    ts: new Date().toISOString(),
  });
  recomputeParentTaskStatus(store, parent);
}

export function failTrackedTask(
  store: OsmStore,
  handle: TaskRuntimeHandle,
  error: unknown,
  status: Extract<TaskStatus, "failed" | "blocked" | "cancelled"> = "failed"
): void {
  const now = new Date().toISOString();
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  store.updateTaskRunStatus(handle.runId, status === "cancelled" ? "cancelled" : "failed", {
    endedAt: now,
    errorMessage: message,
  });
  store.updateTaskStatus(handle.taskId, status, {
    endedAt: now,
    resultSummary: message,
  });
  appendTaskEvent(store, {
    id: randomUUID(),
    taskId: handle.taskId,
    taskRunId: handle.runId,
    type: "task.failed",
    summary: message,
    ts: now,
  });
}

export function setTrackedTaskStatus(
  store: OsmStore,
  handle: TaskRuntimeHandle,
  status: Extract<TaskStatus, "waiting_approval" | "waiting_input" | "running">,
  summary: string
): void {
  store.updateTaskStatus(handle.taskId, status);
  appendTaskEvent(store, {
    id: randomUUID(),
    taskId: handle.taskId,
    taskRunId: handle.runId,
    type: `task.${status}`,
    summary,
    ts: new Date().toISOString(),
  });
}

export function addTrackedApprovalRequest(
  store: OsmStore,
  handle: TaskRuntimeHandle,
  opts: {
    sessionKey?: string;
    actionType: ApprovalActionType;
    target: string;
    reason: string;
    riskLevel: ApprovalRiskLevel;
    status?: ApprovalStatus;
    decidedBy?: string;
    decidedAt?: string;
  }
): string {
  const id = randomUUID();
  const now = new Date().toISOString();
  store.createApprovalRequest({
    id,
    taskId: handle.taskId,
    taskRunId: handle.runId,
    sessionKey: opts.sessionKey,
    actionType: opts.actionType,
    target: opts.target,
    reason: opts.reason,
    riskLevel: opts.riskLevel,
    status: opts.status ?? "pending",
    requestedAt: now,
    decidedBy: opts.decidedBy,
    decidedAt: opts.decidedAt,
  });
  if ((opts.status ?? "pending") === "pending") {
    setTrackedTaskStatus(store, handle, "waiting_approval", `Approval requested for ${opts.target}`);
  } else {
    appendTaskEvent(store, {
      id: randomUUID(),
      taskId: handle.taskId,
      taskRunId: handle.runId,
      sessionKey: opts.sessionKey,
      type: "approval.recorded",
      summary: `Approval ${opts.status} for ${opts.target}`,
      ts: now,
    });
  }
  return id;
}
