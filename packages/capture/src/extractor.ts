/**
 * Markdown -> Memory candidates.
 *
 * Phase-1 strategy:
 *   - read the file
 *   - split into top-level sections by H1/H2 (we treat H1 as the "file root"
 *     and produce one episode per H2; if no H2s exist, produce one episode
 *     for the whole file)
 *   - extract a summary (the first non-heading non-empty line of the section)
 *   - assign sourceKind = human_confirmed for files under the user's
 *     workspace `memory/` (everything we walk in v0.1)
 *   - compute importance via the heuristic scorer
 *   - hash canonical text for change detection
 *   - leave promotion (fact/decision/preference/procedure) for Phase 3
 *
 * If the section contains a fenced ```memory``` block, we PARSE it as a hint
 * that may override memoryType, importance, tags, etc. The hint is treated
 * as `human_confirmed` because the user (or a previous trusted writer)
 * placed it there explicitly.
 */

import {
  SCHEMA_VERSION,
  canonicalize,
  contentHash,
  memoryId,
  type EpisodeMemory,
  type Memory,
  type MemoryStatus,
  type Provenance,
  type Scope,
  type SourceKind,
} from "@osm/core";
import { InlineMemoryHintSchema } from "@osm/core";

import { scoreImportance } from "./importance.js";

export interface ExtractOptions {
  /** Path of the file relative to memory root, used in provenance. */
  relPath: string;
  /** Raw markdown content of the file. */
  source: string;
  /** Default scope for this file. */
  defaultScope?: Scope;
  /** Default project tag, if known. */
  project?: string;
  /** Default channel, if known. */
  channel?: string;
  /** ISO timestamp to use when section has no embedded date. */
  fallbackTimestamp: string;
  /** Default sourceKind for sections without a hint block. */
  defaultSourceKind?: SourceKind;
}

export interface ExtractedSection {
  memory: Memory;
  /** The raw text that produced this memory (used for chunking later). */
  rawText: string;
  /** 1-based line range in the source file. */
  lineStart: number;
  lineEnd: number;
}

/**
 * Run the extractor. Returns ordered sections, in file order.
 *
 * For Phase 1 we ONLY produce `episode` memories. The hint block can name a
 * different memoryType, but we currently silently coerce to `episode` if the
 * hinted type would require fields we cannot reliably extract (e.g. `claim`
 * for a fact, `decision` for a decision). This keeps Phase-1 trust posture
 * correct: we never invent the missing fields.
 */
export function extractMemoriesFromMarkdown(
  opts: ExtractOptions
): ExtractedSection[] {
  const lines = opts.source.split(/\r?\n/);
  const sections = sliceTopLevelSections(lines);
  const out: ExtractedSection[] = [];

  for (const section of sections) {
    const sectionText = section.lines.join("\n");
    const canonical = canonicalize(sectionText);
    if (canonical.length === 0) continue;

    const hint = extractHintBlock(sectionText);
    const summary = extractSummary(section.lines);
    const ts = pickTimestamp(section.title, sectionText, hint?.timestamp ?? null, opts.fallbackTimestamp);
    const importance = scoreImportance({
      text: sectionText,
      charCount: sectionText.length,
    });

    const sourceKind: SourceKind =
      hint && (hint as Record<string, unknown>)["sourceKind"]
        ? ((hint as { sourceKind?: SourceKind }).sourceKind ??
          opts.defaultSourceKind ??
          "human_confirmed")
        : opts.defaultSourceKind ?? "human_confirmed";

    const provenance: Provenance = {
      path: opts.relPath,
      lineStart: section.lineStart,
      lineEnd: section.lineEnd,
      sourceKind,
    };

    const hash = contentHash(sectionText);
    const anchor = section.title || `lines:${section.lineStart}-${section.lineEnd}`;
    const id = hint?.memoryId
      ? hint.memoryId
      : memoryId({
          memoryType: "episode",
          sourcePath: opts.relPath,
          anchor,
          contentHash: hash,
        });

    const status: MemoryStatus = hint?.status ?? "active";
    const scope: Scope = hint?.scope ?? opts.defaultScope ?? "global";
    const tags = hint?.tags ?? [];
    const entities = hint?.entities ?? [];

    const memory: EpisodeMemory = {
      schemaVersion: SCHEMA_VERSION,
      memoryId: id,
      memoryType: "episode",
      timestamp: ts,
      importance: hint?.importance ?? importance.score,
      confidence: hint?.confidence ?? 1.0,
      tags,
      entities,
      provenance,
      hash,
      status,
      scope,
      project: hint?.project ?? opts.project,
      channel: hint?.channel ?? opts.channel,
      summary,
      participants: ["user", "assistant"],
    };

    out.push({
      memory,
      rawText: sectionText,
      lineStart: section.lineStart,
      lineEnd: section.lineEnd,
    });
  }

  return out;
}

/* -------------------------------------------------------------------------- */
/* Section slicing                                                            */
/* -------------------------------------------------------------------------- */

interface RawSection {
  title: string;
  lineStart: number;
  lineEnd: number;
  lines: string[];
}

const HEADING_RE = /^(#{1,6})\s+(.+?)\s*#*\s*$/;

/**
 * Split the file into top-level sections. We define "top-level" as H2; if
 * no H2 exists, the whole file becomes one section with title from the H1
 * (or the file name).
 */
function sliceTopLevelSections(lines: string[]): RawSection[] {
  const sections: RawSection[] = [];
  let current: RawSection | null = null;

  const closeSection = (lineEnd: number): void => {
    if (!current) return;
    current.lineEnd = lineEnd;
    sections.push(current);
    current = null;
  };

  for (let i = 0; i < lines.length; i += 1) {
    const ln = i + 1;
    const line = lines[i]!;
    const m = HEADING_RE.exec(line);
    if (m && m[1]!.length === 2) {
      // H2 boundary
      closeSection(i); // previous section ends just before this heading
      const newSection: RawSection = {
        title: m[2]!.trim(),
        lineStart: ln,
        lineEnd: ln,
        lines: [line],
      };
      current = newSection;
      continue;
    }
    if (current) {
      current.lines.push(line);
    } else {
      // Pre-section material (e.g. H1 + intro). Bucket into a virtual section
      // titled by the H1 if we see one, else "(top)".
      if (sections.length === 0) {
        const firstHeading = HEADING_RE.exec(line);
        const title =
          firstHeading && firstHeading[1]!.length === 1
            ? firstHeading[2]!.trim()
            : "(top)";
        const newSection: RawSection = {
          title,
          lineStart: ln,
          lineEnd: ln,
          lines: [line],
        };
        current = newSection;
      } else {
        // Trailing content after we already closed everything; ignore.
      }
    }
  }
  closeSection(lines.length);

  // Drop empty/whitespace-only sections.
  return sections.filter((s) => s.lines.some((l) => l.trim().length > 0));
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

function extractSummary(lines: string[]): string {
  for (const line of lines) {
    if (HEADING_RE.test(line)) continue;
    const t = line.trim();
    if (t.length === 0) continue;
    // Strip leading list markers / dashes.
    const cleaned = t.replace(/^[-*+]\s+/, "").replace(/^\d+\.\s+/, "");
    return cleaned.slice(0, 200);
  }
  return "(empty section)";
}

function extractHintBlock(text: string): {
  memoryId?: string;
  memoryType?: string;
  timestamp?: string;
  importance?: number;
  confidence?: number;
  tags?: string[];
  entities?: string[];
  status?: MemoryStatus;
  scope?: Scope;
  project?: string;
  channel?: string;
  sourceKind?: SourceKind;
} | null {
  const fence = /```memory\s*\n([\s\S]*?)\n```/m.exec(text);
  if (!fence) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(fence[1]!);
  } catch {
    return null;
  }
  const result = InlineMemoryHintSchema.safeParse(parsed);
  if (!result.success) return null;

  const data = result.data as Record<string, unknown>;
  const out: ReturnType<typeof extractHintBlock> = {};
  for (const k of [
    "memoryId",
    "memoryType",
    "timestamp",
    "importance",
    "confidence",
    "tags",
    "entities",
    "status",
    "scope",
    "project",
    "channel",
  ]) {
    if (data[k] !== undefined) (out as Record<string, unknown>)[k] = data[k];
  }
  if (data["provenance"] && typeof data["provenance"] === "object") {
    const prov = data["provenance"] as Record<string, unknown>;
    if (typeof prov["sourceKind"] === "string") {
      (out as Record<string, unknown>)["sourceKind"] = prov["sourceKind"];
    }
  }
  return out;
}

function pickTimestamp(
  title: string,
  text: string,
  hinted: string | null,
  fallback: string
): string {
  if (hinted) return hinted;

  // Try ISO-shaped dates inside the title or the text.
  const re = /\b(20\d{2})[-/](\d{1,2})[-/](\d{1,2})\b/;
  const m = re.exec(title) ?? re.exec(text);
  if (m) {
    const y = m[1]!.padStart(4, "0");
    const mo = m[2]!.padStart(2, "0");
    const d = m[3]!.padStart(2, "0");
    return `${y}-${mo}-${d}T00:00:00.000Z`;
  }
  return fallback;
}
