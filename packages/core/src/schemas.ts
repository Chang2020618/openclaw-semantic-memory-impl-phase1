/**
 * Zod validators for v0.1 schemas.
 *
 * These are runtime guards around the types in `./types.ts`. Any inbound JSON
 * that crosses a trust boundary (markdown ```memory``` blocks, config files,
 * audit replay) MUST be parsed through these.
 */

import { z } from "zod";
import { SCHEMA_VERSION } from "./types.js";

/* -------------------------------------------------------------------------- */
/* Enums                                                                      */
/* -------------------------------------------------------------------------- */

export const MemoryTypeSchema = z.enum([
  "episode",
  "fact",
  "decision",
  "preference",
  "procedure",
  "summary",
]);

export const SourceKindSchema = z.enum([
  "human_confirmed",
  "tool_observed",
  "compiled",
  "assistant_inferred",
]);

export const ScopeSchema = z.enum(["global", "project", "channel", "private"]);

export const MemoryStatusSchema = z.enum(["active", "superseded", "archived"]);

/* -------------------------------------------------------------------------- */
/* Provenance                                                                 */
/* -------------------------------------------------------------------------- */

export const ProvenanceSchema = z.object({
  path: z.string().min(1),
  lineStart: z.number().int().positive().optional(),
  lineEnd: z.number().int().positive().optional(),
  sourceKind: SourceKindSchema,
});

/* -------------------------------------------------------------------------- */
/* Memory base + per-type                                                     */
/* -------------------------------------------------------------------------- */

const MemoryBaseShape = {
  schemaVersion: z.literal(SCHEMA_VERSION),
  memoryId: z.string().min(1),
  timestamp: z.string().datetime({ offset: true }),
  importance: z.number().min(0).max(1),
  confidence: z.number().min(0).max(1),
  tags: z.array(z.string()),
  entities: z.array(z.string()),
  provenance: ProvenanceSchema,
  hash: z.string().min(1),
  status: MemoryStatusSchema,
  scope: ScopeSchema,
  project: z.string().optional(),
  channel: z.string().optional(),
};

export const EpisodeMemorySchema = z.object({
  ...MemoryBaseShape,
  memoryType: z.literal("episode"),
  summary: z.string().min(1),
  participants: z.array(z.string()),
  refs: z.array(z.string()).optional(),
});

export const FactMemorySchema = z.object({
  ...MemoryBaseShape,
  memoryType: z.literal("fact"),
  claim: z.string().min(1),
  truthStatus: z.enum(["current", "outdated", "disputed"]),
  supportingMemoryIds: z.array(z.string()),
  contradictedBy: z.array(z.string()),
});

export const DecisionMemorySchema = z.object({
  ...MemoryBaseShape,
  memoryType: z.literal("decision"),
  decision: z.string().min(1),
  rationale: z.string(),
  alternatives: z.array(z.string()),
});

export const PreferenceMemorySchema = z.object({
  ...MemoryBaseShape,
  memoryType: z.literal("preference"),
  preference: z.string().min(1),
  strength: z.number().min(0).max(1),
  evidenceCount: z.number().int().nonnegative(),
});

export const ProcedureMemorySchema = z.object({
  ...MemoryBaseShape,
  memoryType: z.literal("procedure"),
  title: z.string().min(1),
  steps: z.array(z.string()),
  prerequisites: z.array(z.string()),
  warnings: z.array(z.string()),
});

export const SummaryMemorySchema = z.object({
  ...MemoryBaseShape,
  memoryType: z.literal("summary"),
  title: z.string().min(1),
  body: z.string(),
  sourceMemoryIds: z.array(z.string()),
});

export const MemorySchema = z.discriminatedUnion("memoryType", [
  EpisodeMemorySchema,
  FactMemorySchema,
  DecisionMemorySchema,
  PreferenceMemorySchema,
  ProcedureMemorySchema,
  SummaryMemorySchema,
]);

/* -------------------------------------------------------------------------- */
/* Chunks                                                                     */
/* -------------------------------------------------------------------------- */

export const ChunkSchema = z.object({
  chunkId: z.string().min(1),
  memoryId: z.string().min(1),
  text: z.string(),
  sourcePath: z.string().min(1),
  lineStart: z.number().int().positive().optional(),
  lineEnd: z.number().int().positive().optional(),
  embeddingModelId: z.string().min(1),
  hash: z.string().min(1),
});

/* -------------------------------------------------------------------------- */
/* Configuration                                                              */
/* -------------------------------------------------------------------------- */

export const OsmConfigSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  embedding: z.object({
    providerId: z.string().min(1),
    modelId: z.string().min(1),
    dim: z.number().int().positive(),
  }),
  chunking: z.object({
    targetChars: z.number().int().positive(),
    softOverlapChars: z.number().int().nonnegative(),
    respectHeadings: z.boolean(),
  }),
  retrieval: z.object({
    topN: z.number().int().positive(),
    topK: z.number().int().positive(),
    minScore: z.number().min(0).max(1),
    fusion: z.enum(["rrf", "weighted"]),
    weights: z.record(z.string(), z.number()).nullable(),
  }),
  scope: z.object({
    defaultScope: ScopeSchema,
  }),
  audit: z.object({
    enabled: z.boolean(),
  }),
});

/* -------------------------------------------------------------------------- */
/* Inbound markdown ```memory``` block (relaxed subset)                       */
/* -------------------------------------------------------------------------- */

/**
 * Markdown-embedded memory blocks may be partial. The walker treats them as
 * hints, not authoritative records, and merges with extractor output.
 */
export const InlineMemoryHintSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION).optional(),
  memoryType: MemoryTypeSchema.optional(),
  memoryId: z.string().optional(),
  timestamp: z.string().optional(),
  importance: z.number().min(0).max(1).optional(),
  confidence: z.number().min(0).max(1).optional(),
  tags: z.array(z.string()).optional(),
  entities: z.array(z.string()).optional(),
  status: MemoryStatusSchema.optional(),
  scope: ScopeSchema.optional(),
  project: z.string().optional(),
  channel: z.string().optional(),
  provenance: ProvenanceSchema.partial().optional(),
});
