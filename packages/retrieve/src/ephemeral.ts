/**
 * Phase-2 ephemeral retrieval: fan out vector + lexical search against the
 * `ephemeral_chunks` tables, RRF-fuse, and emit RetrievalResult shape with
 * an extra `source_layer: 'ephemeral'` marker baked into whyMatched.
 *
 * This module is intentionally separate from `hybrid.ts` so the persistent
 * pipeline stays unchanged. The composing caller (Retriever) merges them.
 */

import type {
  EphemeralMemory,
  RetrievalResult,
  WhyMatched,
} from "@osm/core";
import type { EmbeddingProvider } from "@osm/embed";
import type { OsmStore } from "@osm/store";

import type { HybridHit } from "./hybrid.js";

export interface EphemeralHit extends HybridHit {
  memory: EphemeralMemory;
  text: string;
}

export interface EphemeralSearchOptions {
  topN: number;
  rrfK?: number;
  /** Drop hits whose memory.confidence < this. Default 0.5. */
  minConfidence?: number;
  /** Now timestamp (ISO) for expiry filtering. Defaults to Date.now(). */
  nowIso?: string;
}

export async function ephemeralHybridSearch(
  store: OsmStore,
  provider: EmbeddingProvider,
  queryText: string,
  opts: EphemeralSearchOptions
): Promise<EphemeralHit[]> {
  const k = opts.rrfK ?? 60;
  const minConf = opts.minConfidence ?? 0.5;
  const nowIso = opts.nowIso ?? new Date().toISOString();

  const [queryVec] = await provider.embed([queryText]);
  if (!queryVec) {
    throw new Error("osm/retrieve: embedding failed for ephemeral query");
  }

  const semantic = store.ephemeralVectorSearch(queryVec, opts.topN);
  const lexical = store.ephemeralLexicalSearch(queryText, opts.topN);

  const merged = new Map<string, HybridHit>();

  semantic.forEach((hit, i) => {
    const rank = i + 1;
    const contribution = 1 / (k + rank);
    merged.set(hit.chunkId, {
      chunkId: hit.chunkId,
      score: contribution,
      semanticRank: rank,
      lexicalRank: undefined,
      semanticDistance: hit.distance,
      lexicalRaw: undefined,
    });
  });

  lexical.forEach((hit, i) => {
    const rank = i + 1;
    const contribution = 1 / (k + rank);
    const existing = merged.get(hit.chunkId);
    if (existing) {
      existing.score += contribution;
      existing.lexicalRank = rank;
      existing.lexicalRaw = hit.rank;
    } else {
      merged.set(hit.chunkId, {
        chunkId: hit.chunkId,
        score: contribution,
        semanticRank: undefined,
        lexicalRank: rank,
        semanticDistance: undefined,
        lexicalRaw: hit.rank,
      });
    }
  });

  const out: EphemeralHit[] = [];
  for (const hit of merged.values()) {
    const chunkRow = store.ephemeralChunkById(hit.chunkId);
    if (!chunkRow) continue;
    if (chunkRow.expires_at < nowIso) continue;

    const memory = store.getEphemeralById(chunkRow.memory_id);
    if (!memory) continue;
    if (memory.status !== "active") continue;
    if (memory.confidence < minConf) continue;
    if (memory.expiresAt < nowIso) continue;

    out.push({ ...hit, memory, text: chunkRow.text });
  }

  return out.sort((a, b) => b.score - a.score);
}

/**
 * Convert an ephemeral hit into a RetrievalResult, applying source-layer
 * weight downscaling and confidence multiplication.
 *
 *   final_score = rrf_score * sourceWeight * confidence
 */
export function ephemeralToResult(
  hit: EphemeralHit,
  sourceWeight: number,
  now: Date
): RetrievalResult {
  const why: WhyMatched[] = [];
  if (hit.semanticRank !== undefined) why.push("semantic_similarity");
  if (hit.lexicalRank !== undefined) why.push("lexical_match");

  // recent_within_30d flag based on createdAt
  try {
    const created = new Date(hit.memory.createdAt).getTime();
    if (now.getTime() - created < 30 * 24 * 60 * 60 * 1000) {
      why.push("recent_within_30d");
    }
  } catch {
    // ignore
  }

  // Phase-2 markers — we re-use the WhyMatched union by encoding as a
  // lexical_match:<tag> style synthetic entry until Phase-2 adds first-class
  // entries to the type.
  why.push("lexical_match:session_summary" as WhyMatched);
  why.push(`lexical_match:layer=ephemeral` as WhyMatched);

  const score = hit.score * sourceWeight * hit.memory.confidence;

  return {
    memoryId: hit.memory.memoryId,
    memoryType: hit.memory.memoryType as RetrievalResult["memoryType"],
    summary: hit.memory.summary,
    citation: hit.memory.citation,
    score: round4(score),
    whyMatched: why,
    confidence: hit.memory.confidence,
  };
}

function round4(x: number): number {
  return Math.round(x * 10000) / 10000;
}
