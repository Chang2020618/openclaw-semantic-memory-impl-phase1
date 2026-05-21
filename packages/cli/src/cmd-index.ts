/**
 * `osm index` — capture markdown -> chunk -> embed -> upsert.
 *
 * Phase-1 strategy:
 *   1. walk memory/
 *   2. for each file:
 *        a. extract sections -> Memory candidates (episodes only)
 *        b. compare hash with stored memory; skip if unchanged
 *        c. chunk each new/changed section
 *        d. embed all new/changed chunk texts in one batch per file
 *        e. upsert memory + chunks (delete-then-insert vec0/FTS)
 *   3. if --rebuild: delete the DB file first, then run as above
 *
 * Hard rules:
 *   - canonical markdown is read-only here (we never modify source files)
 *   - if any embedding errors, we abort the run cleanly and leave prior
 *     state intact for the failing file
 *   - we always write an audit row at the end with totals
 */

import { readFileSync, rmSync } from "node:fs";

import {
  contentHash,
  chunkId as makeChunkId,
  type Chunk,
} from "@osm/core";
import { chunkMarkdown } from "@osm/chunker";
import { extractMemoriesFromMarkdown, walkMarkdown } from "@osm/capture";
import { makeEmbeddingProvider } from "@osm/embed";
import { OsmStore } from "@osm/store";

import { ensureMemoryRoot, loadOrInitConfig, resolveWorkspace } from "./workspace.js";

export interface IndexArgs {
  rootFlag: string | undefined;
  rebuild: boolean;
  /** Override embedding provider; useful for tests (`local-stub`). */
  providerOverride?: string;
}

export interface IndexReport {
  filesScanned: number;
  filesChanged: number;
  memoriesUpserted: number;
  memoriesUnchanged: number;
  chunksUpserted: number;
  embeddingsRequested: number;
  embeddingProvider: string;
  rebuild: boolean;
  durationMs: number;
}

export async function runIndex(args: IndexArgs): Promise<IndexReport> {
  const start = Date.now();
  const paths = resolveWorkspace(args.rootFlag);
  ensureMemoryRoot(paths);

  if (args.rebuild) {
    try {
      rmSync(paths.dbPath, { force: true });
      rmSync(paths.dbPath + "-wal", { force: true });
      rmSync(paths.dbPath + "-shm", { force: true });
    } catch {
      // ignore
    }
  }

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
    createDirs: true,
  });

  const files = walkMarkdown({
    memoryRoot: paths.memoryRoot,
    includeWorkspaceMemoryMd: { workspaceRoot: paths.workspaceRoot },
  });

  let filesChanged = 0;
  let memoriesUpserted = 0;
  let memoriesUnchanged = 0;
  let chunksUpserted = 0;
  let embeddingsRequested = 0;

  const fallbackTimestamp = new Date().toISOString();

  try {
    for (const file of files) {
      const text = readFileSync(file.absPath, "utf8");
      const sections = extractMemoriesFromMarkdown({
        relPath: file.relPath,
        source: text,
        defaultScope: config.scope.defaultScope,
        fallbackTimestamp,
        defaultSourceKind: "human_confirmed",
      });

      let fileChangedHere = false;

      for (const section of sections) {
        const existing = store.getMemoryById(section.memory.memoryId);
        if (existing && existing.hash === section.memory.hash) {
          memoriesUnchanged += 1;
          continue;
        }

        // Chunk the section text.
        const rawChunks = chunkMarkdown(section.rawText, {
          targetChars: config.chunking.targetChars,
          softOverlapChars: config.chunking.softOverlapChars,
          respectHeadings: false, // section is already heading-bounded
        });
        if (rawChunks.length === 0) continue;

        // Build Chunk objects (ids depend on chunk content hash).
        const chunks: Chunk[] = rawChunks.map((rc, i) => {
          const ch = contentHash(rc.text);
          return {
            chunkId: makeChunkId({
              memoryId: section.memory.memoryId,
              index: i,
              chunkContentHash: ch,
            }),
            memoryId: section.memory.memoryId,
            text: rc.text,
            sourcePath: file.relPath,
            lineStart: section.lineStart + (rc.lineStart - 1),
            lineEnd: section.lineStart + (rc.lineEnd - 1),
            embeddingModelId: provider.id,
            hash: ch,
          };
        });

        // Embed all chunk texts in one batch (provider chunks internally).
        const texts = chunks.map((c) => c.text);
        const vectors = await provider.embed(texts);
        embeddingsRequested += texts.length;

        // Persist memory first, then each chunk.
        store.upsertMemory(section.memory);
        for (let i = 0; i < chunks.length; i += 1) {
          store.upsertChunk(chunks[i]!, vectors[i]!);
        }

        memoriesUpserted += 1;
        chunksUpserted += chunks.length;
        fileChangedHere = true;
      }

      if (fileChangedHere) filesChanged += 1;
    }
  } finally {
    const report: IndexReport = {
      filesScanned: files.length,
      filesChanged,
      memoriesUpserted,
      memoriesUnchanged,
      chunksUpserted,
      embeddingsRequested,
      embeddingProvider: provider.id,
      rebuild: args.rebuild,
      durationMs: Date.now() - start,
    };
    store.appendAudit("rebuild", { op: "index", ...report });
    store.close();
    // attach report so the caller (success path) can read it
    (runIndex as unknown as { lastReport?: IndexReport }).lastReport = report;
  }

  const last = (runIndex as unknown as { lastReport?: IndexReport }).lastReport;
  if (!last) {
    throw new Error("osm: index report missing");
  }
  return last;
}

export function printIndexReport(report: IndexReport): void {
  const lines = [
    `osm: index ${report.rebuild ? "(full rebuild)" : "(incremental)"} done in ${report.durationMs}ms`,
    `  files scanned        = ${report.filesScanned}`,
    `  files changed        = ${report.filesChanged}`,
    `  memories upserted    = ${report.memoriesUpserted}`,
    `  memories unchanged   = ${report.memoriesUnchanged}`,
    `  chunks upserted      = ${report.chunksUpserted}`,
    `  embeddings requested = ${report.embeddingsRequested}`,
    `  embedding provider   = ${report.embeddingProvider}`,
  ];
  console.log(lines.join("\n"));
}
