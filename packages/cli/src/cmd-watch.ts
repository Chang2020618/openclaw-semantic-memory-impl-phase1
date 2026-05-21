/**
 * `osm watch` — incremental reindex on memory/ changes.
 *
 * Uses node:fs.watch directly with recursive: true. We chose this over
 * chokidar because:
 *   - fs.watch is in stdlib (zero deps for a leaf concern)
 *   - in our sandbox testing chokidar's event delivery was unreliable while
 *     raw fs.watch fired correctly (see investigation in commit log)
 *   - the only feature we need is "fire when an .md file changes"
 *
 * Fallback for platforms without recursive support: a 5s polling timer that
 * walks the tree and reindexes on any mtime change.
 */

import { watch as fsWatch, statSync } from "node:fs";
import { join } from "node:path";

import { runIndex } from "./cmd-index.js";
import { resolveWorkspace } from "./workspace.js";

export interface WatchArgs {
  rootFlag: string | undefined;
  providerOverride?: string;
}

export async function runWatch(args: WatchArgs): Promise<number> {
  const paths = resolveWorkspace(args.rootFlag);
  const workspaceMemoryMd = join(paths.workspaceRoot, "MEMORY.md");

  console.log(`osm watch: monitoring ${paths.memoryRoot}`);
  console.log(`             + ${workspaceMemoryMd}`);
  console.log("press Ctrl-C to stop.");

  let inFlight = false;
  let pending = false;
  let debounceTimer: NodeJS.Timeout | null = null;

  const trigger = (reason: string): void => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(async () => {
      if (inFlight) {
        pending = true;
        return;
      }
      inFlight = true;
      try {
        const report = await runIndex({
          rootFlag: args.rootFlag,
          rebuild: false,
          ...(args.providerOverride
            ? { providerOverride: args.providerOverride }
            : {}),
        });
        const ts = new Date().toISOString();
        console.log(
          `[${ts}] osm: ${reason} — files=${report.filesScanned} changed=${report.filesChanged} embeds=${report.embeddingsRequested} (${report.durationMs}ms)`
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`osm watch: index failed — ${msg}`);
      } finally {
        inFlight = false;
        if (pending) {
          pending = false;
          trigger("re-trigger after pending");
        }
      }
    }, 500);
  };

  const watchers: Array<{ close(): void }> = [];
  let stopped = false;

  const isInteresting = (filename: string | null): boolean => {
    if (!filename) return false;
    if (filename.includes(".cache")) return false;
    if (filename.includes(".audit")) return false;
    if (filename.includes(".git")) return false;
    return filename.toLowerCase().endsWith(".md");
  };

  // Try recursive watch on memoryRoot first.
  let recursiveOk = false;
  try {
    const w = fsWatch(
      paths.memoryRoot,
      { recursive: true },
      (event, filename) => {
        if (process.env["OSM_WATCH_DEBUG"]) {
          console.log(`[watch] event=${event} file=${filename}`);
        }
        if (!isInteresting(filename)) return;
        trigger(`memory/${filename}`);
      }
    );
    w.on("error", (err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`osm watch: watcher error — ${msg}`);
    });
    watchers.push(w);
    recursiveOk = true;
  } catch (err) {
    console.error(
      `osm watch: recursive watch unsupported (${
        err instanceof Error ? err.message : String(err)
      }); falling back to polling.`
    );
  }

  // Always also watch the workspace-root MEMORY.md as a single-file watch.
  try {
    statSync(workspaceMemoryMd);
    const w = fsWatch(workspaceMemoryMd, () => {
      trigger("../MEMORY.md");
    });
    w.on("error", () => {
      // ignore — watch may emit after delete
    });
    watchers.push(w);
  } catch {
    // file not present; skip
  }

  // Polling fallback for platforms without recursive watch.
  let pollTimer: NodeJS.Timeout | null = null;
  if (!recursiveOk) {
    let lastSeen = 0;
    const tick = (): void => {
      if (stopped) return;
      try {
        const st = statSync(paths.memoryRoot);
        if (st.mtimeMs > lastSeen) {
          if (lastSeen !== 0) trigger("polling tick");
          lastSeen = st.mtimeMs;
        }
      } catch {
        // ignore
      }
      pollTimer = setTimeout(tick, 2000);
    };
    pollTimer = setTimeout(tick, 2000);
  }

  return new Promise<number>((resolveExit) => {
    const shutdown = (signal: string): void => {
      if (stopped) return;
      stopped = true;
      console.log(`\nosm watch: ${signal} received, shutting down.`);
      for (const w of watchers) {
        try {
          w.close();
        } catch {
          // ignore
        }
      }
      if (pollTimer) clearTimeout(pollTimer);
      resolveExit(0);
    };
    process.on("SIGINT", () => shutdown("SIGINT"));
    process.on("SIGTERM", () => shutdown("SIGTERM"));
  });
}
