/**
 * `@osm/retrieve` — public API.
 *
 * One class: `Retriever`. Given a store + provider + config, it runs the
 * full retrieval pipeline:
 *
 *   normalize -> embed -> hybrid -> guardrails -> assemble -> audit.
 */

import type {
  AuditKind,
  Memory,
  RetrievalQuery,
  RetrievalResponse,
  RetrievalResult,
  WhyMatched,
} from "@osm/core";
import type { EmbeddingProvider } from "@osm/embed";
import type { OsmStore } from "@osm/store";

import {
  applyGuardrails,
  type CandidateBundle,
} from "./guardrails.js";
import { hybridSearch, type HybridHit } from "./hybrid.js";
import {
  ephemeralHybridSearch,
  ephemeralToResult,
  type EphemeralHit,
} from "./ephemeral.js";
import { normalizeQuery, type NormalizedQuery } from "./query.js";
import { buildWhyMatched } from "./why.js";

export type { NormalizedQuery } from "./query.js";
export { hybridSearch } from "./hybrid.js";
export type { HybridHit } from "./hybrid.js";
export { ephemeralHybridSearch, ephemeralToResult } from "./ephemeral.js";
export type { EphemeralHit } from "./ephemeral.js";
export { applyGuardrails } from "./guardrails.js";
export type { CandidateBundle, GuardrailResult } from "./guardrails.js";
export { buildWhyMatched } from "./why.js";

export interface RetrieverOptions {
  store: OsmStore;
  provider: EmbeddingProvider;
  defaults: {
    topK: number;
    topN: number;
    minScore: number;
    defaultScope: "global" | "project" | "channel" | "private";
  };
  /**
   * Phase-2 ephemeral retrieval settings. Omit to disable ephemeral search.
   */
  ephemeral?: {
    enabled: boolean;
    /** Retrieval weight relative to persistent (1.0). Recommended 0.85. */
    weight: number;
    /** Minimum confidence to surface. Default 0.5. */
    minConfidence: number;
  };
}

export interface RetrieveDebug {
  candidates: number;
  rejected: Array<{ chunkId: string; reason: string }>;
  topNSemantic: number;
  topNLexical: number;
  ephemeralCandidates?: number;
  ephemeralAccepted?: number;
}

export class Retriever {
  constructor(private readonly opts: RetrieverOptions) {}

  async retrieve(
    q: RetrievalQuery,
    options?: { debug?: boolean; auditKind?: AuditKind }
  ): Promise<RetrievalResponse & { debug?: RetrieveDebug }> {
    const normalized = normalizeQuery(q, { defaults: this.opts.defaults });
    const now = new Date();

    const hits = await hybridSearch(this.opts.store, this.opts.provider, normalized.text, {
      topN: normalized.topN,
    });

    const candidates: CandidateBundle[] = [];
    const candidateHits: HybridHit[] = [];
    const rejected: Array<{ chunkId: string; reason: string }> = [];

    for (const hit of hits) {
      const chunk = this.opts.store.getChunkById(hit.chunkId);
      if (!chunk) {
        rejected.push({ chunkId: hit.chunkId, reason: "missing_chunk_row" });
        continue;
      }
      const memory = this.opts.store.getMemoryById(chunk.memory_id);
      if (!memory) {
        rejected.push({ chunkId: hit.chunkId, reason: "missing_memory_row" });
        continue;
      }
      const bundle: CandidateBundle = {
        memory,
        chunkText: chunk.text,
        chunkSourcePath: chunk.source_path,
        chunkLineStart: chunk.line_start ?? undefined,
        chunkLineEnd: chunk.line_end ?? undefined,
        score: hit.score,
      };
      const guard = applyGuardrails(normalized, bundle, now);
      if (!guard.kept) {
        rejected.push({ chunkId: hit.chunkId, reason: guard.reason ?? "guarded" });
        continue;
      }
      candidates.push(bundle);
      candidateHits.push(hit);
    }

    // De-dupe by memoryId — one chunk per memory in the final top-K, taking
    // the highest-scoring chunk for each memory.
    const bestByMemory = new Map<string, { c: CandidateBundle; h: HybridHit }>();
    for (let i = 0; i < candidates.length; i += 1) {
      const c = candidates[i]!;
      const h = candidateHits[i]!;
      const prev = bestByMemory.get(c.memory.memoryId);
      if (!prev || prev.c.score < c.score) {
        bestByMemory.set(c.memory.memoryId, { c, h });
      }
    }

    const ranked = [...bestByMemory.values()]
      .sort((a, b) => b.c.score - a.c.score)
      .slice(0, normalized.topK);

    const queryLower = normalized.text.toLowerCase();
    const persistentResults: RetrievalResult[] = ranked.map(({ c, h }) =>
      assembleResult(c, h, queryLower, now)
    );

    // Phase-2: ephemeral fan-out
    let ephemeralResults: RetrievalResult[] = [];
    let ephemeralCandidates = 0;
    let ephemeralAccepted = 0;
    if (this.opts.ephemeral?.enabled) {
      const eHits: EphemeralHit[] = await ephemeralHybridSearch(
        this.opts.store,
        this.opts.provider,
        normalized.text,
        {
          topN: normalized.topN,
          minConfidence: this.opts.ephemeral.minConfidence,
          nowIso: now.toISOString(),
        }
      );
      ephemeralCandidates = eHits.length;
      ephemeralResults = eHits.map((h) =>
        ephemeralToResult(h, this.opts.ephemeral!.weight, now)
      );
      ephemeralAccepted = ephemeralResults.length;
    }

    // Merge persistent + ephemeral and re-sort by score.
    const merged: RetrievalResult[] = [...persistentResults, ...ephemeralResults]
      .sort((a, b) => b.score - a.score)
      .slice(0, normalized.topK);

    const response: RetrievalResponse & { debug?: RetrieveDebug } = {
      query: normalized.text,
      results: merged,
    };

    if (options?.debug) {
      response.debug = {
        candidates: candidates.length,
        rejected,
        topNSemantic: hits.filter((h) => h.semanticRank !== undefined).length,
        topNLexical: hits.filter((h) => h.lexicalRank !== undefined).length,
        ephemeralCandidates,
        ephemeralAccepted,
      };
    }

    if (this.opts.store) {
      this.opts.store.appendAudit(options?.auditKind ?? "retrieve", {
        query: normalized.text,
        topK: normalized.topK,
        topN: normalized.topN,
        results: merged.map((r) => ({
          memoryId: r.memoryId,
          score: r.score,
          whyMatched: r.whyMatched,
        })),
        rejectedCount: rejected.length,
        ephemeralEnabled: this.opts.ephemeral?.enabled ?? false,
        ephemeralCandidates,
        ephemeralAccepted,
      });
    }

    return response;
  }
}

function assembleResult(
  c: CandidateBundle,
  h: HybridHit,
  queryLower: string,
  now: Date
): RetrievalResult {
  const why: WhyMatched[] = buildWhyMatched({
    memory: c.memory,
    chunkText: c.chunkText,
    hit: h,
    now,
    queryLower,
  });

  const summary = pickSummary(c.memory, c.chunkText);
  const citation = formatCitation(c);

  return {
    memoryId: c.memory.memoryId,
    memoryType: c.memory.memoryType,
    summary,
    citation,
    score: round4(c.score),
    whyMatched: why,
    confidence: c.memory.confidence,
  };
}

function pickSummary(m: Memory, chunkText: string): string {
  if ("summary" in m && typeof m.summary === "string" && m.summary.trim().length > 0) {
    return m.summary;
  }
  if ("title" in m && typeof m.title === "string" && m.title.trim().length > 0) {
    return m.title;
  }
  return chunkText.slice(0, 200).replace(/\s+/g, " ").trim();
}

function formatCitation(c: CandidateBundle): string {
  if (c.chunkLineStart !== undefined && c.chunkLineEnd !== undefined) {
    return `${c.chunkSourcePath}#L${c.chunkLineStart}-L${c.chunkLineEnd}`;
  }
  return c.chunkSourcePath;
}

function round4(x: number): number {
  return Math.round(x * 10000) / 10000;
}
