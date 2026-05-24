import type { RetrievalQuery } from "@osm/core";
import { makeEmbeddingProvider } from "@osm/embed";
import { Retriever } from "@osm/retrieve";
import { OsmStore } from "@osm/store";

import { ensureMemoryRoot, loadOrInitConfig, resolveWorkspace } from "./workspace.js";

export interface PanelArgs {
  rootFlag: string | undefined;
  json: boolean;
  limit?: number;
  query?: string;
}

export async function runPanel(args: PanelArgs): Promise<number> {
  const paths = resolveWorkspace(args.rootFlag);
  ensureMemoryRoot(paths);
  const config = loadOrInitConfig(paths);

  const store = new OsmStore({
    dbPath: paths.dbPath,
    embedding: {
      providerId: config.embedding.providerId,
      modelId: config.embedding.modelId,
      dim: config.embedding.dim,
    },
  });

  const provider = makeEmbeddingProvider({
    providerId: config.embedding.providerId,
    modelId: config.embedding.modelId,
    dim: config.embedding.dim,
  });

  try {
    const nowIso = new Date().toISOString();
    const recentLimit = Math.max(1, Math.min(args.limit ?? 10, 50));
    const payload: Record<string, unknown> = {
      persistent: {
        total: store.countMemories(),
        byStatus: store.countMemoriesByStatus(),
        bySourceKind: store.countMemoriesBySourceKind(),
      },
      ephemeral: {
        total: store.countEphemeralMemories(),
        byStatus: store.countEphemeralByStatus(),
        overdue: store.countEphemeralOverdue(nowIso),
        avgConfidence: store.avgEphemeralConfidence(),
        recent: store.listRecentEphemeral(recentLimit).map((row) => ({
          memoryId: row.memory_id,
          sessionId: row.session_id,
          memoryType: row.memory_type,
          summary: row.summary,
          confidence: row.confidence,
          status: row.status,
          citation: row.citation,
          createdAt: row.created_at,
          expiresAt: row.expires_at,
        })),
      },
    };

    if (args.query && args.query.trim()) {
      const retriever = new Retriever({
        store,
        provider,
        defaults: {
          topK: config.retrieval.topK,
          topN: config.retrieval.topN,
          minScore: config.retrieval.minScore,
          defaultScope: config.scope.defaultScope,
        },
        ephemeral: {
          enabled: true,
          weight: config.ephemeral?.retrievalWeight ?? 0.85,
          minConfidence: config.ephemeral?.minConfidence ?? 0.5,
        },
      });

      const q: RetrievalQuery = { text: args.query };
      const response = await retriever.retrieve(q, { debug: true, auditKind: "retrieve" });
      payload["retrieval"] = {
        query: response.query,
        debug: response.debug,
        results: response.results.map((r) => ({
          memoryId: r.memoryId,
          memoryType: r.memoryType,
          summary: r.summary,
          citation: r.citation,
          score: r.score,
          confidence: r.confidence,
          whyMatched: r.whyMatched,
        })),
      };
    }

    if (args.json) {
      console.log(JSON.stringify(payload, null, 2));
    } else {
      const p = payload["persistent"] as { total: number; byStatus: Record<string, number>; bySourceKind: Record<string, number> };
      const e = payload["ephemeral"] as {
        total: number;
        byStatus: Record<string, number>;
        overdue: number;
        avgConfidence: number | null;
        recent: Array<{ memoryType: string; summary: string }>;
      };
      console.log(`persistent total: ${p.total}`);
      console.log(`persistent by status: ${JSON.stringify(p.byStatus)}`);
      console.log(`persistent by source: ${JSON.stringify(p.bySourceKind)}`);
      console.log(`ephemeral total: ${e.total}`);
      console.log(`ephemeral by status: ${JSON.stringify(e.byStatus)}`);
      console.log(`ephemeral overdue: ${e.overdue}`);
      console.log(`ephemeral avg confidence: ${e.avgConfidence ?? "n/a"}`);
      console.log(`recent ephemeral (${e.recent.length}):`);
      for (const item of e.recent) {
        console.log(`- [${item.memoryType}] ${item.summary}`);
      }
      if (payload["retrieval"]) {
        const r = payload["retrieval"] as {
          query: string;
          results: Array<{ memoryType: string; summary: string; score: number; whyMatched: string[] }>;
        };
        console.log(`retrieval query: ${r.query}`);
        for (const item of r.results) {
          console.log(`- [${item.memoryType}] score=${item.score} ${item.summary}`);
          console.log(`  why: ${item.whyMatched.join(", ")}`);
        }
      }
    }

    return 0;
  } finally {
    store.close();
  }
}
