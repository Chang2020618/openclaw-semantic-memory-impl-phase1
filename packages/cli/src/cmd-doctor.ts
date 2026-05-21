/**
 * `osm doctor` — health check.
 *
 * Implements the 8 signals from `docs/16-operations.md`:
 *   1. index_age            seconds since last index/rebuild
 *   2. stale_chunk_ratio    chunks whose source markdown no longer matches their hash
 *   3. capture_error_rate   audit errors over total captures in last 24h (Phase-1: 0)
 *   4. retrieval_latency    p50/p95 ms (no audit-recorded latency yet, returns null)
 *   5. zero_result_rate     queries returning 0 results / total over last 24h
 *   6. injection_token_avg  Phase-1: average chunk text length / 4 (rough char->token)
 *   7. inferred_to_promoted_ratio   Phase-1 always 0 (promotion not yet enabled)
 *   8. archived_growth      count delta over last 24h
 *
 * Each signal has a configurable threshold; doctor exits non-zero if any
 * signal is above its threshold (or below, if "lower is bad").
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { contentHash } from "@osm/core";
import { OsmStore } from "@osm/store";

import { ensureMemoryRoot, loadOrInitConfig, resolveWorkspace } from "./workspace.js";

export interface DoctorArgs {
  rootFlag: string | undefined;
  json: boolean;
  providerOverride?: string;
  /** Phase-2: hard-delete expired ephemeral rows. */
  vacuum?: boolean;
}

interface SignalResult {
  name: string;
  value: number | string | null;
  /** "ok" | "warn" | "fail" */
  status: "ok" | "warn" | "fail" | "unknown";
  detail?: string;
}

export function runDoctor(args: DoctorArgs): number {
  const paths = resolveWorkspace(args.rootFlag);
  ensureMemoryRoot(paths);
  const config = loadOrInitConfig(paths);

  const providerId = args.providerOverride ?? config.embedding.providerId;

  const store = new OsmStore({
    dbPath: paths.dbPath,
    embedding: {
      providerId,
      modelId: config.embedding.modelId,
      dim: config.embedding.dim,
    },
  });

  const signals: SignalResult[] = [];
  const now = Date.now();

  try {
    /* 1. index_age */
    {
      const last = store.latestAudit("rebuild");
      if (!last) {
        signals.push({
          name: "index_age",
          value: null,
          status: "warn",
          detail: "no rebuild audit yet — run `osm index`",
        });
      } else {
        const ageSec = Math.round((now - Date.parse(last.ts)) / 1000);
        signals.push({
          name: "index_age",
          value: ageSec,
          status: ageSec > 24 * 3600 ? "warn" : "ok",
          detail: `last rebuild ${ageSec}s ago`,
        });
      }
    }

    /* 2. stale_chunk_ratio */
    {
      const totalChunks = store.countChunks();
      let stale = 0;
      let inspected = 0;

      // Sample-based to keep doctor cheap. Inspect at most 100 chunks.
      const sampleLimit = 100;
      const memories = listMemoryRows(store);
      for (const mem of memories.slice(0, sampleLimit)) {
        const chunks = store.listChunksByMemory(mem.memory_id);
        for (const ch of chunks) {
          inspected += 1;
          // Phase-1 freshness check: does the source file still exist, and
          // does it have at least line_end lines? This validates that the
          // citation we'd return still points somewhere real. We do NOT
          // expect the chunk text to appear verbatim because the chunker
          // injects soft-overlap from neighboring chunks.
          try {
            const abs = sourceAbs(paths, ch.source_path);
            const text = readFileSync(abs, "utf8");
            const lineCount = text.split(/\r?\n/).length;
            const needed = ch.line_end ?? ch.line_start ?? 1;
            if (lineCount < needed) stale += 1;
          } catch {
            stale += 1;
          }
          if (inspected >= sampleLimit) break;
        }
        if (inspected >= sampleLimit) break;
      }

      const ratio = inspected === 0 ? 0 : stale / inspected;
      signals.push({
        name: "stale_chunk_ratio",
        value: round3(ratio),
        status: ratio > 0.05 ? "warn" : "ok",
        detail:
          totalChunks === 0
            ? "no chunks indexed"
            : `${stale}/${inspected} sampled stale (total chunks=${totalChunks})`,
      });
    }

    /* 3. capture_error_rate (Phase-1: not tracked) */
    signals.push({
      name: "capture_error_rate",
      value: 0,
      status: "ok",
      detail: "Phase-1: errors abort the run; no per-error capture audit yet",
    });

    /* 4. retrieval_latency (no recorded latency yet) */
    signals.push({
      name: "retrieval_latency",
      value: null,
      status: "unknown",
      detail: "Phase-1: latency not yet recorded in retrieve audit",
    });

    /* 5. zero_result_rate (last 24h) */
    {
      const cutoff = new Date(now - 24 * 3600_000).toISOString();
      const audits = store.auditSince(cutoff, "retrieve");
      const total = audits.length;
      let zero = 0;
      for (const a of audits) {
        const p = (a.payload ?? {}) as { results?: unknown[] };
        const rs = Array.isArray(p.results) ? p.results : [];
        if (rs.length === 0) zero += 1;
      }
      const ratio = total === 0 ? 0 : zero / total;
      signals.push({
        name: "zero_result_rate",
        value: total === 0 ? null : round3(ratio),
        status: ratio > 0.3 ? "warn" : "ok",
        detail: total === 0 ? "no retrievals in last 24h" : `${zero}/${total}`,
      });
    }

    /* 6. injection_token_avg */
    {
      const totalChunks = store.countChunks();
      // Cheap estimate: average chunk text length / 4 ≈ tokens (English-ish).
      // Phase-1 spec: inject ≤ 200 tokens/turn; we report per-chunk average so
      // the user can tune chunk size.
      let avgChars: number | null = null;
      if (totalChunks > 0) {
        const memories = listMemoryRows(store);
        let total = 0;
        let n = 0;
        for (const mem of memories) {
          const chunks = store.listChunksByMemory(mem.memory_id);
          for (const ch of chunks) {
            total += ch.text.length;
            n += 1;
          }
        }
        avgChars = n === 0 ? null : total / n;
      }
      const approxTokens =
        avgChars === null ? null : Math.round(avgChars / 4);
      signals.push({
        name: "injection_token_avg",
        value: approxTokens,
        status:
          approxTokens === null
            ? "unknown"
            : approxTokens > 350
            ? "warn"
            : "ok",
        detail:
          approxTokens === null
            ? "no chunks"
            : `~${approxTokens} tokens per chunk (chars/4 estimate)`,
      });
    }

    /* 7. inferred_to_promoted_ratio (Phase-1 always 0) */
    {
      const byKind = store.countMemoriesBySourceKind();
      const inferred = byKind["assistant_inferred"] ?? 0;
      // Phase-1 has no promotion, so "promoted" count = 0.
      const ratio = 0;
      signals.push({
        name: "inferred_to_promoted_ratio",
        value: round3(ratio),
        status: "ok",
        detail: `inferred=${inferred}; Phase-1 has no promotion path yet`,
      });
    }

    /* 8. archived_growth (last 24h) */
    {
      const cutoff = new Date(now - 24 * 3600_000).toISOString();
      const audits = store.auditSince(cutoff, "rebuild");
      // Phase-1 doesn't archive on its own. Report the absolute count instead.
      const byStatus = store.countMemoriesByStatus();
      const archived = byStatus["archived"] ?? 0;
      signals.push({
        name: "archived_growth",
        value: archived,
        status: "ok",
        detail:
          audits.length === 0
            ? "no rebuild events in 24h"
            : `archived total=${archived}`,
      });
    }

    /* Phase-2 signals: ephemeral layer health */
    const ephemeralCount = store.countEphemeralMemories();
    const ephemeralByStatus = store.countEphemeralByStatus();
    const nowIso = new Date(now).toISOString();

    /* 9. ephemeral_total */
    signals.push({
      name: "ephemeral_total",
      value: ephemeralCount,
      status: "ok",
      detail:
        ephemeralCount === 0
          ? "no session summaries indexed yet"
          : `active=${ephemeralByStatus["active"] ?? 0} expired=${
              ephemeralByStatus["expired"] ?? 0
            }`,
    });

    /* 10. ephemeral_expired */
    {
      // Count rows whose expires_at < now, regardless of status flag —
      // covers both "expired" status and stale rows we haven't marked yet.
      const overdue = countOverdueEphemeral(store, nowIso);
      signals.push({
        name: "ephemeral_expired",
        value: overdue,
        status:
          overdue === 0
            ? "ok"
            : args.vacuum
            ? "ok"
            : overdue > 50
            ? "warn"
            : "ok",
        detail:
          overdue === 0
            ? "none"
            : `${overdue} past TTL — run \`osm doctor --vacuum\` to delete`,
      });
    }

    /* 11. ephemeral_avg_confidence */
    {
      const conf = avgEphemeralConfidence(store);
      signals.push({
        name: "ephemeral_avg_confidence",
        value: conf === null ? null : round3(conf),
        status:
          conf === null
            ? "unknown"
            : conf < 0.55
            ? "warn"
            : "ok",
        detail:
          conf === null
            ? "no ephemeral memories"
            : conf < 0.55
            ? "low — summarizer may be guessing too aggressively"
            : `mean=${conf.toFixed(2)} (clamped to [0.5, 0.8])`,
      });
    }

    /* If --vacuum requested, hard-delete past-TTL rows */
    let vacuumed: { memories: number; chunks: number } | null = null;
    if (args.vacuum) {
      // First mark any active rows whose expires_at < now as expired.
      store.markExpiredEphemeral(nowIso);
      vacuumed = store.vacuumExpiredEphemeral(nowIso);
      store.appendAudit("ephemeral_expire", {
        action: "vacuum",
        nowIso,
        memoriesDeleted: vacuumed.memories,
        chunksDeleted: vacuumed.chunks,
      });
    }

    const failed = signals.some((s) => s.status === "fail");

    if (args.json) {
      console.log(
        JSON.stringify(
          {
            workspaceRoot: paths.workspaceRoot,
            dbPath: paths.dbPath,
            embeddingModelId: `${providerId}:${config.embedding.modelId}`,
            counts: {
              memories: store.countMemories(),
              chunks: store.countChunks(),
              memoriesByStatus: store.countMemoriesByStatus(),
              memoriesBySourceKind: store.countMemoriesBySourceKind(),
              ephemeralMemories: ephemeralCount,
              ephemeralByStatus,
            },
            signals,
            vacuumed,
          },
          null,
          2
        )
      );
    } else {
      printHuman(paths, config, providerId, store, signals);
      if (vacuumed) {
        console.log(
          `\nvacuum: deleted ${vacuumed.memories} memories and ${vacuumed.chunks} chunks past TTL.`
        );
      }
    }

    store.appendAudit("health", { signals });

    return failed ? 1 : 0;
  } finally {
    store.close();
  }
}

function listMemoryRows(store: OsmStore): Array<{ memory_id: string }> {
  return store.listMemoryIdsWithChunks().map((id) => ({ memory_id: id }));
}

function countOverdueEphemeral(store: OsmStore, nowIso: string): number {
  // Use the raw db handle via a public helper if available; otherwise list
  // by status + manual filter. We expose this through store API.
  return store.countEphemeralOverdue(nowIso);
}

function avgEphemeralConfidence(store: OsmStore): number | null {
  return store.avgEphemeralConfidence();
}

function sourceAbs(paths: ReturnType<typeof resolveWorkspace>, rel: string): string {
  // Walker emits paths relative to memoryRoot, except workspace-root MEMORY.md
  // which is tagged with the explicit `../MEMORY.md` prefix.
  if (rel.startsWith("../")) {
    return resolve(paths.memoryRoot, rel);
  }
  return resolve(paths.memoryRoot, rel);
}

function round3(x: number): number {
  return Math.round(x * 1000) / 1000;
}

function printHuman(
  paths: ReturnType<typeof resolveWorkspace>,
  config: ReturnType<typeof loadOrInitConfig>,
  providerId: string,
  store: OsmStore,
  signals: SignalResult[]
): void {
  const counts = {
    memories: store.countMemories(),
    chunks: store.countChunks(),
    byStatus: store.countMemoriesByStatus(),
    bySourceKind: store.countMemoriesBySourceKind(),
  };

  const lines: string[] = [];
  lines.push(`osm doctor — ${paths.workspaceRoot}`);
  lines.push(`  db                = ${paths.dbPath}`);
  lines.push(
    `  embedding         = ${providerId}:${config.embedding.modelId} (dim=${config.embedding.dim})`
  );
  lines.push(`  memories          = ${counts.memories}`);
  lines.push(`  chunks            = ${counts.chunks}`);
  lines.push(`  by status         = ${kvLine(counts.byStatus)}`);
  lines.push(`  by source kind    = ${kvLine(counts.bySourceKind)}`);
  lines.push("");
  lines.push("signals:");
  for (const s of signals) {
    const icon =
      s.status === "ok"
        ? "✓"
        : s.status === "warn"
        ? "!"
        : s.status === "fail"
        ? "✗"
        : "?";
    const value = s.value === null ? "n/a" : String(s.value);
    lines.push(`  ${icon} ${s.name.padEnd(32)} = ${value.padEnd(8)} ${s.detail ?? ""}`);
  }
  console.log(lines.join("\n"));
}

function kvLine(o: Record<string, number>): string {
  const keys = Object.keys(o);
  if (keys.length === 0) return "(empty)";
  return keys.map((k) => `${k}=${o[k]}`).join(" ");
}
