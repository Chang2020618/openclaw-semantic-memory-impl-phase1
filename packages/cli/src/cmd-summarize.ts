/**
 * `osm summarize --session <id>` — Phase-2.
 *
 * Pipeline:
 *   1. resolve OpenClaw session jsonl path
 *   2. normalize transcript
 *   3. spawn LLM (currently OpenAI-compatible HTTP; OpenClaw-spawn variant
 *      lives behind --via-openclaw, future)
 *   4. parse structured summaries
 *   5. embed + persist to ephemeral_*
 */

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { makeEmbeddingProvider } from "@osm/embed";
import { OsmStore } from "@osm/store";
import {
  chatComplete,
  ingestSession,
  loadSessionTranscript,
  parseSummaries,
  SUMMARIZER_SYSTEM_PROMPT,
  buildSummarizerUserPrompt,
} from "@osm/summarize";

import {
  ensureMemoryRoot,
  loadOrInitConfig,
  resolveWorkspace,
} from "./workspace.js";
import { addTrackedApprovalRequest, appendTaskEvent, completeTrackedTask, createTrackedTask, failTrackedTask } from "./task-runtime.js";

export interface SummarizeArgs {
  rootFlag: string | undefined;
  sessionId?: string;
  sessionFile?: string;
  agentId?: string;
  start?: string;
  end?: string;
  ttlDays?: number;
  modelOverride?: string;
  providerOverride?: string;
  promptOnly: boolean;
  ingestFile?: string;
  json: boolean;
}

export interface SummarizeQueueEntry {
  sessionId?: string;
  sessionKey?: string;
  agentId: string;
  queuedAt: string;
  updatedAt: string;
  nextRunAt: string;
  durationMs?: number;
  ttlDays?: number;
  model?: string;
  settleMs?: number;
  idleMs?: number;
  status: "queued" | "running" | "done" | "error";
  lastError?: string;
  lastRunAt?: string;
  lastSuccessAt?: string;
}

export type SummarizeQueueFile = Record<string, SummarizeQueueEntry>;

export async function runSummarize(args: SummarizeArgs): Promise<number> {
  const paths = resolveWorkspace(args.rootFlag);
  ensureMemoryRoot(paths);
  const config = loadOrInitConfig(paths);

  const sessionFile = resolveSessionFile(args);
  if (!sessionFile) {
    console.error(
      "osm summarize: must pass --session <id> or --session-file <path>"
    );
    return 64;
  }
  if (!existsSync(sessionFile)) {
    console.error(`osm summarize: session file not found: ${sessionFile}`);
    return 66;
  }

  // --prompt-only: just emit the rendered prompt to stdout and exit (offline use)
  if (args.promptOnly) {
    const transcript = loadSessionTranscript(sessionFile, {
      ...(args.start && { start: args.start }),
      ...(args.end && { end: args.end }),
    });
    const userPrompt = buildSummarizerUserPrompt(transcript.text);
    if (args.json) {
      console.log(
        JSON.stringify(
          {
            sessionFile,
            sessionId: transcript.sessionId,
            turnCount: transcript.turns.length,
            trimmed: transcript.trimmed,
            charCount: transcript.text.length,
            systemPrompt: SUMMARIZER_SYSTEM_PROMPT,
            userPrompt,
          },
          null,
          2
        )
      );
    } else {
      console.log("=== SYSTEM ===");
      console.log(SUMMARIZER_SYSTEM_PROMPT);
      console.log("\n=== USER ===");
      console.log(userPrompt);
    }
    return 0;
  }

  const providerId = args.providerOverride ?? config.embedding.providerId;
  const provider = makeEmbeddingProvider({
    providerId,
    modelId: config.embedding.modelId,
    dim: config.embedding.dim,
  });

  const store = new OsmStore({
    dbPath: paths.dbPath,
    embedding: {
      providerId,
      modelId: config.embedding.modelId,
      dim: config.embedding.dim,
    },
  });
  const task = createTrackedTask(store, {
    kind: "manual",
    title: "osm summarize",
    goal: `Summarize session transcript into ephemeral memories: ${sessionFile}`,
    sessionKey: args.sessionId,
    ownerType: "system",
    ownerId: "osm.summarize",
  });

  try {
    // --ingest-file: skip the LLM call; parse a JSON file the human/another
    // process produced.
    if (args.ingestFile) {
      const { readFileSync } = await import("node:fs");
      const raw = readFileSync(args.ingestFile, "utf8");
      const candidates = parseSummaries(raw);

      const transcript = loadSessionTranscript(sessionFile, {
        ...(args.start && { start: args.start }),
        ...(args.end && { end: args.end }),
      });

      const report = await ingestSession({
        sessionFile,
        store,
        embedding: provider,
        ttlDays: args.ttlDays ?? config.ephemeral?.ttlDays ?? 90,
        transcript: {
          ...(args.start && { start: args.start }),
          ...(args.end && { end: args.end }),
        },
        // Bypass the LLM by feeding the candidates back through the prompt.
        // Simpler than adding a second code path: re-stringify and let the
        // parser run again so validation rules are uniform.
        llm: async () => ({ text: JSON.stringify(candidates) }),
      });

      if (args.json) {
        console.log(JSON.stringify(report, null, 2));
      } else {
        printReport(report, transcript.text.length);
      }
      completeTrackedTask(store, task, `accepted=${report.summariesAccepted} embeddings=${report.embeddingsRequested}`);
      return 0;
    }

    const model =
      args.modelOverride ?? config.ephemeral?.summarizerModel ?? "jeniya/gpt-5.4-mini";

    addTrackedApprovalRequest(store, task, {
      sessionKey: args.sessionId,
      actionType: "external_send",
      target: `llm:${model}`,
      reason: "Summarize session transcript with external LLM call",
      riskLevel: "medium",
      status: "approved",
      decidedBy: "system",
      decidedAt: new Date().toISOString(),
    });
    appendTaskEvent(store, {
      id: randomUUID(),
      taskId: task.taskId,
      taskRunId: task.runId,
      sessionKey: args.sessionId,
      type: "summarize.llm.requested",
      summary: `Calling summarizer model ${model}`,
      ts: new Date().toISOString(),
    });

    const report = await ingestSession({
      sessionFile,
      store,
      embedding: provider,
      ttlDays: args.ttlDays ?? config.ephemeral?.ttlDays ?? 90,
      transcript: {
        ...(args.start && { start: args.start }),
        ...(args.end && { end: args.end }),
      },
      llm: async ({ systemPrompt, userPrompt }) => {
        const resp = await chatComplete({
          model,
          systemPrompt,
          userPrompt,
        });
        return {
          text: resp.text,
          ...(resp.usage?.totalTokens !== undefined && {
            usage: { totalTokens: resp.usage.totalTokens },
          }),
        };
      },
    });

    if (args.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      printReport(report);
    }
    appendTaskEvent(store, {
      id: randomUUID(),
      taskId: task.taskId,
      taskRunId: task.runId,
      sessionKey: report.sessionId,
      type: "summarize.ingest.completed",
      summary: `accepted=${report.summariesAccepted} embeddings=${report.embeddingsRequested}`,
      payloadJson: JSON.stringify(report),
      ts: new Date().toISOString(),
    });
    completeTrackedTask(store, task, `accepted=${report.summariesAccepted} embeddings=${report.embeddingsRequested}`);
    return report.summariesAccepted > 0 ? 0 : 0;
  } catch (err) {
    failTrackedTask(store, task, err);
    throw err;
  } finally {
    store.close();
  }
}

function resolveSessionFile(args: SummarizeArgs): string | null {
  if (args.sessionFile) return args.sessionFile;
  if (!args.sessionId) return null;
  const agent = args.agentId ?? "main";
  const file = join(
    homedir(),
    ".openclaw",
    "agents",
    agent,
    "sessions",
    `${args.sessionId}.jsonl`
  );
  return file;
}

export function getSummarizeQueuePath(rootFlag: string | undefined): string {
  const root = rootFlag ?? join(homedir(), ".openclaw", "workspace");
  return join(root, ".cache", "osm", "plugin-markers", "summarize-queue.json");
}

export function loadSummarizeQueue(rootFlag: string | undefined): SummarizeQueueFile {
  return loadJsonFile(getSummarizeQueuePath(rootFlag), {});
}

export function saveSummarizeQueue(rootFlag: string | undefined, queue: SummarizeQueueFile): void {
  writeJsonFile(getSummarizeQueuePath(rootFlag), queue);
}

export function appendSummarizeQueueMarker(
  rootFlag: string | undefined,
  name: string,
  payload: Record<string, unknown>
): void {
  const root = rootFlag ?? join(homedir(), ".openclaw", "workspace");
  const path = join(root, ".cache", "osm", "plugin-markers", name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${existsSync(path) ? readFileSync(path, 'utf8') : ''}${JSON.stringify(payload)}\n`, 'utf8');
}

function loadJsonFile<T>(path: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return fallback;
  }
}

function writeJsonFile(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n", "utf8");
}

function printReport(
  report: Awaited<ReturnType<typeof ingestSession>>,
  totalCharsHint?: number
): void {
  const lines: string[] = [];
  lines.push(`osm summarize: session ${report.sessionId}`);
  lines.push(`  turns      = ${report.transcript.turnCount}`);
  lines.push(
    `  chars      = ${report.transcript.charCount}${
      totalCharsHint !== undefined ? ` (rendered)` : ""
    }${report.transcript.trimmed ? "  [trimmed]" : ""}`
  );
  lines.push(
    `  span       = ${report.transcript.startTs} → ${report.transcript.endTs}`
  );
  lines.push(`  proposed   = ${report.summariesProposed}`);
  lines.push(`  accepted   = ${report.summariesAccepted}`);
  lines.push(`  embeddings = ${report.embeddingsRequested}`);
  if (report.llmTokensUsed !== undefined) {
    lines.push(`  llm tokens = ${report.llmTokensUsed}`);
  }
  lines.push(`  duration   = ${report.durationMs}ms`);
  if (report.ingestedIds.length > 0) {
    lines.push(`  ids:`);
    for (const id of report.ingestedIds) lines.push(`    - ${id}`);
  }
  console.log(lines.join("\n"));
}

// touch unused imports to keep tsc happy when --noUnusedLocals enabled
void statSync;
