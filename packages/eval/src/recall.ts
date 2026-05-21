/**
 * Recall-quality metrics.
 *
 * Targets (v0.1 spec section 5):
 *   - Recall@5 ≥ 0.85
 *   - citation accuracy ≥ 0.95
 *   - average injection candidate size ≤ 200 tokens at top-K=5
 */

import type { RetrievalResult } from "@osm/core";

export interface CaseRunResult {
  caseId: string;
  query: string;
  intent: string;
  k: number;
  expectedMemoryIds: string[];
  retrieved: RetrievalResult[];
  /** 1-based rank of the first matching expected memory; undefined if missed. */
  hitRank: number | undefined;
  hit: boolean;
  /** Approximate tokens (chars/4) summed across retrieved summaries+citations. */
  injectionTokens: number;
  /** Did every retrieved citation point to a valid path#L<a>-L<b> form? */
  citationsValid: boolean;
  citationIssues: string[];
}

export interface RecallReport {
  totalCases: number;
  hits: number;
  recallAtK: number;
  mrr: number;
  citationAccuracy: number;
  avgInjectionTokens: number;
  byIntent: Record<
    string,
    {
      n: number;
      hits: number;
      recall: number;
      mrr: number;
    }
  >;
  cases: CaseRunResult[];
}

export function computeReport(cases: CaseRunResult[]): RecallReport {
  const totalCases = cases.length;
  if (totalCases === 0) {
    return {
      totalCases: 0,
      hits: 0,
      recallAtK: 0,
      mrr: 0,
      citationAccuracy: 0,
      avgInjectionTokens: 0,
      byIntent: {},
      cases,
    };
  }

  let hits = 0;
  let mrrSum = 0;
  let citationOk = 0;
  let injectionTotal = 0;

  const byIntent: RecallReport["byIntent"] = {};

  for (const c of cases) {
    if (c.hit) hits += 1;
    if (c.hitRank !== undefined) mrrSum += 1 / c.hitRank;
    if (c.citationsValid) citationOk += 1;
    injectionTotal += c.injectionTokens;

    const slot = (byIntent[c.intent] ??= { n: 0, hits: 0, recall: 0, mrr: 0 });
    slot.n += 1;
    if (c.hit) slot.hits += 1;
    if (c.hitRank !== undefined) slot.mrr += 1 / c.hitRank;
  }

  for (const k of Object.keys(byIntent)) {
    const slot = byIntent[k]!;
    slot.recall = slot.n === 0 ? 0 : slot.hits / slot.n;
    slot.mrr = slot.n === 0 ? 0 : slot.mrr / slot.n;
  }

  return {
    totalCases,
    hits,
    recallAtK: hits / totalCases,
    mrr: mrrSum / totalCases,
    citationAccuracy: citationOk / totalCases,
    avgInjectionTokens: injectionTotal / totalCases,
    byIntent,
    cases,
  };
}
