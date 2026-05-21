/**
 * OpenClaw session.jsonl normalizer.
 *
 * Reads `~/.openclaw/agents/<agent>/sessions/<sessionId>.jsonl` and emits a
 * trimmed, human-readable transcript suitable for an LLM summarizer.
 *
 * Hard rules:
 *   - never emit tool arguments verbatim (could contain secrets, paths)
 *   - never emit toolResult payloads (large, low-signal)
 *   - drop assistant text turns that are only a tool-call wrapper with no text
 *   - keep first + last turns even when budget tightens; middle is sample-dropped
 *
 * The output is plain UTF-8 text suitable for templating into a prompt.
 */

import { readFileSync, existsSync } from "node:fs";

export interface TranscriptTurn {
  role: "user" | "assistant" | "system";
  /** ISO 8601. */
  timestamp: string;
  text: string;
  /** Brief, signal-only tool names invoked in this turn (no args). */
  toolNames?: string[];
}

export interface TranscriptOptions {
  /** Inclusive lower bound (ISO 8601). */
  start?: string;
  /** Inclusive upper bound (ISO 8601). */
  end?: string;
  /**
   * Approximate character budget for the rendered output. We trim the
   * middle of the transcript when the budget is exceeded.
   */
  maxChars?: number;
  /** Skip turns whose text is shorter than this after trimming. */
  minTurnChars?: number;
}

export interface NormalizedTranscript {
  sessionId: string;
  turns: TranscriptTurn[];
  /** ISO 8601 of the first kept turn. */
  startTs: string;
  /** ISO 8601 of the last kept turn. */
  endTs: string;
  /** True when middle turns were dropped to meet the budget. */
  trimmed: boolean;
  /** Final rendered text. */
  text: string;
}

const DEFAULT_MAX_CHARS = 60_000;
const DEFAULT_MIN_TURN_CHARS = 4;

interface RawMessage {
  type?: string;
  timestamp?: string;
  message?: {
    role?: "user" | "assistant" | "system" | "toolResult";
    content?: Array<
      | { type: "text"; text?: string }
      | { type: "toolCall"; toolCall?: { name?: string } }
      | { type: string; [k: string]: unknown }
    >;
    timestamp?: number;
  };
}

/**
 * Read a session jsonl file and return a normalized transcript.
 */
export function loadSessionTranscript(
  sessionFile: string,
  opts: TranscriptOptions = {}
): NormalizedTranscript {
  if (!existsSync(sessionFile)) {
    throw new Error(`osm/summarize: session file not found: ${sessionFile}`);
  }
  const raw = readFileSync(sessionFile, "utf8");

  const sessionId = inferSessionId(sessionFile, raw);

  const allTurns: TranscriptTurn[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    let parsed: RawMessage;
    try {
      parsed = JSON.parse(trimmed) as RawMessage;
    } catch {
      continue;
    }
    if (parsed.type !== "message") continue;
    const msg = parsed.message;
    if (!msg) continue;

    const role = msg.role;
    if (role !== "user" && role !== "assistant" && role !== "system") continue;

    const ts = parsed.timestamp ?? "";
    if (opts.start && ts && ts < opts.start) continue;
    if (opts.end && ts && ts > opts.end) continue;

    const { text, toolNames } = flattenContent(msg.content);

    const cleaned = stripUiNoise(text).trim();
    if (cleaned.length < (opts.minTurnChars ?? DEFAULT_MIN_TURN_CHARS)) {
      // For assistant: keep when there's a tool call even with no text, so
      // the summarizer can see "the assistant invoked tool X". For user/
      // system: drop empty turns entirely.
      if (role === "assistant" && toolNames && toolNames.length > 0) {
        allTurns.push({
          role,
          timestamp: ts,
          text: "",
          toolNames,
        });
      }
      continue;
    }

    const turn: TranscriptTurn = {
      role,
      timestamp: ts,
      text: cleaned,
    };
    if (toolNames && toolNames.length > 0) turn.toolNames = toolNames;
    allTurns.push(turn);
  }

  if (allTurns.length === 0) {
    return {
      sessionId,
      turns: [],
      startTs: "",
      endTs: "",
      trimmed: false,
      text: "",
    };
  }

  const budget = opts.maxChars ?? DEFAULT_MAX_CHARS;
  const { turns, trimmed } = applyBudget(allTurns, budget);
  const rendered = renderTranscript(turns);

  return {
    sessionId,
    turns,
    startTs: turns[0]!.timestamp,
    endTs: turns[turns.length - 1]!.timestamp,
    trimmed,
    text: rendered,
  };
}

function inferSessionId(filePath: string, raw: string): string {
  // Most reliable: first "session" line carries the id.
  const firstLine = raw.split(/\r?\n/, 1)[0]?.trim();
  if (firstLine) {
    try {
      const o = JSON.parse(firstLine) as { type?: string; id?: string };
      if (o.type === "session" && typeof o.id === "string") return o.id;
    } catch {
      // ignore
    }
  }
  // Fallback: parse from filename.
  const base = filePath.split("/").pop() ?? filePath;
  return base.replace(/\.jsonl$/u, "");
}

function flattenContent(
  content: NonNullable<RawMessage["message"]>["content"]
): { text: string; toolNames: string[] } {
  if (!Array.isArray(content)) return { text: "", toolNames: [] };

  const texts: string[] = [];
  const toolNames: string[] = [];
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    const p = part as Record<string, unknown>;
    const t = p["type"];
    if (t === "text" && typeof p["text"] === "string") {
      texts.push(p["text"] as string);
    } else if (t === "toolCall") {
      const tc = p["toolCall"] as { name?: string } | undefined;
      const name = tc?.name ?? (p["name"] as string | undefined);
      if (typeof name === "string" && name.length > 0) toolNames.push(name);
    }
  }
  return { text: texts.join("\n"), toolNames };
}

/**
 * Strip OpenClaw UI artifacts the user / agent didn't actually type:
 *   - leading `[Thu 2026-05-21 06:30 UTC]` envelope on user messages
 *   - `MEDIA:` and `[[reply_to_current]]` directives
 */
function stripUiNoise(text: string): string {
  let t = text;
  t = t.replace(/^\s*\[(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+\d{4}-\d{2}-\d{2}[^\]]+\]\s*/u, "");
  t = t.replace(/^MEDIA:.*$/gmu, "");
  t = t.replace(/^\[\[[a-zA-Z_:0-9-]+\]\]\s*$/gmu, "");
  return t;
}

/**
 * Trim the middle of the transcript until total chars <= budget. Keep the
 * first 25% and last 25% intact; in the middle, drop every other turn until
 * we fit.
 */
function applyBudget(
  turns: TranscriptTurn[],
  budget: number
): { turns: TranscriptTurn[]; trimmed: boolean } {
  const total = turns.reduce((acc, t) => acc + t.text.length + 64, 0);
  if (total <= budget || turns.length <= 4) {
    return { turns, trimmed: false };
  }

  const headCount = Math.max(2, Math.floor(turns.length * 0.25));
  const tailCount = Math.max(2, Math.floor(turns.length * 0.25));
  const head = turns.slice(0, headCount);
  const tail = turns.slice(turns.length - tailCount);
  const middle = turns.slice(headCount, turns.length - tailCount);

  // Sample-drop every other middle turn until budget fits.
  let keepMiddle = middle.slice();
  let trimmed = false;
  while (
    headCount + tailCount + keepMiddle.length > 0 &&
    head.concat(keepMiddle, tail).reduce((a, t) => a + t.text.length + 64, 0) >
      budget &&
    keepMiddle.length > 0
  ) {
    keepMiddle = keepMiddle.filter((_, i) => i % 2 === 0);
    trimmed = true;
    if (keepMiddle.length === 0) break;
  }

  return {
    turns: [...head, ...keepMiddle, ...tail],
    trimmed,
  };
}

function renderTranscript(turns: TranscriptTurn[]): string {
  const lines: string[] = [];
  for (const t of turns) {
    const tag = t.role.toUpperCase();
    const ts = t.timestamp ? ` ${t.timestamp}` : "";
    const tools =
      t.toolNames && t.toolNames.length > 0
        ? `  [tools: ${t.toolNames.join(", ")}]`
        : "";
    if (t.text.length === 0 && tools) {
      lines.push(`[${tag}${ts}]${tools}`);
    } else {
      lines.push(`[${tag}${ts}]${tools}`);
      lines.push(t.text);
    }
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}
