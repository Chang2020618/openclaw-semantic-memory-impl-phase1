/**
 * Phase-1 importance scoring.
 *
 * Crude on purpose. Real promotion / consolidation lives in Phase 3.
 * This scorer only decides "is this section worth indexing as a memorable
 * episode?" — not "is this a fact?".
 */

const DECISION_MARKERS = [
  // English
  /\bdecided\b/i,
  /\bwe (will|should|chose|picked|use)\b/i,
  /\bgo with\b/i,
  /\bfrom now on\b/i,
  // Chinese
  /决定/,
  /拍板/,
  /选定/,
  /以后默认/,
  /今后/,
  /统一约定/,
];

const REMEMBER_MARKERS = [
  /\bremember (this|that)\b/i,
  /\bdon't forget\b/i,
  /记住/,
  /记下/,
  /记一下/,
  /写入记忆/,
];

const NAMED_ENTITIES = [
  // Project / system names that show up frequently in this workspace.
  /openclaw/i,
  /salesradar/i,
  /content[- ]adapter/i,
  /pingui/i,
  /zxd000/i,
  /nafa/i,
  /jeniya/i,
  /flutter/i,
  /docker/i,
  /wsl/i,
];

const TIMESTAMP_RE = /\b(20\d{2}|19\d{2})[-/.](\d{1,2})[-/.](\d{1,2})\b/;

export interface ImportanceInputs {
  text: string;
  /** length of the source text, for length-based dampening */
  charCount: number;
}

export interface ImportanceBreakdown {
  score: number;
  signals: string[];
}

export function scoreImportance(input: ImportanceInputs): ImportanceBreakdown {
  let score = 0.4;
  const signals: string[] = ["baseline:0.40"];

  if (matchAny(input.text, DECISION_MARKERS)) {
    score += 0.2;
    signals.push("decision:+0.20");
  }
  if (matchAny(input.text, REMEMBER_MARKERS)) {
    score += 0.25;
    signals.push("remember:+0.25");
  }

  const entityHits = countMatches(input.text, NAMED_ENTITIES);
  if (entityHits > 0) {
    const bump = Math.min(0.15, 0.05 * entityHits);
    score += bump;
    signals.push(`entities(${entityHits}):+${bump.toFixed(2)}`);
  }

  if (TIMESTAMP_RE.test(input.text)) {
    score += 0.05;
    signals.push("timestamp:+0.05");
  }

  if (input.charCount < 80) {
    score -= 0.2;
    signals.push("too_short:-0.20");
  }

  // clamp
  if (score < 0) score = 0;
  if (score > 1) score = 1;

  return { score: round3(score), signals };
}

function matchAny(text: string, patterns: RegExp[]): boolean {
  for (const re of patterns) {
    if (re.test(text)) return true;
  }
  return false;
}

function countMatches(text: string, patterns: RegExp[]): number {
  let n = 0;
  for (const re of patterns) {
    if (re.test(text)) n += 1;
  }
  return n;
}

function round3(x: number): number {
  return Math.round(x * 1000) / 1000;
}
