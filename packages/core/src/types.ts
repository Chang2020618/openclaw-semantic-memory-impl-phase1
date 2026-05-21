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
  | "explain";

export interface AuditRecord {
  ts: string;
  kind: AuditKind;
  payload: unknown;
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
};
