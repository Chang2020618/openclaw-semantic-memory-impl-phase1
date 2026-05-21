/**
 * `osm eval <test-set.jsonl>` — run the eval harness and print a Phase-1
 * scorecard. Exits non-zero if v0.1 success gates are not met.
 */

import { resolve } from "node:path";

import { checkV01Gates, runEval } from "@osm/eval";
import { makeEmbeddingProvider } from "@osm/embed";
import { OsmStore } from "@osm/store";

import { ensureMemoryRoot, loadOrInitConfig, resolveWorkspace } from "./workspace.js";

export interface EvalArgs {
  rootFlag: string | undefined;
  testSetPath: string;
  labelsPath: string | undefined;
  json: boolean;
  providerOverride?: string;
}

export async function runEvalCmd(args: EvalArgs): Promise<number> {
  const paths = resolveWorkspace(args.rootFlag);
  ensureMemoryRoot(paths);
  const config = loadOrInitConfig(paths);

  const providerId = args.providerOverride ?? config.embedding.providerId;
  const provider = makeEmbeddingProvider({
    providerId,
    modelId: config.embedding.modelId,
    dim: config.embedding.dim,
  });

  const store = new OsmStore({
    dbPath: paths.dbPath,
    embedding: {
      providerId,
      modelId: config.embedding.modelId,
      dim: config.embedding.dim,
    },
  });

  try {
    const report = await runEval({
      testSetPath: resolve(args.testSetPath),
      ...(args.labelsPath ? { labelsPath: resolve(args.labelsPath) } : {}),
      store,
      provider,
      defaults: {
        topK: config.retrieval.topK,
        topN: config.retrieval.topN,
        minScore: config.retrieval.minScore,
        defaultScope: config.scope.defaultScope,
      },
    });

    const gate = checkV01Gates(report);

    if (args.json) {
      console.log(
        JSON.stringify(
          {
            recall: stripCases(report.recall),
            trust: report.trust,
            gate,
            cases: report.recall.cases.map((c) => ({
              id: c.caseId,
              query: c.query,
              intent: c.intent,
              k: c.k,
              hit: c.hit,
              hitRank: c.hitRank,
              expectedMemoryIds: c.expectedMemoryIds,
              top: c.retrieved.map((r) => ({
                memoryId: r.memoryId,
                citation: r.citation,
                score: r.score,
                whyMatched: r.whyMatched,
              })),
              citationsValid: c.citationsValid,
              injectionTokens: c.injectionTokens,
            })),
          },
          null,
          2
        )
      );
      return gate.pass ? 0 : 1;
    }

    printHuman(report, gate);
    return gate.pass ? 0 : 1;
  } finally {
    store.close();
  }
}

function stripCases<T extends { cases: unknown }>(r: T): Omit<T, "cases"> {
  const { cases: _, ...rest } = r;
  return rest;
}

function printHuman(
  report: Awaited<ReturnType<typeof runEval>>,
  gate: ReturnType<typeof checkV01Gates>
): void {
  const r = report.recall;
  const t = report.trust;

  const lines: string[] = [];
  lines.push(`osm eval — ${report.testSet.source}`);
  lines.push(`  cases             = ${r.totalCases}`);
  lines.push(`  hits              = ${r.hits}`);
  lines.push(`  recall@K          = ${r.recallAtK.toFixed(3)}    (target ≥ 0.85)`);
  lines.push(`  MRR               = ${r.mrr.toFixed(3)}`);
  lines.push(`  citation accuracy = ${r.citationAccuracy.toFixed(3)}    (target ≥ 0.95)`);
  lines.push(`  avg injection tok = ${r.avgInjectionTokens.toFixed(0)}     (target ≤ 200)`);
  lines.push("");

  if (Object.keys(r.byIntent).length > 0) {
    lines.push("by intent:");
    for (const [k, v] of Object.entries(r.byIntent)) {
      lines.push(
        `  ${k.padEnd(20)} n=${String(v.n).padStart(3)}  recall=${v.recall.toFixed(3)}  mrr=${v.mrr.toFixed(3)}`
      );
    }
    lines.push("");
  }

  lines.push("trust:");
  lines.push(`  citation violations          = ${t.citationFormatViolations}`);
  lines.push(`  high-confidence inferred     = ${t.highConfidenceInferredInjections}`);
  lines.push(`  secret-pattern hits          = ${t.secretLikePatternHits}`);
  lines.push(
    `  human-labeled cases          = ${t.humanLabeledCases}` +
      (t.falseMemoryRate === null
        ? "   (false_memory_rate: n/a)"
        : `   false_memory_rate = ${t.falseMemoryRate.toFixed(3)}    (target ≤ 0.05)`)
  );
  lines.push("");

  const misses = r.cases.filter((c) => !c.hit);
  if (misses.length > 0) {
    lines.push(`misses (${misses.length}):`);
    for (const c of misses) {
      lines.push(`  - ${c.caseId}  ${c.query}`);
      lines.push(`      expected: ${c.expectedMemoryIds.join(", ")}`);
      const top = c.retrieved.slice(0, 3).map((r) => r.memoryId).join(", ");
      lines.push(`      top3:     ${top || "(none)"}`);
    }
    lines.push("");
  }

  lines.push(`gate: ${gate.pass ? "PASS ✓" : "FAIL ✗"}`);
  for (const f of gate.failures) {
    lines.push(`  - ${f}`);
  }

  console.log(lines.join("\n"));
}
