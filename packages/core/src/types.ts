/**
 * @osm/core — types and contracts for OpenClaw Semantic Memory v0.1.
 *
 * Mirrors `openclaw-semantic-memory/docs/07-schemas.md`. Locked for v0.1.
 */

export const SCHEMA_VERSION = 1 as const;

/* -------------------------------------------------------------------------- */
/* Enums                                                                      */
/* -------------------------------------------------------------------------- */

export type MemoryType =
  | "episode"
  | "fact"
  | "decision"
  | "preference"
  | "procedure"
  | "summary";

export type SourceKind =
  | "human_confirmed"
  | "tool_observed"
  | "compiled"
  | "assistant_inferred";

export type Scope = "global" | "project" | "channel" | "private";

export type MemoryStatus = "active" | "superseded" | "archived";

/* -------------------------------------------------------------------------- */
/* Provenance                                                                 */
/* -------------------------------------------------------------------------- */

export interface Provenance {
  /** Path relative to the workspace memory root, e.g. "MEMORY.md" or "memory/2026-05-21.md". */
  path: string;
  lineStart?: number;
  lineEnd?: number;
  sourceKind: SourceKind;
}

/* -------------------------------------------------------------------------- */
/* Memory base + per-type                                                     */
/* -------------------------------------------------------------------------- */

export interface MemoryBase {
  schemaVersion: typeof SCHEMA_VERSION;
  memoryId: string;
  memoryType: MemoryType;
  /** ISO-8601 timestamp. */
  timestamp: string;
  /** 0..1 */
  importance: number;
  /** 0..1 */
  confidence: number;
  tags: string[];
  entities: string[];
  provenance: Provenance;
  /** sha256 hex of canonical content. */
  hash: string;
  status: MemoryStatus;
  /** v0.1 default: "global". */
  scope: Scope;
  project?: string;
  channel?: string;
}

export interface EpisodeMemory extends MemoryBase {
  memoryType: "episode";
  summary: string;
  participants: string[];
  refs?: string[];
}

export interface FactMemory extends MemoryBase {
  memoryType: "fact";
  claim: string;
  truthStatus: "current" | "outdated" | "disputed";
  supportingMemoryIds: string[];
  contradictedBy: string[];
}

export interface DecisionMemory extends MemoryBase {
  memoryType: "decision";
  decision: string;
  rationale: string;
  alternatives: string[];
}

export interface PreferenceMemory extends MemoryBase {
  memoryType: "preference";
  preference: string;
  strength: number;
  evidenceCount: number;
}

export interface ProcedureMemory extends MemoryBase {
  memoryType: "procedure";
  title: string;
  steps: string[];
  prerequisites: string[];
  warnings: string[];
}

export interface SummaryMemory extends MemoryBase {
  memoryType: "summary";
  title: string;
  body: string;
  sourceMemoryIds: string[];
}

export type Memory =
  | EpisodeMemory
  | FactMemory
  | DecisionMemory
  | PreferenceMemory
  | ProcedureMemory
  | SummaryMemory;

/* -------------------------------------------------------------------------- */
/* Chunks                                                                     */
/* -------------------------------------------------------------------------- */

export interface Chunk {
  chunkId: string;
  memoryId: string;
  text: string;
  sourcePath: string;
  lineStart?: number;
  lineEnd?: number;
  embeddingModelId: string;
  hash: string;
}

/* -------------------------------------------------------------------------- */
/* Retrieval                                                                  */
/* -------------------------------------------------------------------------- */

export interface RetrievalQuery {
  text: string;
  scope?: {
    project?: string;
    channel?: string;
    timeRangeDays?: number;
    types?: MemoryType[];
    onlyStatuses?: MemoryStatus[];
    onlySourceKinds?: SourceKind[];
  };
  topK?: number;
  /** Hard floor on per-result composite score after fusion. */
  minScore?: number;
}

export type WhyMatched =
  | "semantic_similarity"
  | "lexical_match"
  | "recent_within_30d"
  | "high_importance"
  | "human_confirmed"
  | `project_match:${string}`
  | `lexical_match:${string}`;

export interface RetrievalResult {
  memoryId: string;
  memoryType: MemoryType;
  summary: string;
  /** Path-anchored citation, e.g. "memory/2026-05-21.md#L33-L36". */
  citation: string;
  score: number;
  whyMatched: WhyMatched[];
  confidence: number;
}

export interface RetrievalResponse {
  query: string;
  results: RetrievalResult[];
}

/* -------------------------------------------------------------------------- */
/* Capture                                                                    */
/* -------------------------------------------------------------------------- */

export type CaptureSource =
  | "user_message"
  | "assistant_reply"
  | "tool_output"
  | "file_edit"
  | "manual"
  | "markdown_walk";

export interface CaptureInput {
  source: CaptureSource;
  text: string;
  /** ISO-8601. */
  timestamp: string;
  context?: {
    project?: string;
    channel?: string;
    sessionId?: string;
  };
  provenance: Provenance;
}

/* -------------------------------------------------------------------------- */
/* Audit                                                                      */
/* -------------------------------------------------------------------------- */

export type AuditKind =
  | "capture"
  | "retrieve"
  | "inject"
  | "rebuild"
  | "health"
  | "explain"
  | "summarize"
  | "ephemeral_expire";

export interface AuditRecord {
  ts: string;
  kind: AuditKind;
  payload: unknown;
}

/* -------------------------------------------------------------------------- */
/* Ephemeral memory (Phase-2: session summaries)                              */
/* -------------------------------------------------------------------------- */

/**
 * Phase-2 introduces "ephemeral" memories: short-lived, AI-written records
 * derived from session transcripts. Hard rules baked into the type system
 * and the SQL schema:
 *
 *   * sourceKind is ALWAYS "assistant_inferred"
 *   * confidence is ALWAYS < 1.0 (typically 0.5..0.8)
 *   * expiresAt is REQUIRED
 *   * citation is a `session://<sessionId>#range=...` URI, not a markdown path
 *   * ephemeral memories live in `ephemeral_memories` / `ephemeral_chunks`,
 *     never in `memories` / `chunks` / `chunk_vectors`
 *
 * Promotion to a persistent Memory is a v0.3 feature; v0.2 ships read+write
 * for ephemeral but no promotion path.
 */
export interface EphemeralMemory {
  schemaVersion: typeof SCHEMA_VERSION;
  memoryId: string;
  /** Which OpenClaw session this came from. */
  sessionId: string;
  memoryType: "episode" | "decision" | "fact" | "preference" | "summary";
  summary: string;
  importance: number;
  /** 0.0 .. 0.99; clamped at index time. */
  confidence: number;
  /** `session://<sessionId>#range=<isoStart>-<isoEnd>` */
  citation: string;
  /** Original transcript excerpt that backed this memory (optional, audit-only). */
  rawExcerpt?: string;
  scope: Scope;
  status: "active" | "expired";
  /** ISO 8601. */
  createdAt: string;
  /** ISO 8601. */
  expiresAt: string;
  hash: string;
  /** Always "assistant_inferred" — kept explicit for clarity at call sites. */
  sourceKind: "assistant_inferred";
}

export interface EphemeralChunk {
  chunkId: string;
  memoryId: string;
  text: string;
  embeddingModelId: string;
  hash: string;
  /** ISO 8601, mirrors the parent memory. */
  expiresAt: string;
}

/* -------------------------------------------------------------------------- */
/* Configuration                                                              */
/* -------------------------------------------------------------------------- */

export interface OsmConfig {
  schemaVersion: typeof SCHEMA_VERSION;
  embedding: {
    providerId: string;
    modelId: string;
    dim: number;
  };
  chunking: {
    targetChars: number;
    softOverlapChars: number;
    respectHeadings: boolean;
  };
  retrieval: {
    topN: number;
    topK: number;
    minScore: number;
    fusion: "rrf" | "weighted";
    weights: Record<string, number> | null;
  };
  scope: {
    defaultScope: Scope;
  };
  audit: {
    enabled: boolean;
  };
  /** Phase-2 ephemeral (session summary) layer. */
  ephemeral?: {
    /** Default TTL for newly-ingested summaries, in days. */
    ttlDays: number;
    /** Retrieval weight (vs persistent = 1.0). Recommended 0.85. */
    retrievalWeight: number;
    /** Minimum confidence to surface in retrieval. */
    minConfidence: number;
    /** Summarizer model alias (resolved against OpenClaw). */
    summarizerModel: string;
  };
}

export const DEFAULT_CONFIG: OsmConfig = {
  schemaVersion: SCHEMA_VERSION,
  embedding: {
    providerId: "openai",
    modelId: "text-embedding-3-small",
    dim: 1536,
  },
  chunking: {
    targetChars: 900,
    softOverlapChars: 150,
    respectHeadings: true,
  },
  retrieval: {
    topN: 40,
    topK: 5,
    minScore: 0.0,
    fusion: "rrf",
    weights: null,
  },
  scope: {
    defaultScope: "global",
  },
  audit: {
    enabled: true,
  },
  ephemeral: {
    ttlDays: 90,
    retrievalWeight: 0.85,
    minConfidence: 0.5,
    summarizerModel: "jeniya/gpt-5.4-mini",
  },
};
