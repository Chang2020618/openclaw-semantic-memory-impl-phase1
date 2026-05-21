/**
 * Local ONNX embedding provider via @huggingface/transformers.
 *
 * Runs sentence-transformers / BGE / E5-style models locally, no API key,
 * no network calls after the first model download (cached under
 * ~/.cache/huggingface/transformers).
 *
 * Default model: Xenova/multilingual-e5-small (384 dims, BERT-base-tiny).
 * Strong on both Chinese and English, ~118 MB ONNX weights.
 *
 * Notes:
 *   - We import @huggingface/transformers lazily so the package can still
 *     load when only the stub is used (transformers brings ~100 MB of ONNX
 *     runtime into node_modules; we don't want that on every cold path).
 *   - We do mean-pooling + L2 normalization in the pipeline call (default
 *     for `feature-extraction`).
 *   - E5 family expects "query: " / "passage: " prefixes for best quality,
 *     but the spec says nothing about query/document asymmetry yet, so we
 *     apply "passage: " uniformly. This still beats no-prefix mode and
 *     keeps store-side and retrieve-side vectors comparable.
 */

import type { EmbeddingFactoryOptions, EmbeddingProvider } from "./provider.js";

type FeatureExtractionPipeline = (
  inputs: string | string[],
  options?: { pooling?: "mean" | "cls" | "none"; normalize?: boolean }
) => Promise<{ data: Float32Array; dims: number[] }>;

type PipelineFactory = (
  task: "feature-extraction",
  model?: string,
  options?: { quantized?: boolean; dtype?: string }
) => Promise<FeatureExtractionPipeline>;

let cachedPipelineFactory: PipelineFactory | null = null;

async function getPipeline(): Promise<PipelineFactory> {
  if (cachedPipelineFactory) return cachedPipelineFactory;
  // Dynamic import keeps the heavy native runtime out of cold-start paths
  // for users who never touch the local-onnx provider.
  const mod = (await import("@huggingface/transformers")) as unknown as {
    pipeline: PipelineFactory;
    env?: { allowRemoteModels?: boolean; allowLocalModels?: boolean };
  };
  cachedPipelineFactory = mod.pipeline;
  return cachedPipelineFactory;
}

export class LocalOnnxEmbeddingProvider implements EmbeddingProvider {
  readonly id: string;
  readonly dim: number;

  /** Lazily-initialized ONNX pipeline. */
  private pipe: FeatureExtractionPipeline | null = null;
  private pipePromise: Promise<FeatureExtractionPipeline> | null = null;

  /** HuggingFace repo id for the ONNX-converted model. */
  private readonly modelRepo: string;

  /** Optional input prefix (E5 family uses "passage: " / "query: "). */
  private readonly inputPrefix: string;

  constructor(opts: EmbeddingFactoryOptions) {
    this.id = `${opts.providerId}:${opts.modelId}`;
    this.dim = opts.dim;
    this.modelRepo = opts.modelId;
    this.inputPrefix = inferInputPrefix(opts.modelId);
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const pipe = await this.ensurePipe();

    const prefixed = this.inputPrefix
      ? texts.map((t) => `${this.inputPrefix}${t}`)
      : texts;

    // Run in a single batch call. transformers.js handles batching internally.
    const out = await pipe(prefixed, { pooling: "mean", normalize: true });

    const expectedDim = out.dims[out.dims.length - 1] ?? 0;
    if (expectedDim !== this.dim) {
      throw new Error(
        `osm/embed: model '${this.modelRepo}' returned dim=${expectedDim}, ` +
          `but config declares dim=${this.dim}. Update the config or pick ` +
          `a different model.`
      );
    }

    const flat = out.data;
    const result: number[][] = new Array(prefixed.length);
    for (let i = 0; i < prefixed.length; i += 1) {
      const row = new Array<number>(this.dim);
      for (let j = 0; j < this.dim; j += 1) {
        row[j] = flat[i * this.dim + j] ?? 0;
      }
      result[i] = row;
    }
    return result;
  }

  private async ensurePipe(): Promise<FeatureExtractionPipeline> {
    if (this.pipe) return this.pipe;
    if (!this.pipePromise) {
      this.pipePromise = (async (): Promise<FeatureExtractionPipeline> => {
        const factory = await getPipeline();
        const pipe = await factory("feature-extraction", this.modelRepo, {
          // q8 ONNX is plenty for sentence-transformer encoders and ~4x
          // smaller than fp32. transformers.js v3+ uses `dtype` not
          // `quantized`. We pass both for forward-compat with v2 builds.
          dtype: "q8",
          quantized: true,
        });
        this.pipe = pipe;
        return pipe;
      })();
    }
    return this.pipePromise;
  }
}

function inferInputPrefix(modelId: string): string {
  const lower = modelId.toLowerCase();
  if (lower.includes("e5")) return "passage: ";
  return "";
}
