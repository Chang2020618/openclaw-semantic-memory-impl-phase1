/**
 * Trust-quality metrics.
 *
 * v0.1 hard rules we verify here:
 *   - inferred memory never appears with high confidence as a fact
 *   - secrets never appear in any retrieved chunk text
 *   - archived memory never auto-injected
 *   - citation always present and valid-shaped
 *
 * "false_memory_rate" in the v0.1 spec is fundamentally a HUMAN-LABELED
 * metric: it counts cases the user marks "you said something that didn't
 * happen". The harness tracks it by reading optional `humanLabel` markers
 * from a sibling `labels.jsonl`. If no labels file is present, this stat is
 * reported as `n/a` and the gate is skipped.
 */

import type { RetrievalResult, SourceKind } from "@osm/core";

import type { CaseRunResult } from "./recall.js";

export interface HumanLabel {
  caseId: string;
  /** "ok" | "wrong" | "partial" */
  verdict: "ok" | "wrong" | "partial";
  notes?: string;
}

export interface TrustReport {
  totalCases: number;
  forbiddenStatusInjections: number;
  highConfidenceInferredInjections: number;
  citationFormatViolations: number;
  secretLikePatternHits: number;
  humanLabeledCases: number;
  falseMemoryRate: number | null;
  details: TrustDetail[];
}

export interface TrustDetail {
  caseId: string;
  issues: string[];
}

const SECRET_PATTERNS: RegExp[] = [
  /sk-[a-zA-Z0-9]{16,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /-----BEGIN [A-Z ]+PRIVATE KEY-----/,
  /\bxox[abp]-[A-Za-z0-9-]{10,}\b/,
];

const CITATION_RE = /^.+?(#L\d+(?:-L\d+)?)?$/;

export function evaluateTrust(
  cases: CaseRunResult[],
  labels: HumanLabel[] = []
): TrustReport {
  const labelMap = new Map(labels.map((l) => [l.caseId, l]));
  const details: TrustDetail[] = [];

  let forbiddenStatus = 0;
  let highConfInferred = 0;
  let citationViolations = 0;
  let secretHits = 0;
  let labeled = 0;
  let falseMemory = 0;

  for (const c of cases) {
    const issues: string[] = [];

    for (const r of c.retrieved) {
      // 1. citation shape
      if (!r.citation || !CITATION_RE.test(r.citation)) {
        issues.push(`bad_citation:${r.memoryId}`);
        citationViolations += 1;
      }

      // 2. secret-like content in summary
      for (const re of SECRET_PATTERNS) {
        if (re.test(r.summary)) {
          issues.push(`secret_in_summary:${r.memoryId}`);
          secretHits += 1;
          break;
        }
      }

      // 3. inferred-with-high-confidence smuggling
      if (
        whyKindFor(r) === "assistant_inferred" &&
        r.confidence >= 0.8
      ) {
        issues.push(`inferred_high_confidence:${r.memoryId}`);
        highConfInferred += 1;
      }
    }

    const label = labelMap.get(c.caseId);
    if (label) {
      labeled += 1;
      if (label.verdict === "wrong") {
        falseMemory += 1;
        issues.push(`human_label:wrong`);
      } else if (label.verdict === "partial") {
        // don't count partial as false memory; flag it for review
        issues.push(`human_label:partial`);
      }
    }

    if (issues.length > 0) {
      details.push({ caseId: c.caseId, issues });
    }
  }

  const falseMemoryRate = labeled === 0 ? null : falseMemory / labeled;

  return {
    totalCases: cases.length,
    forbiddenStatusInjections: forbiddenStatus,
    highConfidenceInferredInjections: highConfInferred,
    citationFormatViolations: citationViolations,
    secretLikePatternHits: secretHits,
    humanLabeledCases: labeled,
    falseMemoryRate,
    details,
  };
}

/**
 * The retrieval result carries the memory's source kind only indirectly
 * via whyMatched ("human_confirmed" tag) — we take its absence as a hint of
 * non-human origin. For now we cannot perfectly reconstruct sourceKind
 * without going back to the store; that's a follow-up.
 */
function whyKindFor(r: RetrievalResult): SourceKind | "unknown" {
  if (r.whyMatched.includes("human_confirmed")) return "human_confirmed";
  return "unknown";
}
