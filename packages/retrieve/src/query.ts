/**
 * Query normalization for retrieval.
 *
 * Handles:
 *   - whitespace and length sanity
 *   - merging defaults from RetrievalConfig
 *   - exposing a stable shape for the rest of the pipeline
 *
 * We do NOT do any rewriting / expansion / spell-correction here. Those are
 * Phase 3+ if they prove valuable.
 */

import type {
  MemoryStatus,
  MemoryType,
  RetrievalQuery,
  Scope,
  SourceKind,
} from "@osm/core";

export interface NormalizedQuery {
  text: string;
  topK: number;
  topN: number;
  minScore: number;
  /** Defaults to ["active"] in v0.1. */
  onlyStatuses: MemoryStatus[];
  /** undefined means "no filter". */
  onlyScopes: Scope[] | undefined;
  /** undefined means "all kinds". */
  onlySourceKinds: SourceKind[] | undefined;
  /** undefined means "no filter". */
  onlyTypes: MemoryType[] | undefined;
  project: string | undefined;
  channel: string | undefined;
  timeRangeDays: number | undefined;
}

export interface NormalizeOptions {
  defaults: {
    topK: number;
    topN: number;
    minScore: number;
    defaultScope: Scope;
  };
}

export function normalizeQuery(
  q: RetrievalQuery,
  opts: NormalizeOptions
): NormalizedQuery {
  const text = (q.text ?? "").trim();
  if (text.length === 0) {
    throw new Error("osm/retrieve: query text is empty");
  }

  const topK = q.topK ?? opts.defaults.topK;
  const minScore = q.minScore ?? opts.defaults.minScore;

  return {
    text,
    topK,
    topN: opts.defaults.topN,
    minScore,
    onlyStatuses: q.scope?.onlyStatuses ?? ["active"],
    onlyScopes: undefined,
    onlySourceKinds: q.scope?.onlySourceKinds,
    onlyTypes: q.scope?.types,
    project: q.scope?.project,
    channel: q.scope?.channel,
    timeRangeDays: q.scope?.timeRangeDays,
  };
}
