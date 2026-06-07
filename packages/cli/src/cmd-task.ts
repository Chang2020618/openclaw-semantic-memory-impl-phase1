import { OsmStore } from "@osm/store";

import { ensureMemoryRoot, loadOrInitConfig, resolveWorkspace } from "./workspace.js";
import {
  completeDelegatedTask,
  createChildTrackedTask,
  createTrackedTask,
  delegateTrackedTask,
  failDelegatedTask,
  recomputeParentTaskStatus,
  setDelegatedTaskWaitingApproval,
} from "./task-runtime.js";

export interface RunTaskCmdOptions {
  rootFlag?: string;
  title: string;
  goal: string;
  sessionKey?: string;
  ownerType?: "user" | "agent" | "system";
  ownerId?: string;
}

export interface ShowTaskCmdOptions {
  rootFlag?: string;
  taskId: string;
  json?: boolean;
  tree?: boolean;
  eventsLimit?: number;
}

export interface ListTaskCmdOptions {
  rootFlag?: string;
  json?: boolean;
  limit?: number;
}

export interface LatestTaskCmdOptions {
  rootFlag?: string;
  json?: boolean;
}

export interface TaskEventsCmdOptions {
  rootFlag?: string;
  taskId: string;
  json?: boolean;
  tree?: boolean;
  limit?: number;
}

export interface TaskChildrenCmdOptions {
  rootFlag?: string;
  taskId: string;
  json?: boolean;
}

export interface SpawnChildTaskCmdOptions {
  rootFlag?: string;
  parentTaskId: string;
  title: string;
  goal: string;
  sessionKey?: string;
  ownerType?: "user" | "agent" | "system";
  ownerId?: string;
}

export interface DelegateTaskCmdOptions {
  rootFlag?: string;
  parentTaskId: string;
  title: string;
  goal: string;
  sessionKey?: string;
  ownerType?: "user" | "agent" | "system";
  ownerId?: string;
  complete?: boolean;
  fail?: boolean;
  waitApproval?: boolean;
  resultSummary?: string;
}

export function runTaskStart(opts: RunTaskCmdOptions): number {
  const paths = resolveWorkspace(opts.rootFlag);
  ensureMemoryRoot(paths);
  const config = loadOrInitConfig(paths);
  const store = new OsmStore({
    dbPath: paths.dbPath,
    embedding: {
      providerId: config.embedding.providerId,
      modelId: config.embedding.modelId,
      dim: config.embedding.dim,
    },
  });
  try {
    const handle = createTrackedTask(store, {
      kind: "manual",
      title: opts.title,
      goal: opts.goal,
      sessionKey: opts.sessionKey,
      ownerType: opts.ownerType,
      ownerId: opts.ownerId ?? "cli",
    });
    console.log(JSON.stringify({ ok: true, taskId: handle.taskId, runId: handle.runId }, null, 2));
    return 0;
  } finally {
    store.close();
  }
}

export function runTaskShow(opts: ShowTaskCmdOptions): number {
  const paths = resolveWorkspace(opts.rootFlag);
  ensureMemoryRoot(paths);
  const config = loadOrInitConfig(paths);
  const store = new OsmStore({
    dbPath: paths.dbPath,
    embedding: {
      providerId: config.embedding.providerId,
      modelId: config.embedding.modelId,
      dim: config.embedding.dim,
    },
  });
  try {
    const task = store.getTask(opts.taskId);
    if (!task) {
      console.error(`osm task show: task not found: ${opts.taskId}`);
      return 1;
    }
    const tree = opts.tree ? buildTaskTree(store, task.id) : undefined;
    const taskIds = opts.tree && tree ? flattenTaskIds(tree) : [task.id];
    const runs = store.listTaskRuns(task.id);
    const children = store.listTaskChildren(task.id);
    const events = opts.tree
      ? store.listRuntimeEventsByTaskIds(taskIds, opts.eventsLimit ?? 500)
      : store.listRuntimeEvents(task.id, opts.eventsLimit ?? 500);
    const approvals = opts.tree
      ? store.listApprovalRequestsByTaskIds(taskIds)
      : store.listApprovalRequests(task.id);
    const payload = { task, runs, children, ...(tree ? { tree } : {}), events, approvals };
    if (opts.json) {
      console.log(JSON.stringify(payload, null, 2));
      return 0;
    }
    console.log(`task ${task.id}`);
    console.log(`status: ${task.status}`);
    console.log(`title: ${task.title}`);
    console.log(`goal: ${task.goal}`);
    console.log(`children: ${children.length} | runs: ${runs.length} | events: ${events.length} | approvals: ${approvals.length}`);
    if (task.resultSummary) {
      console.log(`result: ${task.resultSummary}`);
    }
    if (opts.tree && tree) {
      console.log("\ntask tree:");
      printTaskTree(tree, 0);
    } else if (children.length > 0) {
      console.log("\nchild tasks:");
      for (const child of children) {
        console.log(`- ${child.id} [${child.status}] ${child.title}`);
      }
    }
    if (events.length > 0) {
      console.log("\ntimeline:");
      for (const event of events.slice(-(opts.eventsLimit ?? 20))) {
        console.log(`- ${event.ts} ${event.type}: ${event.summary}`);
      }
    }
    return 0;
  } finally {
    store.close();
  }
}

export function runTaskList(opts: ListTaskCmdOptions): number {
  const paths = resolveWorkspace(opts.rootFlag);
  ensureMemoryRoot(paths);
  const config = loadOrInitConfig(paths);
  const store = new OsmStore({
    dbPath: paths.dbPath,
    embedding: {
      providerId: config.embedding.providerId,
      modelId: config.embedding.modelId,
      dim: config.embedding.dim,
    },
  });
  try {
    const tasks = store.listRootTasks(opts.limit ?? 20);
    if (opts.json) {
      console.log(JSON.stringify({ tasks }, null, 2));
      return 0;
    }
    for (const task of tasks) {
      console.log(`${task.id} [${task.status}] ${task.title}`);
    }
    return 0;
  } finally {
    store.close();
  }
}

export function runTaskRoots(opts: ListTaskCmdOptions): number {
  return runTaskList(opts);
}

export function runTaskLatest(opts: LatestTaskCmdOptions): number {
  const paths = resolveWorkspace(opts.rootFlag);
  ensureMemoryRoot(paths);
  const config = loadOrInitConfig(paths);
  const store = new OsmStore({
    dbPath: paths.dbPath,
    embedding: {
      providerId: config.embedding.providerId,
      modelId: config.embedding.modelId,
      dim: config.embedding.dim,
    },
  });
  try {
    const task = store.getLatestTask();
    if (!task) {
      console.error("osm task latest: no tasks found");
      return 1;
    }
    return runTaskShow({
      rootFlag: opts.rootFlag,
      taskId: task.id,
      json: opts.json,
      tree: true,
      eventsLimit: 30,
    });
  } finally {
    store.close();
  }
}

export function runTaskEvents(opts: TaskEventsCmdOptions): number {
  const paths = resolveWorkspace(opts.rootFlag);
  ensureMemoryRoot(paths);
  const config = loadOrInitConfig(paths);
  const store = new OsmStore({
    dbPath: paths.dbPath,
    embedding: {
      providerId: config.embedding.providerId,
      modelId: config.embedding.modelId,
      dim: config.embedding.dim,
    },
  });
  try {
    const task = store.getTask(opts.taskId);
    if (!task) {
      console.error(`osm task events: task not found: ${opts.taskId}`);
      return 1;
    }
    const tree = opts.tree ? buildTaskTree(store, task.id) : undefined;
    const taskIds = opts.tree && tree ? flattenTaskIds(tree) : [task.id];
    const events = opts.tree
      ? store.listRuntimeEventsByTaskIds(taskIds, opts.limit ?? 100)
      : store.listRuntimeEvents(task.id, opts.limit ?? 100);

    if (opts.json) {
      console.log(
        JSON.stringify(
          {
            task,
            scope: opts.tree ? "tree" : "task",
            events,
          },
          null,
          2
        )
      );
      return 0;
    }

    for (const event of events) {
      console.log(`${event.ts} ${event.taskId} ${event.type} ${event.summary}`);
    }
    return 0;
  } finally {
    store.close();
  }
}

export function runTaskChildren(opts: TaskChildrenCmdOptions): number {
  const paths = resolveWorkspace(opts.rootFlag);
  ensureMemoryRoot(paths);
  const config = loadOrInitConfig(paths);
  const store = new OsmStore({
    dbPath: paths.dbPath,
    embedding: {
      providerId: config.embedding.providerId,
      modelId: config.embedding.modelId,
      dim: config.embedding.dim,
    },
  });
  try {
    const task = store.getTask(opts.taskId);
    if (!task) {
      console.error(`osm task children: task not found: ${opts.taskId}`);
      return 1;
    }
    const children = store.listTaskChildren(task.id);
    if (opts.json) {
      console.log(JSON.stringify({ task, children }, null, 2));
      return 0;
    }
    for (const child of children) {
      console.log(`${child.id} [${child.status}] ${child.title}`);
    }
    return 0;
  } finally {
    store.close();
  }
}

export function runTaskChild(opts: SpawnChildTaskCmdOptions): number {
  const paths = resolveWorkspace(opts.rootFlag);
  ensureMemoryRoot(paths);
  const config = loadOrInitConfig(paths);
  const store = new OsmStore({
    dbPath: paths.dbPath,
    embedding: {
      providerId: config.embedding.providerId,
      modelId: config.embedding.modelId,
      dim: config.embedding.dim,
    },
  });
  try {
    const parent = store.getTask(opts.parentTaskId);
    if (!parent) {
      console.error(`osm task child: parent task not found: ${opts.parentTaskId}`);
      return 1;
    }
    const handle = createChildTrackedTask(store, { taskId: parent.id, runId: "manual-parent" }, {
      kind: "delegated",
      title: opts.title,
      goal: opts.goal,
      sessionKey: opts.sessionKey,
      ownerType: opts.ownerType,
      ownerId: opts.ownerId ?? "cli-child",
    });
    console.log(JSON.stringify({ ok: true, parentTaskId: parent.id, taskId: handle.taskId, runId: handle.runId }, null, 2));
    return 0;
  } finally {
    store.close();
  }
}

export function runTaskDelegate(opts: DelegateTaskCmdOptions): number {
  const paths = resolveWorkspace(opts.rootFlag);
  ensureMemoryRoot(paths);
  const config = loadOrInitConfig(paths);
  const store = new OsmStore({
    dbPath: paths.dbPath,
    embedding: {
      providerId: config.embedding.providerId,
      modelId: config.embedding.modelId,
      dim: config.embedding.dim,
    },
  });
  try {
    const parent = store.getTask(opts.parentTaskId);
    if (!parent) {
      console.error(`osm task delegate: parent task not found: ${opts.parentTaskId}`);
      return 1;
    }
    const parentRun = store.listTaskRuns(parent.id).slice(-1)[0];
    if (!parentRun) {
      console.error(`osm task delegate: parent task has no run: ${opts.parentTaskId}`);
      return 1;
    }
    const parentHandle = { taskId: parent.id, runId: parentRun.id };
    const child = delegateTrackedTask(store, parentHandle, {
      title: opts.title,
      goal: opts.goal,
      sessionKey: opts.sessionKey,
      ownerType: opts.ownerType,
      ownerId: opts.ownerId ?? "delegate",
    });

    if (opts.waitApproval) {
      setDelegatedTaskWaitingApproval(
        store,
        parentHandle,
        child,
        opts.resultSummary ?? `Delegated task waiting approval: ${opts.title}`
      );
    } else if (opts.fail) {
      failDelegatedTask(
        store,
        parentHandle,
        child,
        new Error(opts.resultSummary ?? `Delegated task failed: ${opts.title}`)
      );
    } else if (opts.complete ?? true) {
      completeDelegatedTask(
        store,
        parentHandle,
        child,
        opts.resultSummary ?? `Delegated task completed: ${opts.title}`
      );
    }

    const rollup = recomputeParentTaskStatus(store, parentHandle);

    console.log(
      JSON.stringify(
        {
          ok: true,
          parentTaskId: parent.id,
          childTaskId: child.taskId,
          childRunId: child.runId,
          status: opts.waitApproval ? "waiting_approval" : opts.fail ? "failed" : opts.complete ?? true ? "completed" : "running",
          parentStatus: rollup.nextStatus,
        },
        null,
        2
      )
    );
    return 0;
  } finally {
    store.close();
  }
}

function buildTaskTree(store: OsmStore, taskId: string): TaskTreeNode | null {
  const task = store.getTask(taskId);
  if (!task) return null;
  const children = store.listTaskChildren(task.id).map((child) => buildTaskTree(store, child.id)).filter(Boolean) as TaskTreeNode[];
  return { task, children };
}

interface TaskTreeNode {
  task: NonNullable<ReturnType<OsmStore["getTask"]>>;
  children: TaskTreeNode[];
}

function flattenTaskIds(node: TaskTreeNode): string[] {
  return [node.task.id, ...node.children.flatMap(flattenTaskIds)];
}

function printTaskTree(node: TaskTreeNode, depth: number): void {
  const indent = "  ".repeat(depth);
  console.log(`${indent}- ${node.task.id} [${node.task.status}] ${node.task.title}`);
  for (const child of node.children) {
    printTaskTree(child, depth + 1);
  }
}
