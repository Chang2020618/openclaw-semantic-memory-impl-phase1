/**
 * `osm search "<query>"` — hybrid retrieval, top-K with citations + whyMatched.
 *
 * Phase-1 output is human-readable plain text. Add --json for raw output.
 */

import type { RetrievalQuery } from "@osm/core";
import { makeEmbeddingProvider } from "@osm/embed";
import { Retriever } from "@osm/retrieve";
import { OsmStore } from "@osm/store";

import { ensureMemoryRoot, loadOrInitConfig, resolveWorkspace } from "./workspace.js";

export interface SearchArgs {
  rootFlag: string | undefined;
  query: string;
  topK: number | undefined;
  json: boolean;
  debug: boolean;
  providerOverride?: string;
  /** Phase-2: toggle ephemeral fan-out. Defaults to true. */
  noEphemeral?: boolean;
  onlyEphemeral?: boolean;
  /** Skip retrieval entirely for weak acknowledgements / continuation nudges. */
  skipWeakQuery?: boolean;
}

const WEAK_QUERY_PATTERNS = [
  /^同意[了啊呀吗嘛]?$/,
  /^继续([吧呀哈]?)$/,
  /^好([的啊呀吧哈]?)[!！]?$/,
  /^收到[了]?[!！]?$/,
  /^嗯[嗯啊呀]?$/,
  /^ok[.!! ]*$/i,
  /^好的继续$/,
  /^现在我接下来该做什么[？?]?$/,
];

function isWeakQuery(query: string): boolean {
  const text = query.trim();
  if (!text) return true;
  if (text.length <= 2) return true;
  return WEAK_QUERY_PATTERNS.some((re) => re.test(text));
}

export async function runSearch(args: SearchArgs): Promise<number> {
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
    if (args.skipWeakQuery && isWeakQuery(args.query)) {
      const response = { query: args.query, results: [] };
      if (args.json) {
        console.log(JSON.stringify(response, null, 2));
      } else {
        console.log(`osm: skipped weak query "${args.query}"`);
      }
      return 0;
    }

    const ephemeralEnabled = !args.noEphemeral;
    const ephemeralWeight = config.ephemeral?.retrievalWeight ?? 0.85;
    const ephemeralMinConf = config.ephemeral?.minConfidence ?? 0.5;

    const retriever = new Retriever({
      store,
      provider,
      defaults: {
        topK: config.retrieval.topK,
        topN: config.retrieval.topN,
        minScore: config.retrieval.minScore,
        defaultScope: config.scope.defaultScope,
      },
      ephemeral: ephemeralEnabled
        ? {
            enabled: true,
            weight: args.onlyEphemeral ? 1.0 : ephemeralWeight,
            minConfidence: ephemeralMinConf,
          }
        : { enabled: false, weight: 0, minConfidence: 1 },
    });

    const q: RetrievalQuery = {
      text: args.query,
      ...(args.topK !== undefined ? { topK: args.topK } : {}),
    };

    const response = await retriever.retrieve(q, { debug: args.debug });

    // --only-ephemeral filter: drop persistent results post-hoc
    if (args.onlyEphemeral) {
      response.results = response.results.filter((r) =>
        r.whyMatched.some((w) => w.includes("layer=ephemeral"))
      );
    }

    if (args.json) {
      console.log(JSON.stringify(response, null, 2));
      return 0;
    }

    if (response.results.length === 0) {
      console.log(`osm: no results for "${response.query}"`);
      return 0;
    }

    const lines: string[] = [];
    lines.push(`query: ${response.query}`);
    lines.push(`results: ${response.results.length}`);
    if (response.debug) {
      lines.push(
        `debug: candidates=${response.debug.candidates} ` +
          `semantic=${response.debug.topNSemantic} ` +
          `lexical=${response.debug.topNLexical} ` +
          `rejected=${response.debug.rejected.length}` +
          (response.debug.ephemeralCandidates !== undefined
            ? ` ephemeral=${response.debug.ephemeralAccepted}/${response.debug.ephemeralCandidates}`
            : "")
      );
    }
    lines.push("");

    for (const [i, r] of response.results.entries()) {
      lines.push(
        `[${i + 1}] ${r.memoryType}  score=${r.score.toFixed(4)}  conf=${r.confidence.toFixed(2)}`
      );
      lines.push(`    summary: ${r.summary}`);
      lines.push(`    cite:    ${r.citation}`);
      lines.push(`    why:     ${r.whyMatched.join(", ")}`);
      lines.push("");
    }

    console.log(lines.join("\n"));
    return 0;
  } finally {
    store.close();
  }
}
