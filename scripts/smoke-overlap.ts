import { chunkMarkdown } from "../packages/chunker/src/index.js";
import { readFileSync } from "node:fs";

const src = readFileSync("/tmp/osm-overlap-test.md", "utf8");
const chunks = chunkMarkdown(src, {
  targetChars: 80,
  softOverlapChars: 25,
  respectHeadings: true,
});
for (const [i, c] of chunks.entries()) {
  console.log(
    `[${i}] L${c.lineStart}-L${c.lineEnd} (${c.text.length}c) path=${c.headingPath.join(" > ")}`
  );
  console.log(c.text);
  console.log("---");
}
