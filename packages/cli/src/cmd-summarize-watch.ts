import { watch as fsWatch, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import {
  appendSummarizeQueueMarker,
  loadSummarizeQueue,
  runSummarize,
  saveSummarizeQueue,
  type SummarizeQueueEntry,
} from "./cmd-summarize.js";

export interface SummarizeWatchArgs {
  rootFlag: string | undefined;
  agentId?: string;
  idleMs?: number;
  settleMs?: number;
  ttlDays?: number;
  modelOverride?: string;
  coldStartMaxAgeMs?: number;
}

interface SessionState {
  lastMtimeMs: number;
  lastSize: number;
  updatedAt: string;
}

type StateFile = Record<string, SessionState>;

function getSessionsDir(agentId: string): string {
  return join(homedir(), ".openclaw", "agents", agentId, "sessions");
}

function getStatePath(rootFlag: string | undefined, agentId: string): string {
  const root = rootFlag ?? join(homedir(), ".openclaw", "workspace");
  return join(root, ".cache", "osm", `summarize-watch-${agentId}.json`);
}

function loadState(path: string): StateFile {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as StateFile;
  } catch {
    return {};
  }
}

function saveState(path: string, state: StateFile): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(state, null, 2) + "\n", "utf8");
}

function shouldIgnore(file: string): boolean {
  if (!file.endsWith(".jsonl")) return true;
  if (file === "sessions.json") return true;
  if (file.includes(".checkpoint.")) return true;
  if (file.endsWith(".trajectory.jsonl")) return true;
  if (file.includes(":active-memory:")) return true;
  if (file.startsWith("active-memory-")) return true;
  return false;
}

function loadDotEnvIfPresent(rootFlag: string | undefined): void {
  const base = rootFlag ?? join(homedir(), ".openclaw", "workspace");
  const candidates = [join(base, ".env"), join(base, "openclaw-semantic-memory-impl", ".env")];
  const envPath = candidates.find((p) => existsSync(p));
  if (!envPath) return;
  try {
    const raw = readFileSync(envPath, "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq <= 0) continue;
      const key = trimmed.slice(0, eq).trim();
      const value = trimmed.slice(eq + 1).trim();
      if (!(key in process.env)) process.env[key] = value;
    }

    if (!process.env["OSM_EMBED_API_KEY"] && process.env["OSM_OPENAI_API_KEY"]) {
      process.env["OSM_EMBED_API_KEY"] = process.env["OSM_OPENAI_API_KEY"];
    }
    if (!process.env["OPENAI_API_KEY"] && process.env["OSM_OPENAI_API_KEY"]) {
      process.env["OPENAI_API_KEY"] = process.env["OSM_OPENAI_API_KEY"];
    }
    if (!process.env["OSM_EMBED_BASE_URL"] && process.env["OSM_OPENAI_BASE_URL"]) {
      process.env["OSM_EMBED_BASE_URL"] = process.env["OSM_OPENAI_BASE_URL"];
    }
    if (!process.env["OPENAI_BASE_URL"] && process.env["OSM_OPENAI_BASE_URL"]) {
      process.env["OPENAI_BASE_URL"] = process.env["OSM_OPENAI_BASE_URL"];
    }
  } catch {
    // ignore dotenv load failures; normal env still works
  }
}

async function summarizeOne(args: {
  rootFlag: string | undefined;
  agentId: string;
  sessionFile: string;
  ttlDays?: number;
  modelOverride?: string;
}): Promise<number> {
  return await runSummarize({
    rootFlag: args.rootFlag,
    sessionFile: args.sessionFile,
    agentId: args.agentId,
    ttlDays: args.ttlDays,
    modelOverride: args.modelOverride,
    providerOverride: undefined,
    promptOnly: false,
    ingestFile: undefined,
    json: false,
    sessionId: undefined,
    start: undefined,
    end: undefined,
  });
}

export async function runSummarizeWatch(args: SummarizeWatchArgs): Promise<number> {
  const agentId = args.agentId ?? "main";
  const sessionsDir = getSessionsDir(agentId);
  const statePath = getStatePath(args.rootFlag, agentId);
  const idleMs = args.idleMs ?? 10 * 60 * 1000;
  const settleMs = args.settleMs ?? 20 * 1000;
  const coldStartMaxAgeMs = args.coldStartMaxAgeMs ?? 2 * 60 * 60 * 1000;

  loadDotEnvIfPresent(args.rootFlag);

  if (!existsSync(sessionsDir)) {
    console.error(`osm summarize-watch: sessions dir not found: ${sessionsDir}`);
    return 66;
  }

  const state = loadState(statePath);
  const timers = new Map<string, NodeJS.Timeout>();
  const running = new Set<string>();
  const queueRunning = new Set<string>();

  const schedule = (filename: string): void => {
    if (shouldIgnore(filename)) return;
    const sessionFile = join(sessionsDir, filename);
    let st;
    try {
      st = statSync(sessionFile);
    } catch {
      return;
    }
    if (!st.isFile()) return;

    const prev = timers.get(sessionFile);
    if (prev) clearTimeout(prev);

    const t = setTimeout(async () => {
      if (running.has(sessionFile)) return;
      running.add(sessionFile);
      try {
        const stNow = statSync(sessionFile);
        const key = sessionFile;
        const seen = state[key];
        const ageMs = Date.now() - stNow.mtimeMs;

        if (ageMs < idleMs) {
          schedule(filename);
          return;
        }

        if (
          seen &&
          seen.lastMtimeMs === stNow.mtimeMs &&
          seen.lastSize === stNow.size
        ) {
          return;
        }

        console.log(
          `osm summarize-watch: summarizing ${filename} (idle=${Math.round(ageMs / 1000)}s)`
        );
        const code = await summarizeOne({
          rootFlag: args.rootFlag,
          agentId,
          sessionFile,
          ttlDays: args.ttlDays,
          modelOverride: args.modelOverride,
        });
        if (code === 0) {
          state[key] = {
            lastMtimeMs: stNow.mtimeMs,
            lastSize: stNow.size,
            updatedAt: new Date().toISOString(),
          };
          saveState(statePath, state);
        } else {
          console.error(`osm summarize-watch: summarize failed (${code}) for ${filename}`);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.stack ?? err.message : String(err);
        console.error(`osm summarize-watch: ${msg}`);
      } finally {
        running.delete(sessionFile);
      }
    }, settleMs);

    timers.set(sessionFile, t);
  };

  const flushQueue = async (): Promise<void> => {
    const queue = loadSummarizeQueue(args.rootFlag);
    const nowMs = Date.now();
    let touched = false;

    for (const [key, entry] of Object.entries(queue)) {
      const e = entry as SummarizeQueueEntry;
      if (queueRunning.has(key)) continue;
      if (e.status === "done" || e.status === "error") continue;
      if (e.nextRunAt && Date.parse(e.nextRunAt) > nowMs) continue;
      if (!e.sessionId) continue;

      queueRunning.add(key);
      touched = true;
      e.status = "running";
      e.lastRunAt = new Date().toISOString();
      saveSummarizeQueue(args.rootFlag, queue);

      try {
        const sessionFile = join(getSessionsDir(e.agentId ?? agentId), `${e.sessionId}.jsonl`);
        const code = await summarizeOne({
          rootFlag: args.rootFlag,
          agentId: e.agentId ?? agentId,
          sessionFile,
          ttlDays: e.ttlDays,
          modelOverride: e.model,
        });
        if (code === 0) {
          e.status = "done";
          e.lastSuccessAt = new Date().toISOString();
          delete e.lastError;
          appendSummarizeQueueMarker(args.rootFlag, "summarize_flush.jsonl", {
            at: new Date().toISOString(),
            sessionId: e.sessionId,
            sessionKey: e.sessionKey,
            agentId: e.agentId,
            status: "done",
          });
        } else {
          e.status = "error";
          e.lastError = `summarize exited with code ${code}`;
          appendSummarizeQueueMarker(args.rootFlag, "summarize_flush.jsonl", {
            at: new Date().toISOString(),
            sessionId: e.sessionId,
            sessionKey: e.sessionKey,
            agentId: e.agentId,
            status: "error",
            error: e.lastError,
          });
        }
      } catch (err) {
        e.status = "error";
        e.lastError = err instanceof Error ? err.stack ?? err.message : String(err);
        appendSummarizeQueueMarker(args.rootFlag, "summarize_flush.jsonl", {
          at: new Date().toISOString(),
          sessionId: e.sessionId,
          sessionKey: e.sessionKey,
          agentId: e.agentId,
          status: "error",
          error: e.lastError,
        });
      } finally {
        queueRunning.delete(key);
        saveSummarizeQueue(args.rootFlag, queue);
      }
    }

    if (touched) saveSummarizeQueue(args.rootFlag, queue);
  };

  console.log(`osm summarize-watch: monitoring ${sessionsDir}`);
  console.log("osm summarize-watch: queue flush enabled");
  console.log(`osm summarize-watch: state file ${statePath}`);
  console.log(
    `osm summarize-watch: idleMs=${idleMs} settleMs=${settleMs} agent=${agentId} coldStartMaxAgeMs=${coldStartMaxAgeMs}`
  );
  console.log("press Ctrl-C to stop.");

  const watcher = fsWatch(sessionsDir, { recursive: false }, (_event, filename) => {
    if (!filename) return;
    schedule(String(filename));
    void flushQueue();
  });

  // Cold-start scan: schedule anything old enough and not yet summarized.
  for (const candidate of Object.keys(state)) {
    void candidate;
  }
  try {
    const { readdirSync } = await import("node:fs");
    for (const name of readdirSync(sessionsDir)) {
      if (shouldIgnore(name)) continue;
      const path = join(sessionsDir, name);
      try {
        const st = statSync(path);
        if (!st.isFile()) continue;
        const ageMs = Date.now() - st.mtimeMs;
        if (ageMs <= coldStartMaxAgeMs) schedule(name);
      } catch {
        // ignore per-file stat errors
      }
    }
    await flushQueue();
  } catch {
    // ignore
  }

  const queueInterval = setInterval(() => {
    void flushQueue();
  }, Math.max(5000, Math.min(idleMs, 30000)));

  return new Promise<number>((resolveExit) => {
    let stopped = false;
    const shutdown = (signal: string): void => {
      if (stopped) return;
      stopped = true;
      console.log(`\nosm summarize-watch: ${signal} received, shutting down.`);
      try {
        watcher.close();
      } catch {
        // ignore
      }
      clearInterval(queueInterval);
      for (const t of timers.values()) clearTimeout(t);
      resolveExit(0);
    };
    process.on("SIGINT", () => shutdown("SIGINT"));
    process.on("SIGTERM", () => shutdown("SIGTERM"));
  });
}
