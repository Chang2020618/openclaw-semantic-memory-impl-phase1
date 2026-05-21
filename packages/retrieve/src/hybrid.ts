/**
 * Hybrid retrieval: semantic (vector) + lexical (BM25/FTS5), fused by RRF.
 *
 * Phase-1 fusion is RRF (Reciprocal Rank Fusion) only. Weighted scoring is
 * deferred to Phase 2 once we have real calibration data.
 *
 * The pipeline:
 *   1. embed query
 *   2. semantic top-N from vec0
 *   3. lexical top-N from FTS5
 *   4. RRF merge (k=60)
 *   5. caller layer adds guardrails + whyMatched
 */

import type { OsmStore } from "@osm/store";
import type { EmbeddingProvider } from "@osm/embed";

export interface HybridHit {
  chunkId: string;
  score: number;
  /** Rank in the semantic list (1-based) or undefined if not present. */
  semanticRank: number | undefined;
  /** Rank in the lexical list (1-based) or undefined if not present. */
  lexicalRank: number | undefined;
  /** Raw vector distance (lower is better) when available. */
  semanticDistance: number | undefined;
  /** Raw FTS5 bm25 rank (lower is better) when available. */
  lexicalRaw: number | undefined;
}

export interface HybridSearchOptions {
  topN: number;
  rrfK?: number;
}

export async function hybridSearch(
  store: OsmStore,
  provider: EmbeddingProvider,
  queryText: string,
  opts: HybridSearchOptions
): Promise<HybridHit[]> {
  const k = opts.rrfK ?? 60;

  // 1. embed
  const [queryVec] = await provider.embed([queryText]);
  if (!queryVec) {
    throw new Error("osm/retrieve: embedding failed for query");
  }

  // 2 + 3. parallel-ish search (better-sqlite3 is sync, so order doesn't matter)
  const semantic = store.vectorSearch(queryVec, opts.topN);
  const lexical = store.lexicalSearch(queryText, opts.topN);

  const merged = new Map<string, HybridHit>();

  semantic.forEach((hit, i) => {
    const rank = i + 1;
    const contribution = 1 / (k + rank);
    const existing = merged.get(hit.chunkId);
    if (existing) {
      existing.score += contribution;
      existing.semanticRank = rank;
      existing.semanticDistance = hit.distance;
    } else {
      merged.set(hit.chunkId, {
        chunkId: hit.chunkId,
        score: contribution,
        semanticRank: rank,
        lexicalRank: undefined,
        semanticDistance: hit.distance,
        lexicalRaw: undefined,
      });
    }
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

  return [...merged.values()].sort((a, b) => b.score - a.score);
}
