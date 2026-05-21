/**
 * Local stub embedding provider.
 *
 * Phase 1 ships this as an interface placeholder so users can plug a real
 * local model later (fastembed-ts, transformers.js, sentence-transformers
 * via a sidecar, etc.) without changing the rest of the system.
 *
 * The default implementation is a deterministic *fake* embedder that hashes
 * the input into a vector of the configured dimension. It is useful for
 * smoke tests but MUST NOT be used in production: the vectors carry no
 * semantic information.
 */

import { createHash } from "node:crypto";

import type { EmbeddingFactoryOptions, EmbeddingProvider } from "./provider.js";

export class LocalStubEmbeddingProvider implements EmbeddingProvider {
  readonly id: string;
  readonly dim: number;

  constructor(opts: EmbeddingFactoryOptions) {
    this.id = `${opts.providerId}:${opts.modelId}`;
    this.dim = opts.dim;
  }

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((t) => fakeVector(t, this.dim));
  }
}

/** Deterministic per-text fake vector; values in [-1, 1]. */
function fakeVector(text: string, dim: number): number[] {
  const out = new Array<number>(dim);
  // Cycle multiple sha256 digests of (i || text) to fill `dim` floats.
  let cursor = 0;
  let counter = 0;
  while (cursor < dim) {
    const h = createHash("sha256")
      .update(`${counter}\u0000${text}`)
      .digest();
    for (let i = 0; i < h.length && cursor < dim; i += 4) {
      const v = h.readInt32LE(i);
      out[cursor] = v / 0x7fffffff; // [-1, 1]
      cursor += 1;
    }
    counter += 1;
  }
  return out;
}
