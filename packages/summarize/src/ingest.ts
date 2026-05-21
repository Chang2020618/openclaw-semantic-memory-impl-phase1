/**
 * High-level orchestrator: take a session jsonl, run the full pipeline:
 *   transcript → LLM → summaries → embed → ephemeral store.
 *
 * Pure function over its dependencies; the CLI provides the LLM and embed
 * providers so the same pipeline can be driven by a different host.
 */

import { createHash } from "node:crypto";

import type {
  EphemeralChunk,
  EphemeralMemory,
  Scope,
} from "@osm/core";
import type { EmbeddingProvider } from "@osm/embed";
import type { OsmStore } from "@osm/store";

import {
  buildSummarizerUserPrompt,
  parseSummaries,
  SUMMARIZER_SYSTEM_PROMPT,
  type SummaryCandidate,
} from "./prompt.js";
import {
  loadSessionTranscript,
  type NormalizedTranscript,
  type TranscriptOptions,
} from "./transcript.js";

export interface IngestOptions {
  sessionFile: string;
  store: OsmStore;
  embedding: EmbeddingProvider;
  /**
   * Async function that takes a system prompt + user prompt and returns
   * the LLM response text. Lets the caller swap chatComplete (direct)
   * with a custom routing (e.g. OpenClaw sub-agent).
   */
  llm: (args: {
    systemPrompt: string;
    userPrompt: string;
  }) => Promise<{ text: string; usage?: { totalTokens?: number } }>;
  ttlDays?: number;
  scope?: Scope;
  transcript?: TranscriptOptions;
}

export interface IngestReport {
  sessionId: string;
  transcript: {
    turnCount: number;
    trimmed: boolean;
    charCount: number;
    startTs: string;
    endTs: string;
  };
  summariesProposed: number;
  summariesAccepted: number;
  embeddingsRequested: number;
  llmTokensUsed?: number;
  durationMs: number;
  /** memoryIds written. */
  ingestedIds: string[];
}

const DEFAULT_TTL_DAYS = 90;

export async function ingestSession(
  opts: IngestOptions
): Promise<IngestReport> {
  const t0 = Date.now();

  const transcript = loadSessionTranscript(opts.sessionFile, opts.transcript);
  if (transcript.turns.length === 0) {
    return {
      sessionId: transcript.sessionId,
      transcript: {
        turnCount: 0,
        trimmed: false,
        charCount: 0,
        startTs: "",
        endTs: "",
      },
      summariesProposed: 0,
      summariesAccepted: 0,
      embeddingsRequested: 0,
      durationMs: Date.now() - t0,
      ingestedIds: [],
    };
  }

  const userPrompt = buildSummarizerUserPrompt(transcript.text);
  const llmResp = await opts.llm({
    systemPrompt: SUMMARIZER_SYSTEM_PROMPT,
    userPrompt,
  });

  const candidates = parseSummaries(llmResp.text);

  const ingestedIds = await persistCandidates({
    candidates,
    transcript,
    store: opts.store,
    embedding: opts.embedding,
    ttlDays: opts.ttlDays ?? DEFAULT_TTL_DAYS,
    scope: opts.scope ?? "global",
  });

  // Audit
  opts.store.appendAudit("summarize", {
    sessionId: transcript.sessionId,
    sessionFile: opts.sessionFile,
    turnCount: transcript.turns.length,
    trimmed: transcript.trimmed,
    summariesProposed: candidates.length,
    summariesAccepted: ingestedIds.length,
    llmTokensUsed: llmResp.usage?.totalTokens,
    embeddingModelId: opts.embedding.id,
  });

  return {
    sessionId: transcript.sessionId,
    transcript: {
      turnCount: transcript.turns.length,
      trimmed: transcript.trimmed,
      charCount: transcript.text.length,
      startTs: transcript.startTs,
      endTs: transcript.endTs,
    },
    summariesProposed: candidates.length,
    summariesAccepted: ingestedIds.length,
    embeddingsRequested: ingestedIds.length,
    ...(llmResp.usage?.totalTokens !== undefined && {
      llmTokensUsed: llmResp.usage.totalTokens,
    }),
    durationMs: Date.now() - t0,
    ingestedIds,
  };
}

async function persistCandidates(args: {
  candidates: SummaryCandidate[];
  transcript: NormalizedTranscript;
  store: OsmStore;
  embedding: EmbeddingProvider;
  ttlDays: number;
  scope: Scope;
}): Promise<string[]> {
  if (args.candidates.length === 0) return [];

  const texts = args.candidates.map((c) => c.summary);
  const vectors = await args.embedding.embed(texts);

  const ingestedIds: string[] = [];
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const expiresIso = new Date(
    nowMs + args.ttlDays * 24 * 60 * 60 * 1000
  ).toISOString();

  for (let i = 0; i < args.candidates.length; i += 1) {
    const c = args.candidates[i]!;
    const vector = vectors[i]!;

    const contentBasis = JSON.stringify({
      sessionId: args.transcript.sessionId,
      type: c.type,
      summary: c.summary,
      timeStart: c.timeStart,
      timeEnd: c.timeEnd,
    });
    const hash = sha256Hex(contentBasis);
    const memoryId = `eph_${hash.slice(0, 24)}`;
    const chunkId = `eph_chk_${hash.slice(0, 24)}`;

    const citation = `session://${args.transcript.sessionId}#range=${encodeURIComponent(
      c.timeStart || args.transcript.startTs
    )}-${encodeURIComponent(c.timeEnd || args.transcript.endTs)}`;

    const memory: EphemeralMemory = {
      schemaVersion: 1,
      memoryId,
      sessionId: args.transcript.sessionId,
      memoryType: c.type,
      summary: c.summary,
      importance: c.importance,
      confidence: c.confidence,
      citation,
      ...(c.rawExcerpt && { rawExcerpt: c.rawExcerpt }),
      scope: args.scope,
      status: "active",
      createdAt: nowIso,
      expiresAt: expiresIso,
      hash,
      sourceKind: "assistant_inferred",
    };

    const chunk: EphemeralChunk = {
      chunkId,
      memoryId,
      text: c.summary,
      embeddingModelId: args.embedding.id,
      hash,
      expiresAt: expiresIso,
    };

    args.store.upsertEphemeral(memory, chunk, vector);
    ingestedIds.push(memoryId);
  }
  return ingestedIds;
}

function sha256Hex(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}
