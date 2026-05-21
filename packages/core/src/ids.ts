/**
 * Stable id helpers.
 *
 * Memory ids and chunk ids must be deterministic when computed from the same
 * canonical inputs, so that repeated indexing of unchanged content produces
 * the same row keys (idempotent reindex).
 */

import { sha256 } from "./hash.js";

/**
 * Memory id is derived from (memoryType, sourcePath, anchor, contentHash).
 *
 * "anchor" is whatever localizes the memory inside the file. For markdown-
 * walked episodes, the anchor is typically the heading text or the line range.
 */
export function memoryId(parts: {
  memoryType: string;
  sourcePath: string;
  anchor: string;
  contentHash: string;
}): string {
  const seed = [
    parts.memoryType,
    parts.sourcePath,
    parts.anchor,
    parts.contentHash,
  ].join("\u0000");
  return `mem_${sha256(seed).slice(0, 24)}`;
}

/**
 * Chunk id is derived from (memoryId, chunk index, chunkContentHash). This
 * lets us produce stable chunk ids even when a memory has multiple chunks,
 * and lets us detect when a chunk's text has actually changed.
 */
export function chunkId(parts: {
  memoryId: string;
  index: number;
  chunkContentHash: string;
}): string {
  const seed = [
    parts.memoryId,
    String(parts.index),
    parts.chunkContentHash,
  ].join("\u0000");
  return `chk_${sha256(seed).slice(0, 24)}`;
}
