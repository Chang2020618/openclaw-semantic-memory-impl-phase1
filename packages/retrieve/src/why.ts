/**
 * `whyMatched` tagging.
 *
 * Each retrieval result must carry an honest, machine-readable list of why
 * we returned it. Used for explainability, audit logs, and eventually for
 * weight calibration in Phase 2.
 *
 * Tag set is locked by `core` types (WhyMatched).
 */

import type { Memory, WhyMatched } from "@osm/core";

import type { HybridHit } from "./hybrid.js";

export interface WhyMatchedInputs {
  memory: Memory;
  chunkText: string;
  hit: HybridHit;
  /** Current time, used for recency tagging. */
  now: Date;
  /** Lowercased query text, used for lexical-context tags. */
  queryLower: string;
}

export function buildWhyMatched(input: WhyMatchedInputs): WhyMatched[] {
  const out: WhyMatched[] = [];

  if (input.hit.semanticRank !== undefined) {
    out.push("semantic_similarity");
  }
  if (input.hit.lexicalRank !== undefined) {
    out.push("lexical_match");
    // Add an entity-flavored lexical tag if the query overlaps a meaningful
    // token in the chunk text. This is intentionally simple in Phase 1.
    const token = pickLexicalToken(input.queryLower, input.chunkText);
    if (token) out.push(`lexical_match:${token}`);
  }

  // Recency bonus tag.
  const ts = Date.parse(input.memory.timestamp);
  if (Number.isFinite(ts)) {
    const ageDays = (input.now.getTime() - ts) / 86400000;
    if (ageDays >= 0 && ageDays <= 30) out.push("recent_within_30d");
  }

  if (input.memory.importance >= 0.7) {
    out.push("high_importance");
  }

  if (input.memory.provenance.sourceKind === "human_confirmed") {
    out.push("human_confirmed");
  }

  if (input.memory.project) {
    out.push(`project_match:${input.memory.project}`);
  }

  return out;
}

/**
 * Pick one short token from the query that also appears in the chunk text,
 * to enrich the lexical_match tag. Returns undefined if nothing meaningful
 * lines up.
 */
function pickLexicalToken(queryLower: string, chunkText: string): string | undefined {
  const chunkLower = chunkText.toLowerCase();
  const tokens = queryLower
    .split(/[\s,.;:!?()'"`，。；：！？（）]+/u)
    .filter((t) => t.length >= 2);
  for (const tok of tokens) {
    if (chunkLower.includes(tok)) return tok;
  }
  return undefined;
}
