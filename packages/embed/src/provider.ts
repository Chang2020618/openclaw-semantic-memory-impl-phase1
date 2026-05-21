/**
 * Embedding provider contract.
 *
 * The contract is intentionally tiny: give me strings, get back vectors.
 * Provider id and dimension are stored on every chunk; rankings never mix
 * providers (see store/sqlite.ts).
 */

export interface EmbeddingProvider {
  /** Stable id stored in chunks.embedding_model_id. */
  readonly id: string;
  readonly dim: number;
  embed(texts: string[]): Promise<number[][]>;
}

export interface EmbeddingFactoryOptions {
  providerId: string;
  modelId: string;
  dim: number;
  /** Optional override for testing or self-hosted endpoints. */
  baseUrl?: string;
  /** Optional API key override; defaults to env. */
  apiKey?: string;
}
