import type { EmbeddingFactoryOptions, EmbeddingProvider } from "./provider.js";
import { OpenAIEmbeddingProvider } from "./openai.js";
import { LocalStubEmbeddingProvider } from "./local.js";
import { LocalOnnxEmbeddingProvider } from "./local-onnx.js";

export type { EmbeddingProvider, EmbeddingFactoryOptions } from "./provider.js";
export { OpenAIEmbeddingProvider } from "./openai.js";
export { LocalStubEmbeddingProvider } from "./local.js";
export { LocalOnnxEmbeddingProvider } from "./local-onnx.js";

/**
 * Resolve an embedding provider from a config-shaped descriptor.
 *
 * Recognized providerIds:
 *   - "openai"     -> OpenAI-compatible HTTP API (Jeniya transit ok)
 *   - "local-onnx" -> @huggingface/transformers ONNX, runs locally
 *   - "local-stub" -> deterministic hash-based fake vectors (smoke tests only)
 *
 * Anything else throws.
 */
export function makeEmbeddingProvider(
  opts: EmbeddingFactoryOptions
): EmbeddingProvider {
  switch (opts.providerId) {
    case "openai":
      return new OpenAIEmbeddingProvider(opts);
    case "local-onnx":
      return new LocalOnnxEmbeddingProvider(opts);
    case "local-stub":
      return new LocalStubEmbeddingProvider(opts);
    default:
      throw new Error(
        `osm/embed: unknown providerId '${opts.providerId}'. ` +
          `Known: 'openai', 'local-onnx', 'local-stub'.`
      );
  }
}
