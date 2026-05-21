/**
 * Minimal OpenAI-compatible chat-completions client for the summarizer.
 *
 * Uses the same env conventions as the embedding provider:
 *   OSM_OPENAI_API_KEY  — required for direct LLM call
 *   OSM_OPENAI_BASE_URL — defaults to https://api.openai.com/v1
 *
 * If no key is available, the summarizer must use one of the offline
 * paths (--prompt-only or --ingest-file). See cmd-summarize.ts.
 */

export interface ChatRequest {
  model: string;
  systemPrompt: string;
  userPrompt: string;
  /** Max output tokens. Defaults to 4096. */
  maxTokens?: number;
  /** Sampling temperature. Defaults to 0.2 (low; we want structure). */
  temperature?: number;
  /** Optional API key override; defaults to env. */
  apiKey?: string;
  /** Optional base URL override; defaults to env or OpenAI. */
  baseUrl?: string;
  /** Request timeout in ms. Defaults to 120000. */
  timeoutMs?: number;
}

export interface ChatResponse {
  text: string;
  model: string;
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
  };
}

export async function chatComplete(req: ChatRequest): Promise<ChatResponse> {
  const apiKey =
    req.apiKey ??
    process.env["OSM_OPENAI_API_KEY"] ??
    process.env["OPENAI_API_KEY"];
  if (!apiKey) {
    throw new Error(
      "osm/summarize: no API key. Set OSM_OPENAI_API_KEY (or pass " +
        "--prompt-only / --ingest-file to bypass direct LLM)."
    );
  }
  const baseUrl =
    req.baseUrl ??
    process.env["OSM_OPENAI_BASE_URL"] ??
    process.env["OPENAI_BASE_URL"] ??
    "https://api.openai.com/v1";

  const url = `${baseUrl.replace(/\/$/u, "")}/chat/completions`;

  // Some providers (Jeniya, OpenAI) strip leading `provider/` from model ids.
  const model = req.model.includes("/")
    ? (req.model.split("/").pop() as string)
    : req.model;

  const body = {
    model,
    messages: [
      { role: "system", content: req.systemPrompt },
      { role: "user", content: req.userPrompt },
    ],
    max_tokens: req.maxTokens ?? 4096,
    temperature: req.temperature ?? 0.2,
  };

  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    req.timeoutMs ?? 120_000
  );

  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new Error(
        `osm/summarize: chat HTTP ${resp.status} from ${url}: ${text.slice(0, 200)}`
      );
    }

    const json = (await resp.json()) as {
      model?: string;
      choices?: Array<{ message?: { content?: string } }>;
      usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
        total_tokens?: number;
      };
    };

    const text = json.choices?.[0]?.message?.content ?? "";
    return {
      text,
      model: json.model ?? model,
      usage: json.usage
        ? {
            ...(json.usage.prompt_tokens !== undefined && {
              promptTokens: json.usage.prompt_tokens,
            }),
            ...(json.usage.completion_tokens !== undefined && {
              completionTokens: json.usage.completion_tokens,
            }),
            ...(json.usage.total_tokens !== undefined && {
              totalTokens: json.usage.total_tokens,
            }),
          }
        : undefined,
    };
  } finally {
    clearTimeout(timer);
  }
}
