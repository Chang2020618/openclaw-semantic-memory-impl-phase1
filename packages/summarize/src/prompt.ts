/**
 * Summarizer prompt + parser.
 *
 * The LLM is expected to emit JSON only. We never trust the LLM enough to
 * return free-form prose; we trust it to fill a structured array.
 *
 * v0.2 hard guarantees:
 *   - confidence is clamped to [0.5, 0.8] regardless of what the LLM writes
 *   - importance is clamped to [0.0, 1.0]
 *   - secrets-pattern matching runs on every emitted summary and rawExcerpt;
 *     hits are dropped, not redacted
 */

export interface SummaryCandidate {
  type: "decision" | "fact" | "preference" | "episode";
  summary: string;
  rawExcerpt: string;
  timeStart: string;
  timeEnd: string;
  confidence: number;
  importance: number;
}

const SECRET_PATTERNS: RegExp[] = [
  /sk-[a-zA-Z0-9]{16,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /-----BEGIN [A-Z ]+PRIVATE KEY-----/,
  /\bxox[abp]-[A-Za-z0-9-]{10,}\b/,
  /\bghp_[A-Za-z0-9]{20,}\b/,
];

export const SUMMARIZER_SYSTEM_PROMPT = `You are a session summary assistant for OpenClaw Semantic Memory v0.2.
Your job: read a transcript between a USER and an ASSISTANT, and extract
durable memory candidates that would help recall the conversation later.

## Hard rules

1. Output ONLY a JSON array. No prose, no markdown fences, no commentary.
2. Each element has EXACTLY these keys: type, summary, rawExcerpt,
   timeStart, timeEnd, confidence, importance.
3. type ∈ ["decision", "fact", "preference", "episode"].
4. summary ≤ 300 Chinese characters or 600 English chars; self-contained,
   readable without the original transcript.
5. rawExcerpt ≤ 500 chars; verbatim quote that justifies this memory.
6. timeStart / timeEnd: ISO 8601 timestamps from the transcript headers.
7. confidence ∈ [0.5, 0.8]. Never write 1.0. Never write below 0.5.
8. importance ∈ [0.0, 1.0]. Reserve > 0.7 for project-defining decisions.
9. NEVER include API keys, tokens, passwords, private key material, or
   any \`sk-...\`, \`ghp_...\`, \`xox[abp]-...\`, AWS keys, or PEM blocks
   in summary or rawExcerpt. Skip a memory entirely if you cannot remove
   such content.
10. Skip greetings, acknowledgments, "ok", "thanks", and other social glue.
11. Do not invent details. If the transcript doesn't say it, don't write it.
12. Prefer fewer high-quality memories over many low-quality ones.

## What to extract

- decision: an explicit choice the USER made or the ASSISTANT recommended.
  Include rationale when present. Example: "Decision: use local-onnx
  embedding instead of OpenAI; reason: jeniya transit doesn't expose
  embedding endpoints and OpenClaw redacts API keys."

- fact: a concrete state, configuration, or learned constraint.
  Example: "OpenClaw session jsonl files live under
  /root/.openclaw/agents/<agent>/sessions/<sessionId>.jsonl with one
  type=message line per turn."

- preference: a stable USER preference revealed in conversation.
  Example: "User prefers Chinese replies, copy-pasteable commands, and
  minimal explanation."

- episode: a noteworthy event or troubleshooting outcome.
  Example: "chokidar v3/v4 inotify did not deliver events in the OpenClaw
  container; switched to native node:fs.watch with recursive: true."

## Output format

[
  {
    "type": "decision",
    "summary": "...",
    "rawExcerpt": "...",
    "timeStart": "2026-05-21T22:24:00Z",
    "timeEnd": "2026-05-21T22:30:00Z",
    "confidence": 0.7,
    "importance": 0.6
  }
]

Empty array \`[]\` is valid if nothing in the transcript merits memory.`;

export function buildSummarizerUserPrompt(transcript: string): string {
  return [
    "## Transcript",
    "",
    transcript,
    "",
    "## Task",
    "",
    "Extract durable memory candidates per the rules. Return a JSON array.",
  ].join("\n");
}

/**
 * Parse the LLM response into validated SummaryCandidate[].
 * Throws on JSON parse failure; silently drops malformed entries.
 */
export function parseSummaries(raw: string): SummaryCandidate[] {
  const stripped = stripCodeFences(raw).trim();
  if (stripped.length === 0) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped);
  } catch (err) {
    const rescued = tryParseJSONArray(stripped);
    if (rescued === null) {
      throw new Error(
        `osm/summarize: LLM did not return valid JSON: ${(err as Error).message}\n` +
          `Raw response (first 200 chars): ${stripped.slice(0, 200)}`
      );
    }
    parsed = rescued;
  }

  if (!Array.isArray(parsed)) {
    throw new Error("osm/summarize: LLM response was not a JSON array");
  }

  const out: SummaryCandidate[] = [];
  for (const entry of parsed) {
    if (typeof entry !== "object" || entry === null) continue;
    const e = entry as Record<string, unknown>;

    const type = e["type"];
    if (
      type !== "decision" &&
      type !== "fact" &&
      type !== "preference" &&
      type !== "episode"
    ) {
      continue;
    }

    const summary = typeof e["summary"] === "string" ? e["summary"] : null;
    const rawExcerpt =
      typeof e["rawExcerpt"] === "string" ? e["rawExcerpt"] : "";
    const timeStart = typeof e["timeStart"] === "string" ? e["timeStart"] : "";
    const timeEnd = typeof e["timeEnd"] === "string" ? e["timeEnd"] : "";

    if (!summary || summary.trim().length === 0) continue;

    if (containsSecret(summary) || containsSecret(rawExcerpt)) {
      // Hard drop. The prompt forbids this, but we double-check.
      continue;
    }

    const confidence = clamp(numOr(e["confidence"], 0.6), 0.5, 0.8);
    const importance = clamp(numOr(e["importance"], 0.4), 0, 1);

    out.push({
      type,
      summary: summary.trim(),
      rawExcerpt: rawExcerpt.trim(),
      timeStart,
      timeEnd,
      confidence,
      importance,
    });
  }
  return out;
}

function stripCodeFences(s: string): string {
  // Tolerate models that wrap output in ```json ... ``` despite instructions.
  const m = s.match(/^\s*```(?:json)?\s*([\s\S]*?)\s*```\s*$/u);
  return m ? (m[1] ?? "") : s;
}

function tryParseJSONArray(s: string): unknown[] | null {
  const start = s.indexOf("[");
  const end = s.lastIndexOf("]");
  if (start < 0 || end <= start) return null;
  const candidate = s.slice(start, end + 1);
  try {
    return JSON.parse(candidate) as unknown[];
  } catch {
    return null;
  }
}

function numOr(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function containsSecret(text: string): boolean {
  for (const re of SECRET_PATTERNS) {
    if (re.test(text)) return true;
  }
  return false;
}
