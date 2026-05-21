/**
 * Guardrails for retrieval results.
 *
 * Filters applied to candidate (memory, chunk, hit) tuples before they reach
 * top-K assembly. Hard rules from v0.1 spec:
 *   - status=archived is filtered out by default
 *   - inferred memories with confidence < 0.4 are dropped
 *   - scope/project/channel filters are honored at retrieval time, not just
 *     at injection time
 *   - timeRangeDays bounds episode timestamp
 */

import type { Memory } from "@osm/core";

import type { NormalizedQuery } from "./query.js";

export interface CandidateBundle {
  memory: Memory;
  chunkText: string;
  chunkSourcePath: string;
  chunkLineStart: number | undefined;
  chunkLineEnd: number | undefined;
  /** Pre-fused score from hybrid layer. */
  score: number;
}

export interface GuardrailResult {
  kept: boolean;
  reason?: string;
}

export function applyGuardrails(
  q: NormalizedQuery,
  c: CandidateBundle,
  now: Date
): GuardrailResult {
  const m = c.memory;

  if (!q.onlyStatuses.includes(m.status)) {
    return { kept: false, reason: `status:${m.status}` };
  }

  if (q.onlyTypes && !q.onlyTypes.includes(m.memoryType)) {
    return { kept: false, reason: `type:${m.memoryType}` };
  }

  if (q.onlySourceKinds && !q.onlySourceKinds.includes(m.provenance.sourceKind)) {
    return { kept: false, reason: `sourceKind:${m.provenance.sourceKind}` };
  }

  if (q.project && m.project !== q.project) {
    return { kept: false, reason: `project:${m.project ?? "none"}` };
  }

  if (q.channel && m.channel !== q.channel) {
    return { kept: false, reason: `channel:${m.channel ?? "none"}` };
  }

  // v0.1 hard rule: low-confidence inferred memory is not auto-injected.
  if (m.provenance.sourceKind === "assistant_inferred" && m.confidence < 0.4) {
    return { kept: false, reason: "low_confidence_inferred" };
  }

  if (q.timeRangeDays !== undefined && q.timeRangeDays > 0) {
    const ts = Date.parse(m.timestamp);
    if (!Number.isFinite(ts)) {
      return { kept: false, reason: "bad_timestamp" };
    }
    const ageDays = (now.getTime() - ts) / 86400000;
    if (ageDays > q.timeRangeDays) {
      return { kept: false, reason: `older_than_${q.timeRangeDays}d` };
    }
  }

  // Score floor.
  if (c.score < q.minScore) {
    return { kept: false, reason: `below_min_score:${c.score.toFixed(3)}` };
  }

  return { kept: true };
}
