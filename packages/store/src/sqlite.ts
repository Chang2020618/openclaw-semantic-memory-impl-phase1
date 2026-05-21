/**
 * SQLite-backed store for OpenClaw Semantic Memory.
 *
 * Backed by `better-sqlite3` + `sqlite-vec` + FTS5. The DB file is
 * disposable: deleting it and rebuilding from markdown must always succeed.
 */

import { readFileSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";

import type {
  AuditKind,
  Chunk,
  Memory,
  MemoryStatus,
  Scope,
  SourceKind,
} from "@osm/core";

const SCHEMA_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "schema.sql"
);

export interface OpenStoreOptions {
  dbPath: string;
  embedding: { providerId: string; modelId: string; dim: number };
  /**
   * If true, the store will create the parent directory of dbPath if it
   * does not exist.
   */
  createDirs?: boolean;
}

export interface MemoryRow {
  memory_id: string;
  memory_type: string;
  schema_version: number;
  timestamp: string;
  importance: number;
  confidence: number;
  status: MemoryStatus;
  source_kind: SourceKind;
  scope: Scope;
  project: string | null;
  channel: string | null;
  hash: string;
  json: string;
  created_at: string;
  updated_at: string;
}

export interface ChunkRow {
  chunk_id: string;
  memory_id: string;
  text: string;
  source_path: string;
  line_start: number | null;
  line_end: number | null;
  embedding_model_id: string;
  hash: string;
  created_at: string;
}

export interface VectorHit {
  chunkId: string;
  distance: number;
}

export interface LexicalHit {
  chunkId: string;
  /** Raw FTS5 rank (lower is better). Negative on bm25() in some versions. */
  rank: number;
}

export class OsmStore {
  private readonly db: Database.Database;
  private readonly embeddingId: string;
  private readonly dim: number;

  constructor(opts: OpenStoreOptions) {
    if (opts.createDirs) {
      mkdirSync(dirname(opts.dbPath), { recursive: true });
    }
    this.db = new Database(opts.dbPath);
    sqliteVec.load(this.db);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");

    this.embeddingId = `${opts.embedding.providerId}:${opts.embedding.modelId}`;
    this.dim = opts.embedding.dim;

    this.applyBaseSchema();
    this.ensureSearchTables();
    this.recordEmbeddingModel();
  }

  /* ---------------- schema bootstrap ---------------- */

  private applyBaseSchema(): void {
    const sql = readFileSync(SCHEMA_PATH, "utf8");
    this.db.exec(sql);
  }

  private ensureSearchTables(): void {
    // vec0 table; dimension is fixed at creation time. If a different dim is
    // already present we fail loudly — switching dim requires a rebuild.
    const existing = this.getMeta("vec_dim");
    if (existing !== null && existing !== String(this.dim)) {
      throw new Error(
        `osm/store: vector dimension mismatch (db has ${existing}, requested ${this.dim}). ` +
          `Run \`osm index --rebuild\` to reset, or restore the old config.`
      );
    }

    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS chunk_vectors
      USING vec0(
        chunk_id TEXT PRIMARY KEY,
        embedding FLOAT[${this.dim}]
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS chunk_fts
      USING fts5(
        chunk_id UNINDEXED,
        text,
        tokenize = 'unicode61 remove_diacritics 2'
      );
    `);

    this.setMeta("vec_dim", String(this.dim));
  }

  private recordEmbeddingModel(): void {
    const stored = this.getMeta("embedding_model_id");
    if (stored !== null && stored !== this.embeddingId) {
      throw new Error(
        `osm/store: embedding model mismatch (db has '${stored}', requested '${this.embeddingId}'). ` +
          `Run \`osm index --rebuild\` to switch.`
      );
    }
    this.setMeta("embedding_model_id", this.embeddingId);
  }

  /* ---------------- meta ---------------- */

  getMeta(key: string): string | null {
    const row = this.db
      .prepare("SELECT value FROM index_meta WHERE key = ?")
      .get(key) as { value: string } | undefined;
    return row ? row.value : null;
  }

  setMeta(key: string, value: string): void {
    this.db
      .prepare(
        `INSERT INTO index_meta(key, value) VALUES(?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`
      )
      .run(key, value);
  }

  /* ---------------- memories ---------------- */

  upsertMemory(m: Memory): void {
    this.db
      .prepare(
        `INSERT INTO memories
          (memory_id, memory_type, schema_version, timestamp,
           importance, confidence, status, source_kind, scope,
           project, channel, hash, json, updated_at)
         VALUES
          (@memory_id, @memory_type, @schema_version, @timestamp,
           @importance, @confidence, @status, @source_kind, @scope,
           @project, @channel, @hash, @json,
           strftime('%Y-%m-%dT%H:%M:%fZ','now'))
         ON CONFLICT(memory_id) DO UPDATE SET
           memory_type    = excluded.memory_type,
           schema_version = excluded.schema_version,
           timestamp      = excluded.timestamp,
           importance     = excluded.importance,
           confidence     = excluded.confidence,
           status         = excluded.status,
           source_kind    = excluded.source_kind,
           scope          = excluded.scope,
           project        = excluded.project,
           channel        = excluded.channel,
           hash           = excluded.hash,
           json           = excluded.json,
           updated_at     = strftime('%Y-%m-%dT%H:%M:%fZ','now')`
      )
      .run({
        memory_id: m.memoryId,
        memory_type: m.memoryType,
        schema_version: m.schemaVersion,
        timestamp: m.timestamp,
        importance: m.importance,
        confidence: m.confidence,
        status: m.status,
        source_kind: m.provenance.sourceKind,
        scope: m.scope,
        project: m.project ?? null,
        channel: m.channel ?? null,
        hash: m.hash,
        json: JSON.stringify(m),
      });
  }

  getMemoryById(id: string): Memory | null {
    const row = this.db
      .prepare("SELECT json FROM memories WHERE memory_id = ?")
      .get(id) as { json: string } | undefined;
    if (!row) return null;
    return JSON.parse(row.json) as Memory;
  }

  setMemoryStatus(id: string, status: MemoryStatus): void {
    this.db
      .prepare(
        `UPDATE memories
           SET status = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
         WHERE memory_id = ?`
      )
      .run(status, id);
  }

  countMemories(): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM memories")
      .get() as { n: number };
    return row.n;
  }

  /** Count memories grouped by status. */
  countMemoriesByStatus(): Record<string, number> {
    const rows = this.db
      .prepare("SELECT status, COUNT(*) AS n FROM memories GROUP BY status")
      .all() as Array<{ status: string; n: number }>;
    const out: Record<string, number> = {};
    for (const r of rows) out[r.status] = r.n;
    return out;
  }

  /** Count memories grouped by source_kind. */
  countMemoriesBySourceKind(): Record<string, number> {
    const rows = this.db
      .prepare(
        "SELECT source_kind, COUNT(*) AS n FROM memories GROUP BY source_kind"
      )
      .all() as Array<{ source_kind: string; n: number }>;
    const out: Record<string, number> = {};
    for (const r of rows) out[r.source_kind] = r.n;
    return out;
  }

  /** List chunks belonging to a memory. */
  listChunksByMemory(memoryId: string): ChunkRow[] {
    return this.db
      .prepare(
        `SELECT * FROM chunks WHERE memory_id = ? ORDER BY chunk_id`
      )
      .all(memoryId) as ChunkRow[];
  }

  /* ---------------- chunks ---------------- */

  upsertChunk(c: Chunk, embedding: number[]): void {
    if (embedding.length !== this.dim) {
      throw new Error(
        `osm/store: embedding length ${embedding.length} != configured dim ${this.dim}`
      );
    }

    const tx = this.db.transaction((chunk: Chunk, vec: number[]) => {
      this.db
        .prepare(
          `INSERT INTO chunks
            (chunk_id, memory_id, text, source_path,
             line_start, line_end, embedding_model_id, hash)
           VALUES
            (@chunk_id, @memory_id, @text, @source_path,
             @line_start, @line_end, @embedding_model_id, @hash)
           ON CONFLICT(chunk_id) DO UPDATE SET
             memory_id          = excluded.memory_id,
             text               = excluded.text,
             source_path        = excluded.source_path,
             line_start         = excluded.line_start,
             line_end           = excluded.line_end,
             embedding_model_id = excluded.embedding_model_id,
             hash               = excluded.hash`
        )
        .run({
          chunk_id: chunk.chunkId,
          memory_id: chunk.memoryId,
          text: chunk.text,
          source_path: chunk.sourcePath,
          line_start: chunk.lineStart ?? null,
          line_end: chunk.lineEnd ?? null,
          embedding_model_id: chunk.embeddingModelId,
          hash: chunk.hash,
        });

      // vec0 upsert pattern: delete-then-insert
      this.db
        .prepare("DELETE FROM chunk_vectors WHERE chunk_id = ?")
        .run(chunk.chunkId);
      this.db
        .prepare(
          "INSERT INTO chunk_vectors(chunk_id, embedding) VALUES(?, ?)"
        )
        .run(chunk.chunkId, new Float32Array(vec));

      // FTS5 upsert: same pattern.
      this.db
        .prepare("DELETE FROM chunk_fts WHERE chunk_id = ?")
        .run(chunk.chunkId);
      this.db
        .prepare("INSERT INTO chunk_fts(chunk_id, text) VALUES(?, ?)")
        .run(chunk.chunkId, chunk.text);
    });

    tx(c, embedding);
  }

  getChunkById(id: string): ChunkRow | null {
    const row = this.db
      .prepare("SELECT * FROM chunks WHERE chunk_id = ?")
      .get(id) as ChunkRow | undefined;
    return row ?? null;
  }

  /** Distinct memory ids that have at least one chunk (sampling helper). */
  listMemoryIdsWithChunks(): string[] {
    const rows = this.db
      .prepare("SELECT DISTINCT memory_id FROM chunks ORDER BY memory_id")
      .all() as Array<{ memory_id: string }>;
    return rows.map((r) => r.memory_id);
  }

  countChunks(): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM chunks")
      .get() as { n: number };
    return row.n;
  }

  /** Distinct embedding model ids referenced by current chunks. */
  listEmbeddingModelIds(): string[] {
    const rows = this.db
      .prepare(
        "SELECT DISTINCT embedding_model_id AS id FROM chunks ORDER BY id"
      )
      .all() as Array<{ id: string }>;
    return rows.map((r) => r.id);
  }

  /* ---------------- search ---------------- */

  vectorSearch(query: number[], k: number): VectorHit[] {
    if (query.length !== this.dim) {
      throw new Error(
        `osm/store: query embedding length ${query.length} != dim ${this.dim}`
      );
    }
    const rows = this.db
      .prepare(
        `SELECT chunk_id, distance
           FROM chunk_vectors
          WHERE embedding MATCH ?
          ORDER BY distance
          LIMIT ?`
      )
      .all(new Float32Array(query), k) as Array<{
      chunk_id: string;
      distance: number;
    }>;
    return rows.map((r) => ({ chunkId: r.chunk_id, distance: r.distance }));
  }

  lexicalSearch(query: string, k: number): LexicalHit[] {
    const ftsQuery = escapeFtsQuery(query);
    if (!ftsQuery) return [];
    const rows = this.db
      .prepare(
        `SELECT chunk_id, bm25(chunk_fts) AS rank
           FROM chunk_fts
          WHERE chunk_fts MATCH ?
          ORDER BY rank
          LIMIT ?`
      )
      .all(ftsQuery, k) as Array<{
      chunk_id: string;
      rank: number;
    }>;
    return rows.map((r) => ({ chunkId: r.chunk_id, rank: r.rank }));
  }

  /* ---------------- audit ---------------- */

  appendAudit(kind: AuditKind, payload: unknown): void {
    this.db
      .prepare("INSERT INTO audit(kind, payload_json) VALUES(?, ?)")
      .run(kind, JSON.stringify(payload));
  }

  /** Read recent audit rows of a given kind, newest first. */
  recentAudit(kind: AuditKind, limit: number): Array<{
    id: number;
    ts: string;
    kind: string;
    payload: unknown;
  }> {
    const rows = this.db
      .prepare(
        `SELECT id, ts, kind, payload_json
           FROM audit
          WHERE kind = ?
          ORDER BY id DESC
          LIMIT ?`
      )
      .all(kind, limit) as Array<{
      id: number;
      ts: string;
      kind: string;
      payload_json: string;
    }>;
    return rows.map((r) => ({
      id: r.id,
      ts: r.ts,
      kind: r.kind,
      payload: safeJson(r.payload_json),
    }));
  }

  /** Recent audit rows that referenced a specific memoryId. */
  recentAuditForMemory(
    memoryId: string,
    limit: number
  ): Array<{ id: number; ts: string; kind: string; payload: unknown }> {
    // We use json_extract / LIKE because audit payloads are JSON strings.
    const rows = this.db
      .prepare(
        `SELECT id, ts, kind, payload_json
           FROM audit
          WHERE payload_json LIKE ?
          ORDER BY id DESC
          LIMIT ?`
      )
      .all(`%${memoryId}%`, limit) as Array<{
      id: number;
      ts: string;
      kind: string;
      payload_json: string;
    }>;
    return rows.map((r) => ({
      id: r.id,
      ts: r.ts,
      kind: r.kind,
      payload: safeJson(r.payload_json),
    }));
  }

  /** Audit rows newer than a cutoff (inclusive), of an optional kind. */
  auditSince(
    cutoffIso: string,
    kind?: AuditKind
  ): Array<{ id: number; ts: string; kind: string; payload: unknown }> {
    const stmt = kind
      ? this.db.prepare(
          "SELECT id, ts, kind, payload_json FROM audit WHERE ts >= ? AND kind = ? ORDER BY id ASC"
        )
      : this.db.prepare(
          "SELECT id, ts, kind, payload_json FROM audit WHERE ts >= ? ORDER BY id ASC"
        );
    const rows = (kind
      ? stmt.all(cutoffIso, kind)
      : stmt.all(cutoffIso)) as Array<{
      id: number;
      ts: string;
      kind: string;
      payload_json: string;
    }>;
    return rows.map((r) => ({
      id: r.id,
      ts: r.ts,
      kind: r.kind,
      payload: safeJson(r.payload_json),
    }));
  }

  /** Most recent audit row of a given kind, or null. */
  latestAudit(kind: AuditKind): {
    id: number;
    ts: string;
    kind: string;
    payload: unknown;
  } | null {
    const rows = this.recentAudit(kind, 1);
    return rows[0] ?? null;
  }

  /* ---------------- lifecycle ---------------- */

  close(): void {
    this.db.close();
  }
}

/**
 * Build a safe FTS5 query string from arbitrary user input.
 *
 * Strategy:
 *   - tokenize on whitespace + most punctuation
 *   - drop tokens shorter than 2 chars
 *   - quote each token individually as a phrase (so FTS5 special chars
 *     like `:`, `*`, `+` don't trigger operator parsing)
 *   - join with FTS5 OR so any token can hit independently
 *
 * Result for `SSH 配置` becomes:  "SSH" OR "配置"
 *
 * If no tokens survive, returns an empty string and lexicalSearch should
 * skip the call.
 */
export function escapeFtsQuery(input: string): string {
  const tokens = input
    .split(/[\s,.;:!?()'"`，。；：！？（）]+/u)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2);

  if (tokens.length === 0) return "";

  return tokens
    .map((t) => `"${t.replace(/"/g, '""')}"`)
    .join(" OR ");
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}
