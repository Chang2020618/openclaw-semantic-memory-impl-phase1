/**
 * OpenAI-compatible embedding provider.
 *
 * Uses the v1/embeddings endpoint. Compatible with:
 *   - api.openai.com
 *   - Jeniya transit (https://jeniya.cn/v1)
 *   - any other OpenAI-shaped endpoint
 *
 * Env (defaults):
 *   OSM_EMBED_BASE_URL        > OPENAI_BASE_URL > "https://api.openai.com/v1"
 *   OSM_EMBED_API_KEY         > OPENAI_API_KEY
 *
 * The provider does NOT retry — Phase 1 keeps error handling explicit.
 */

import type { EmbeddingFactoryOptions, EmbeddingProvider } from "./provider.js";

interface OpenAIEmbedRequest {
  model: string;
  input: string[];
  dimensions?: number;
}

interface OpenAIEmbedResponse {
  data: Array<{ embedding: number[]; index: number }>;
  model: string;
  usage?: { prompt_tokens: number; total_tokens: number };
}

export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  readonly id: string;
  readonly dim: number;

  private readonly modelId: string;
  private readonly baseUrl: string;
  private readonly apiKey: string;

  constructor(opts: EmbeddingFactoryOptions) {
    this.id = `${opts.providerId}:${opts.modelId}`;
    this.dim = opts.dim;
    this.modelId = opts.modelId;

    const baseUrl =
      opts.baseUrl ??
      process.env["OSM_EMBED_BASE_URL"] ??
      process.env["OPENAI_BASE_URL"] ??
      "https://api.openai.com/v1";
    this.baseUrl = baseUrl.replace(/\/$/, "");

    const apiKey =
      opts.apiKey ??
      process.env["OSM_EMBED_API_KEY"] ??
      process.env["OPENAI_API_KEY"];
    if (!apiKey) {
      throw new Error(
        "osm/embed: missing API key. Set OSM_EMBED_API_KEY or OPENAI_API_KEY."
      );
    }
    this.apiKey = apiKey;
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];

    // Most providers cap input array size; chunk to be safe.
    const BATCH = 64;
    const out: number[][] = new Array(texts.length);

    for (let i = 0; i < texts.length; i += BATCH) {
      const slice = texts.slice(i, i + BATCH);
      const body: OpenAIEmbedRequest = {
        model: this.modelId,
        input: slice,
      };
      // text-embedding-3 family supports `dimensions` truncation.
      if (this.modelId.startsWith("text-embedding-3")) {
        body.dimensions = this.dim;
      }

      const url = `${this.baseUrl}/embeddings`;
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const errText = await safeText(res);
        throw new Error(
          `osm/embed: ${res.status} ${res.statusText} from ${url}\n${errText}`
        );
      }

      const json = (await res.json()) as OpenAIEmbedResponse;
      if (!Array.isArray(json.data) || json.data.length !== slice.length) {
        throw new Error(
          `osm/embed: unexpected response from ${url} (got ${json.data?.length ?? 0} items, wanted ${slice.length})`
        );
      }

      // OpenAI API guarantees data is returned in input order, but the
      // schema also includes `index`. We honor `index` defensively.
      for (const item of json.data) {
        if (item.embedding.length !== this.dim) {
          throw new Error(
            `osm/embed: provider returned dim ${item.embedding.length}, expected ${this.dim}`
          );
        }
        out[i + item.index] = item.embedding;
      }
    }

    // Sanity: ensure every slot got filled.
    for (let i = 0; i < out.length; i += 1) {
      if (!out[i]) {
        throw new Error(`osm/embed: missing embedding at index ${i}`);
      }
    }
    return out;
  }
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "<unable to read response body>";
  }
}
