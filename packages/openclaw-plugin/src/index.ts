import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import type { OpenClawPluginApi } from "/usr/lib/node_modules/openclaw/dist/extensions/open-prose/runtime-api.d.ts";

const DEFAULT_AGENT_ID = "main";
const DEFAULT_MARKER_DIR = ".cache/osm/plugin-markers";
const DEFAULT_WORKSPACE_DIR = "/root/.openclaw/workspace";
const DEFAULT_OSM_IMPL_DIR = "/root/.openclaw/workspace/openclaw-semantic-memory-impl";
const DEFAULT_DB_PATH = ".cache/osm/osm.db";

const require = createRequire(import.meta.url);

type PluginConfig = {
  enabled?: boolean;
  agentId?: string;
  markerDir?: string;
  injectStubContext?: boolean;
  injectLiveContext?: boolean;
  osmRoot?: string;
  dbPath?: string;
  embedProviderId?: "openai" | "local-onnx" | "local-stub";
  embedModelId?: string;
  embedDim?: number;
  retrieveTopK?: number;
  retrieveTopN?: number;
  retrieveMinScore?: number;
  skipWeakQuery?: boolean;
  summarizeEnqueue?: boolean;
  summarizeIdleMs?: number;
  summarizeSettleMs?: number;
  summarizeTtlDays?: number;
  summarizeModel?: string;
};

type PromptBuildEventLike = {
  prompt?: string;
};

type AgentEndEventLike = {
  success: boolean;
  durationMs?: number;
  error?: string;
};

type AgentContextLike = {
  agentId?: string;
  sessionId?: string;
  sessionKey?: string;
  workspaceDir?: string;
  channelId?: string;
};

type LoadedOsmModules = {
  Retriever: new (opts: unknown) => {
    retrieve(q: unknown, options?: unknown): Promise<{ results?: Array<Record<string, unknown>> }>;
  };
  OsmStore: new (opts: unknown) => { close?: () => void };
  makeEmbeddingProvider: (opts: unknown) => unknown;
};

function definePluginEntry<T extends Record<string, unknown>>(entry: T): T {
  return entry;
}

function resolveConfig(raw: PluginConfig | undefined) {
  let fileDefaults: Partial<PluginConfig> = {};
  try {
    const configPath = "/root/.openclaw/workspace/memory/.cache/config.json";
    if (existsSync(configPath)) {
      const parsed = JSON.parse(readFileSync(configPath, "utf8")) as {
        embedding?: { providerId?: string; modelId?: string; dim?: number };
      };
      fileDefaults = {
        embedProviderId: parsed.embedding?.providerId as PluginConfig["embedProviderId"] | undefined,
        embedModelId: parsed.embedding?.modelId,
        embedDim: parsed.embedding?.dim,
      };
    }
  } catch {
    // ignore config-file fallback failures; explicit plugin config still wins
  }

  return {
    enabled: raw?.enabled !== false,
    agentId: typeof raw?.agentId === "string" && raw.agentId.trim() ? raw.agentId.trim() : DEFAULT_AGENT_ID,
    markerDir:
      typeof raw?.markerDir === "string" && raw.markerDir.trim()
        ? raw.markerDir.trim()
        : DEFAULT_MARKER_DIR,
    injectStubContext: raw?.injectStubContext === true,
    injectLiveContext: raw?.injectLiveContext === true,
    osmRoot:
      typeof raw?.osmRoot === "string" && raw.osmRoot.trim() ? raw.osmRoot.trim() : DEFAULT_OSM_IMPL_DIR,
    dbPath: typeof raw?.dbPath === "string" && raw.dbPath.trim() ? raw.dbPath.trim() : DEFAULT_DB_PATH,
    embedProviderId: raw?.embedProviderId ?? fileDefaults.embedProviderId ?? "local-stub",
    embedModelId: raw?.embedModelId ?? fileDefaults.embedModelId ?? "osm-plugin-local-stub",
    embedDim: raw?.embedDim ?? fileDefaults.embedDim ?? 384,
    skipWeakQuery: raw?.skipWeakQuery !== false,
    retrieveTopK: raw?.retrieveTopK ?? 3,
    retrieveTopN: raw?.retrieveTopN ?? 8,
    retrieveMinScore: raw?.retrieveMinScore ?? 0.15,
    summarizeEnqueue: raw?.summarizeEnqueue !== false,
    summarizeIdleMs: raw?.summarizeIdleMs ?? 10 * 60 * 1000,
    summarizeSettleMs: raw?.summarizeSettleMs ?? 20 * 1000,
    summarizeTtlDays: raw?.summarizeTtlDays ?? 90,
    summarizeModel: raw?.summarizeModel,
  };
}

function isEligibleAgent(ctx: AgentContextLike, config: ReturnType<typeof resolveConfig>): boolean {
  return (ctx.agentId ?? DEFAULT_AGENT_ID) === config.agentId;
}

function appendMarker(
  workspaceDir: string | undefined,
  relativeDir: string,
  name: string,
  payload: Record<string, unknown>,
): void {
  const base = workspaceDir || DEFAULT_WORKSPACE_DIR;
  const file = join(base, relativeDir, name);
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, JSON.stringify(payload) + "\n", "utf8");
}

function loadJsonFile<T>(path: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return fallback;
  }
}

function saveJsonFile(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync;
  require("node:fs").writeFileSync(path, JSON.stringify(value, null, 2) + "\n", "utf8");
}

function resolveWorkspaceDir(ctx: AgentContextLike): string {
  return ctx.workspaceDir || DEFAULT_WORKSPACE_DIR;
}

function resolveDbPath(workspaceDir: string, config: ReturnType<typeof resolveConfig>): string {
  return config.dbPath.startsWith("/") ? config.dbPath : join(workspaceDir, config.dbPath);
}

function getSummarizeQueuePath(workspaceDir: string, config: ReturnType<typeof resolveConfig>): string {
  return join(workspaceDir, config.markerDir, "summarize-queue.json");
}

function enqueueSummarizeJob(
  workspaceDir: string,
  config: ReturnType<typeof resolveConfig>,
  ctx: AgentContextLike,
  event: AgentEndEventLike,
): { queued: boolean; reason?: string } {
  if ((ctx.sessionId ?? "").startsWith("active-memory-") || (ctx.sessionKey ?? "").includes(":active-memory:")) {
    return { queued: false, reason: "skip_active_memory" };
  }

  const queuePath = getSummarizeQueuePath(workspaceDir, config);
  const nowIso = new Date().toISOString();
  const key = `${ctx.sessionId ?? "unknown"}`;
  const queue = loadJsonFile<Record<string, Record<string, unknown>>>(queuePath, {});
  const prev = queue[key];
  const nextRunAt = new Date(Date.now() + config.summarizeIdleMs).toISOString();

  queue[key] = {
    sessionId: ctx.sessionId,
    sessionKey: ctx.sessionKey,
    agentId: ctx.agentId ?? DEFAULT_AGENT_ID,
    queuedAt: prev?.queuedAt ?? nowIso,
    updatedAt: nowIso,
    nextRunAt,
    durationMs: event.durationMs,
    ttlDays: config.summarizeTtlDays,
    model: config.summarizeModel,
    settleMs: config.summarizeSettleMs,
    idleMs: config.summarizeIdleMs,
    status: "queued",
    ...(prev?.lastSuccessAt ? { lastSuccessAt: prev.lastSuccessAt } : {}),
  };
  saveJsonFile(queuePath, queue);
  return { queued: true };
}

async function loadOsmModules(osmRoot: string): Promise<LoadedOsmModules> {
  const retrieveUrl = new URL(`file://${resolve(osmRoot, "packages/retrieve/dist/index.js")}`);
  const storeUrl = new URL(`file://${resolve(osmRoot, "packages/store/dist/index.js")}`);
  const embedUrl = new URL(`file://${resolve(osmRoot, "packages/embed/dist/index.js")}`);

  const [{ Retriever }, { OsmStore }, { makeEmbeddingProvider }] = await Promise.all([
    import(retrieveUrl.href),
    import(storeUrl.href),
    import(embedUrl.href),
  ]);

  return { Retriever, OsmStore, makeEmbeddingProvider };
}

function extractLatestUserQuery(prompt: string | undefined): string | null {
  if (!prompt || !prompt.trim()) return null;
  const lines = prompt.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i]!;
    const m = line.match(/^\[[^\]]+\]\s*(.+)$/);
    if (m?.[1]?.trim()) return m[1].trim();
  }
  const fallback = lines.at(-1);
  return fallback && fallback.length > 1 ? fallback.slice(0, 500) : null;
}

const WEAK_QUERY_PATTERNS = [
  /^同意[了啊呀吗嘛]?$/,
  /^继续([吧呀哈]?)$/,
  /^好([的啊呀吧哈]?)[!！]?$/,
  /^收到[了]?[!！]?$/,
  /^嗯[嗯啊呀]?$/,
  /^ok[.!! ]*$/i,
  /^好的继续$/,
];

function shouldSkipWeakQuery(query: string | null | undefined): boolean {
  const text = query?.trim() ?? "";
  if (!text) return true;
  if (text.length <= 2) return true;
  return WEAK_QUERY_PATTERNS.some((re) => re.test(text));
}

function formatResultsForPrompt(results: Array<Record<string, unknown>>): string {
  if (!results.length) return "";
  const body = results
    .slice(0, 3)
    .map((r, idx) => {
      const summary = typeof r.summary === "string" ? r.summary : "";
      const citation = typeof r.citation === "string" ? r.citation : "";
      const score = typeof r.score === "number" ? r.score.toFixed(4) : String(r.score ?? "");
      return `- [${idx + 1}] ${summary}${citation ? ` | ${citation}` : ""}${score ? ` | score=${score}` : ""}`;
    })
    .join("\n");
  return `[OSM retrieved context]\n${body}`;
}

export default definePluginEntry({
  id: "osm-semantic-memory",
  name: "OSM Semantic Memory",
  description: "Minimal Phase-3 hook bridge for retrieval and summarize enqueue.",
  register(api: OpenClawPluginApi & { pluginConfig?: PluginConfig }) {
    const config = resolveConfig(api.pluginConfig);

    api.on(
      "before_prompt_build",
      async (event: PromptBuildEventLike, ctx: AgentContextLike) => {
        if (!config.enabled) return;
        if (!isEligibleAgent(ctx, config)) return;

        const workspaceDir = resolveWorkspaceDir(ctx);
        const query = extractLatestUserQuery(event.prompt);

        appendMarker(workspaceDir, config.markerDir, "before_prompt_build.jsonl", {
          at: new Date().toISOString(),
          hook: "before_prompt_build",
          agentId: ctx.agentId ?? DEFAULT_AGENT_ID,
          sessionId: ctx.sessionId,
          sessionKey: ctx.sessionKey,
          promptPreview: typeof event.prompt === "string" ? event.prompt.slice(0, 240) : undefined,
          extractedQuery: query,
          skippedWeakQuery: config.skipWeakQuery && shouldSkipWeakQuery(query),
        });

        if (config.skipWeakQuery && shouldSkipWeakQuery(query)) {
          appendMarker(workspaceDir, config.markerDir, "retrieve_skip.jsonl", {
            at: new Date().toISOString(),
            reason: "weak_query",
            query,
            sessionId: ctx.sessionId,
            sessionKey: ctx.sessionKey,
          });
          return;
        }

        if (config.injectStubContext) {
          return {
            prependContext:
              "[OSM stub] Semantic memory hook reached. Replace this stub with real retrieval output.",
          };
        }

        if (!config.injectLiveContext || !query) return;

        try {
          const osmRoot = config.osmRoot;
          const dbPath = resolveDbPath(workspaceDir, config);
          if (!existsSync(dbPath)) {
            appendMarker(workspaceDir, config.markerDir, "retrieve_skip.jsonl", {
              at: new Date().toISOString(),
              reason: "db_missing",
              dbPath,
              query,
              sessionId: ctx.sessionId,
            });
            return;
          }

          const { Retriever, OsmStore, makeEmbeddingProvider } = await loadOsmModules(osmRoot);
          const store = new OsmStore({
            dbPath,
            createDirs: true,
            embedding: {
              providerId: config.embedProviderId,
              modelId: config.embedModelId,
              dim: config.embedDim,
            },
          });

          try {
            const provider = makeEmbeddingProvider({
              providerId: config.embedProviderId,
              modelId: config.embedModelId,
              dim: config.embedDim,
            });

            const retriever = new Retriever({
              store,
              provider,
              defaults: {
                topK: config.retrieveTopK,
                topN: config.retrieveTopN,
                minScore: config.retrieveMinScore,
                defaultScope: "global",
              },
              ephemeral: {
                enabled: true,
                weight: 0.85,
                minConfidence: 0.5,
              },
            });

            const response = await retriever.retrieve(
              {
                text: query,
                topK: config.retrieveTopK,
                topN: config.retrieveTopN,
                minScore: config.retrieveMinScore,
                scope: "global",
              },
              { debug: true, auditKind: "retrieve" },
            );

            const results = Array.isArray(response?.results) ? response.results : [];
            appendMarker(workspaceDir, config.markerDir, "retrieve_result.jsonl", {
              at: new Date().toISOString(),
              query,
              sessionId: ctx.sessionId,
              sessionKey: ctx.sessionKey,
              resultCount: results.length,
              top: results.slice(0, 3),
            });

            if (!results.length) return;

            return {
              prependContext: formatResultsForPrompt(results),
            };
          } finally {
            store.close?.();
          }
        } catch (error) {
          appendMarker(workspaceDir, config.markerDir, "retrieve_error.jsonl", {
            at: new Date().toISOString(),
            query,
            sessionId: ctx.sessionId,
            sessionKey: ctx.sessionKey,
            error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
          });
          api.logger?.warn?.(
            `osm-semantic-memory: live retrieval failed: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`,
          );
          return;
        }
      },
      { timeoutMs: 3000 },
    );

    api.on("agent_end", async (event: AgentEndEventLike, ctx: AgentContextLike) => {
      if (!config.enabled) return;
      if (!event.success) return;
      if (!isEligibleAgent(ctx, config)) return;

      appendMarker(resolveWorkspaceDir(ctx), config.markerDir, "agent_end.jsonl", {
        at: new Date().toISOString(),
        hook: "agent_end",
        agentId: ctx.agentId ?? DEFAULT_AGENT_ID,
        sessionId: ctx.sessionId,
        sessionKey: ctx.sessionKey,
        durationMs: event.durationMs,
      });

      if (config.summarizeEnqueue) {
        const workspaceDir = resolveWorkspaceDir(ctx);
        const enqueue = enqueueSummarizeJob(workspaceDir, config, ctx, event);
        appendMarker(workspaceDir, config.markerDir, "summarize_enqueue.jsonl", {
          at: new Date().toISOString(),
          sessionId: ctx.sessionId,
          sessionKey: ctx.sessionKey,
          agentId: ctx.agentId ?? DEFAULT_AGENT_ID,
          queued: enqueue.queued,
          reason: enqueue.reason,
          idleMs: config.summarizeIdleMs,
          settleMs: config.summarizeSettleMs,
          ttlDays: config.summarizeTtlDays,
          model: config.summarizeModel,
        });
      }

      api.logger?.info?.("osm-semantic-memory: agent_end marker appended");
    });
  },
});
