/**
 * Eval runner: load a test set, run each query through a Retriever, score
 * with computeReport + evaluateTrust, return a combined report.
 */

import { readFileSync, existsSync } from "node:fs";

import type { Memory, RetrievalQuery } from "@osm/core";
import { OsmStore } from "@osm/store";
import { makeEmbeddingProvider, type EmbeddingProvider } from "@osm/embed";
import { Retriever } from "@osm/retrieve";

import type { TestCase, TestSet } from "./test-set.js";
import {
  computeReport,
  type CaseRunResult,
  type RecallReport,
} from "./recall.js";
import {
  evaluateTrust,
  type HumanLabel,
  type TrustReport,
} from "./trust.js";

export interface RunOptions {
  testSetPath: string;
  /** Optional sibling labels file. */
  labelsPath?: string;
  store: OsmStore;
  provider: EmbeddingProvider;
  defaults: {
    topK: number;
    topN: number;
    minScore: number;
    defaultScope: "global" | "project" | "channel" | "private";
  };
}

export interface CombinedReport {
  recall: RecallReport;
  trust: TrustReport;
  testSet: TestSet;
}

export function loadTestSet(path: string): TestSet {
  if (!existsSync(path)) {
    throw new Error(`osm/eval: test set not found at ${path}`);
  }
  const raw = readFileSync(path, "utf8");
  const cases: TestCase[] = [];
  for (const [i, line] of raw.split(/\r?\n/).entries()) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    if (trimmed.startsWith("//")) continue;
    if (trimmed.startsWith("#")) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (err) {
      throw new Error(
        `osm/eval: ${path}:${i + 1}: invalid JSON — ${(err as Error).message}`
      );
    }
    cases.push(coerceTestCase(parsed, `${path}:${i + 1}`));
  }
  return { cases, source: path };
}

export function loadLabels(path: string | undefined): HumanLabel[] {
  if (!path) return [];
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, "utf8");
  const out: HumanLabel[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (t.length === 0) continue;
    if (t.startsWith("//") || t.startsWith("#")) continue;
    const parsed = JSON.parse(t) as HumanLabel;
    if (typeof parsed.caseId !== "string") continue;
    out.push(parsed);
  }
  return out;
}

function coerceTestCase(value: unknown, where: string): TestCase {
  if (typeof value !== "object" || value === null) {
    throw new Error(`osm/eval: ${where}: not an object`);
  }
  const o = value as Record<string, unknown>;
  if (typeof o["id"] !== "string") {
    throw new Error(`osm/eval: ${where}: missing/invalid id`);
  }
  if (typeof o["query"] !== "string") {
    throw new Error(`osm/eval: ${where}: missing/invalid query`);
  }
  if (
    !Array.isArray(o["expectedMemoryIds"]) ||
    !o["expectedMemoryIds"].every((s) => typeof s === "string")
  ) {
    throw new Error(`osm/eval: ${where}: missing/invalid expectedMemoryIds`);
  }
  if (typeof o["intent"] !== "string") {
    throw new Error(`osm/eval: ${where}: missing/invalid intent`);
  }
  return {
    id: o["id"] as string,
    query: o["query"] as string,
    expectedMemoryIds: o["expectedMemoryIds"] as string[],
    intent: o["intent"] as TestCase["intent"],
    notes: typeof o["notes"] === "string" ? (o["notes"] as string) : undefined,
    k: typeof o["k"] === "number" ? (o["k"] as number) : undefined,
  };
}

export async function runEval(opts: RunOptions): Promise<CombinedReport> {
  const testSet = loadTestSet(opts.testSetPath);
  const labels = loadLabels(opts.labelsPath);

  const retriever = new Retriever({
    store: opts.store,
    provider: opts.provider,
    defaults: opts.defaults,
  });

  const cases: CaseRunResult[] = [];

  for (const tc of testSet.cases) {
    const k = tc.k ?? opts.defaults.topK;
    const query: RetrievalQuery = { text: tc.query, topK: k };

    const response = await retriever.retrieve(query);
    const retrieved = response.results;

    const expectedSet = new Set(tc.expectedMemoryIds);
    let hitRank: number | undefined = undefined;
    for (let i = 0; i < retrieved.length; i += 1) {
      if (expectedSet.has(retrieved[i]!.memoryId)) {
        hitRank = i + 1;
        break;
      }
    }

    const injectionTokens = retrieved.reduce(
      (acc, r) => acc + Math.ceil((r.summary.length + r.citation.length) / 4),
      0
    );

    const issues: string[] = [];
    let citationsValid = true;
    for (const r of retrieved) {
      if (!r.citation || r.citation.length === 0) {
        citationsValid = false;
        issues.push(`empty_citation:${r.memoryId}`);
        continue;
      }
      if (!/^.+\.md(?:#L\d+(?:-L\d+)?)?$/.test(r.citation)) {
        citationsValid = false;
        issues.push(`bad_citation:${r.memoryId}:${r.citation}`);
      }
    }

    cases.push({
      caseId: tc.id,
      query: tc.query,
      intent: tc.intent,
      k,
      expectedMemoryIds: tc.expectedMemoryIds,
      retrieved,
      hitRank,
      hit: hitRank !== undefined,
      injectionTokens,
      citationsValid,
      citationIssues: issues,
    });
  }

  return {
    recall: computeReport(cases),
    trust: evaluateTrust(cases, labels),
    testSet,
  };
}

/** Convenience: also assert the v0.1 success thresholds and return pass/fail. */
export interface GateOutcome {
  pass: boolean;
  failures: string[];
}

export function checkV01Gates(report: CombinedReport): GateOutcome {
  const failures: string[] = [];
  const r = report.recall;

  if (r.totalCases === 0) {
    failures.push("no test cases loaded");
    return { pass: false, failures };
  }

  if (r.recallAtK < 0.85) {
    failures.push(
      `recall@${r.cases[0]?.k ?? 5} = ${r.recallAtK.toFixed(3)} (< 0.85)`
    );
  }
  if (r.citationAccuracy < 0.95) {
    failures.push(
      `citation_accuracy = ${r.citationAccuracy.toFixed(3)} (< 0.95)`
    );
  }
  if (r.avgInjectionTokens > 200) {
    failures.push(
      `avg_injection_tokens = ${r.avgInjectionTokens.toFixed(0)} (> 200)`
    );
  }
  if (
    report.trust.falseMemoryRate !== null &&
    report.trust.falseMemoryRate > 0.05
  ) {
    failures.push(
      `false_memory_rate = ${report.trust.falseMemoryRate.toFixed(3)} (> 0.05)`
    );
  }

  return { pass: failures.length === 0, failures };
}

/** Helper to wire everything from config. */
export function openStoreAndProvider(opts: {
  dbPath: string;
  embedding: { providerId: string; modelId: string; dim: number };
}): { store: OsmStore; provider: EmbeddingProvider } {
  const store = new OsmStore({
    dbPath: opts.dbPath,
    embedding: opts.embedding,
  });
  const provider = makeEmbeddingProvider(opts.embedding);
  return { store, provider };
}

// Keep imports referenced for downstream typechecking.
export type { Memory };
