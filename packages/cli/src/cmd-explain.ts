/**
 * `osm explain <memoryId>` — full Memory + provenance + chunks + recent audit
 * rows that referenced this memory.
 *
 * Phase-1 output is human-readable. --json gives raw structured output.
 */

import type { Memory } from "@osm/core";
import { OsmStore } from "@osm/store";

import { ensureMemoryRoot, loadOrInitConfig, resolveWorkspace } from "./workspace.js";

export interface ExplainArgs {
  rootFlag: string | undefined;
  memoryId: string;
  json: boolean;
  /** Cap on recent audit hits surfaced. */
  auditLimit: number;
  providerOverride?: string;
}

interface ExplainPayload {
  memory: Memory;
  chunks: Array<{
    chunkId: string;
    sourcePath: string;
    lineStart: number | null;
    lineEnd: number | null;
    embeddingModelId: string;
    chars: number;
    hash: string;
  }>;
  recentAudit: Array<{
    id: number;
    ts: string;
    kind: string;
    payload: unknown;
  }>;
  citation: string;
}

export function runExplain(args: ExplainArgs): number {
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

  try {
    const memory = store.getMemoryById(args.memoryId);
    if (!memory) {
      console.error(`osm explain: memoryId '${args.memoryId}' not found`);
      return 65;
    }

    const chunkRows = store.listChunksByMemory(args.memoryId);
    const recentAudit = store.recentAuditForMemory(args.memoryId, args.auditLimit);

    const citation = formatCitation(memory);

    const payload: ExplainPayload = {
      memory,
      citation,
      chunks: chunkRows.map((r) => ({
        chunkId: r.chunk_id,
        sourcePath: r.source_path,
        lineStart: r.line_start,
        lineEnd: r.line_end,
        embeddingModelId: r.embedding_model_id,
        chars: r.text.length,
        hash: r.hash,
      })),
      recentAudit,
    };

    store.appendAudit("explain", { memoryId: args.memoryId });

    if (args.json) {
      console.log(JSON.stringify(payload, null, 2));
      return 0;
    }

    printHuman(payload);
    return 0;
  } finally {
    store.close();
  }
}

function formatCitation(m: Memory): string {
  const p = m.provenance;
  if (p.lineStart !== undefined && p.lineEnd !== undefined) {
    return `${p.path}#L${p.lineStart}-L${p.lineEnd}`;
  }
  return p.path;
}

function pickSummary(m: Memory): string {
  if ("summary" in m && typeof m.summary === "string") return m.summary;
  if ("title" in m && typeof m.title === "string") return m.title;
  return "(no summary)";
}

function printHuman(p: ExplainPayload): void {
  const m = p.memory;
  const lines: string[] = [];
  lines.push(`memoryId:   ${m.memoryId}`);
  lines.push(`type:       ${m.memoryType}`);
  lines.push(`status:     ${m.status}`);
  lines.push(`scope:      ${m.scope}`);
  lines.push(`importance: ${m.importance.toFixed(2)}`);
  lines.push(`confidence: ${m.confidence.toFixed(2)}`);
  lines.push(`timestamp:  ${m.timestamp}`);
  lines.push(`source:     ${m.provenance.sourceKind}`);
  lines.push(`citation:   ${p.citation}`);
  if (m.project) lines.push(`project:    ${m.project}`);
  if (m.channel) lines.push(`channel:    ${m.channel}`);
  if (m.tags.length > 0) lines.push(`tags:       ${m.tags.join(", ")}`);
  if (m.entities.length > 0) lines.push(`entities:   ${m.entities.join(", ")}`);
  lines.push(`hash:       ${m.hash.slice(0, 16)}...`);
  lines.push("");
  lines.push(`summary:    ${pickSummary(m)}`);
  lines.push("");

  lines.push(`chunks:     ${p.chunks.length}`);
  for (const ch of p.chunks) {
    const range =
      ch.lineStart !== null && ch.lineEnd !== null
        ? `L${ch.lineStart}-L${ch.lineEnd}`
        : "(no line range)";
    lines.push(
      `  - ${ch.chunkId}  ${ch.sourcePath} ${range}  ${ch.chars}c  model=${ch.embeddingModelId}`
    );
  }
  lines.push("");

  lines.push(`recent audit hits: ${p.recentAudit.length}`);
  for (const a of p.recentAudit) {
    lines.push(`  - [${a.id}] ${a.ts} ${a.kind}`);
  }

  console.log(lines.join("\n"));
}
