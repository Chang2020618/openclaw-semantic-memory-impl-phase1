# Task Control Plane MVP

Status: implemented in `openclaw-semantic-memory-impl` as a minimal but executable task tracking / delegated task control plane.

## Scope

This MVP adds a minimal task model on top of the semantic-memory repo so real command flows can be tracked as:

- root task
- delegated child task
- task runs
- runtime events
- approval requests
- parent status rollup

It is intentionally small and CLI-first.

## Data model

Added tables:

- `tasks`
- `task_runs`
- `runtime_events`
- `approval_requests`

Key type additions live in:

- `packages/core/src/types.ts`

Key store logic lives in:

- `packages/store/src/schema.sql`
- `packages/store/src/sqlite.ts`

## Runtime pieces

CLI/runtime helper logic lives in:

- `packages/cli/src/task-runtime.ts`
- `packages/cli/src/cmd-task.ts`

Main capabilities:

- create tracked root task
- create delegated child task
- mark child completed / failed / waiting approval
- emit timeline events
- recompute parent status from child states

## Parent rollup rule

Implemented in `recomputeParentTaskStatus(...)`.

Priority order:

1. `waiting_approval`
2. `waiting_input`
3. `failed`
4. `blocked`
5. all children completed => parent `completed`
6. otherwise => parent `running`

This is optimized for control-plane visibility: the most actionable current blocker wins.

## Real command seams wired in

The task plane is not only a manual demo. It is already wired into:

- `cmd-index.ts`
- `cmd-watch.ts`
- `cmd-summarize.ts`
- `cmd-summarize-watch.ts`

Most important path:

### `summarize-watch`

`osm summarize-watch` now maps work as:

- watcher root task
- delegated child task per session summarize attempt
- child success/failure reflected back to parent timeline

Representative event types:

- `delegate.started`
- `delegate.completed`
- `delegate.failed`
- `delegate.waiting_approval`
- `summarize-watch.session.scheduled`
- `summarize-watch.session.done`
- `summarize-watch.session.error`
- `task.rollup.updated`

## CLI surface

Task control commands:

- `osm task start`
- `osm task child`
- `osm task delegate`
- `osm task show`
- `osm task list`
- `osm task roots`
- `osm task latest`
- `osm task children`
- `osm task events`

Query/export-friendly JSON surfaces:

### `task roots`

```bash
node packages/cli/dist/index.js task roots --root <root> --json
```

Returns:

```json
{ "tasks": [...] }
```

### `task children`

```bash
node packages/cli/dist/index.js task children <taskId> --root <root> --json
```

Returns:

```json
{ "task": { ... }, "children": [...] }
```

### `task events`

```bash
node packages/cli/dist/index.js task events <taskId> --root <root> --tree --limit 50 --json
```

Returns:

```json
{ "task": { ... }, "scope": "tree", "events": [...] }
```

`--tree` aggregates events across the whole task tree.

## Validation done

Validated with:

```bash
pnpm --filter @osm/store build
pnpm --filter @osm/cli typecheck
pnpm --filter @osm/cli build
node scripts/smoke-task.ts
```

Latest verified result included:

- build: pass
- typecheck: pass
- CLI build: pass
- smoke-task: pass

Example smoke output:

```json
{
  "ok": true,
  "taskId": "95b0c567-8c68-4542-b953-d83970eb8aba",
  "childTaskId": "0ac99ecc-5dbf-440d-8459-fbad8c450d11",
  "approvalId": "90a347ba-fc7d-4d28-a055-7de38654979e",
  "dbPath": "/tmp/osm-task-smoke-qmtSjo/task-smoke.db"
}
```

## Current conclusion

This repo-side MVP is considered functionally closed.

The next step is not to keep expanding this experimental task plane, but to compare it against the OpenClaw main runtime task/taskflow system and decide what should be upstreamed:

1. event/timeline query surface
2. delegated parent-child rollup semantics
3. JSON-friendly control-plane query/export surface
