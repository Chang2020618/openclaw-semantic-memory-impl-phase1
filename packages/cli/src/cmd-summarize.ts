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

import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

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
      return 0;
    }

    const model =
      args.modelOverride ?? config.ephemeral?.summarizerModel ?? "jeniya/gpt-5.4";

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
    return report.summariesAccepted > 0 ? 0 : 0;
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
