/**
 * Quick smoke test for the markdown chunker. Not a real test framework yet —
 * just a script we can run with tsx to eyeball output.
 *
 * Run:  pnpm tsx scripts/smoke-chunker.ts
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { chunkMarkdown } from "../packages/chunker/src/index.js";

const path = resolve(process.argv[2] ?? "/root/.openclaw/workspace/MEMORY.md");
const source = readFileSync(path, "utf8");

const chunks = chunkMarkdown(source, {
  targetChars: 900,
  softOverlapChars: 150,
  respectHeadings: true,
});

console.log(`source: ${path}`);
console.log(`chars:  ${source.length}`);
console.log(`chunks: ${chunks.length}`);
console.log("");

for (const [i, c] of chunks.slice(0, 5).entries()) {
  console.log(`--- chunk ${i + 1}/${chunks.length} ---`);
  console.log(`heading: ${c.headingPath.join(" > ") || "(none)"}`);
  console.log(`lines:   ${c.lineStart}-${c.lineEnd}`);
  console.log(`chars:   ${c.text.length}`);
  console.log(c.text.slice(0, 240).replace(/\n/g, " ⏎ "));
  console.log("");
}

const sizes = chunks.map((c) => c.text.length);
const avg = sizes.reduce((a, b) => a + b, 0) / Math.max(sizes.length, 1);
const max = Math.max(0, ...sizes);
const min = sizes.length ? Math.min(...sizes) : 0;
console.log(`size stats: avg=${avg.toFixed(0)} min=${min} max=${max}`);
