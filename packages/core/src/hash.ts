/**
 * Stable hashing helpers used to detect change between markdown content and
 * what the index already has.
 *
 * Hard rule (v0.1): hashes are computed on canonical text only — never on
 * embedding-related metadata or provider responses.
 */

import { createHash } from "node:crypto";

/** sha256 hex of the input string. */
export function sha256(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/**
 * Canonicalize a piece of memory text before hashing.
 *
 * - normalize line endings to \n
 * - strip trailing whitespace per line
 * - collapse runs of blank lines
 * - trim leading/trailing whitespace
 *
 * This is intentionally simple. Anything fancier (e.g. unicode normalization,
 * bidi handling) is deferred until we measure a real failure caused by it.
 */
export function canonicalize(text: string): string {
  const normalized = text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/u, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return normalized;
}

/** Convenience: canonicalize then sha256. */
export function contentHash(text: string): string {
  return sha256(canonicalize(text));
}
