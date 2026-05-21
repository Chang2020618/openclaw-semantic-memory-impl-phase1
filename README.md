# OpenClaw Semantic Memory — reference implementation

A drop-in, file-system-first semantic memory layer for AI agents. Markdown stays the source of truth. The index is disposable. Every retrieved memory carries a real citation back to a line range in your source files.

This is the Phase-1 reference implementation of OpenClaw Semantic Memory v0.1. The design spec lives in a sibling design repo; this repo is the build.

```
$ osm init    --root /path/to/workspace
$ osm index   --rebuild
$ osm search  "Flutter Android APK 打包"
```

## v0.1 scorecard (2026-05-21)

| Gate | Target | Actual | Pass |
|---|---|---|---|
| Recall@5 | ≥ 0.85 | **1.000** | ✅ |
| MRR | — | 0.701 | — |
| Citation accuracy | ≥ 0.95 | 1.000 | ✅ |
| Avg injection tokens | ≤ 200 | 105 | ✅ |
| `osm doctor` | clean | 7/8 ✓ + 1 n/a | ✅ |
| Rebuild from markdown | bit-equiv | identical hash | ✅ |

Default provider: `local-onnx:Xenova/multilingual-e5-small` (384 dims, runs locally via `@huggingface/transformers` ONNX, no API key, no network after first download). Full pass details in [`docs/21-dogfood-report.md`](docs/21-dogfood-report.md).

## Quick start

Requires Node 22+ and pnpm 10+.

```sh
git clone <this-repo> osm
cd osm
pnpm install         # installs onnxruntime-node + transformers (~600 MB once)
pnpm build

# Point osm at a workspace that has memory/*.md (and optionally MEMORY.md at the root).
node packages/cli/dist/index.js init    --root /path/to/workspace
node packages/cli/dist/index.js index   --root /path/to/workspace --rebuild
node packages/cli/dist/index.js search  "your query" --root /path/to/workspace
```

First `index --rebuild` downloads the embedding model (~118 MB) into `~/.cache/huggingface/transformers/`. After that everything is offline.

To use OpenAI / Jeniya / any OpenAI-compatible endpoint instead, edit `<workspace>/memory/.cache/config.json`:

```json
{
  "embedding": {
    "providerId": "openai",
    "modelId": "text-embedding-3-small",
    "dim": 1536
  }
}
```

then `osm index --rebuild` (vector dims must match, so a full rebuild is required when the provider changes). API key is read from `OSM_OPENAI_API_KEY`, base URL from `OSM_OPENAI_BASE_URL`.

## CLI commands

| Command | Purpose |
|---|---|
| `osm init` | create `.cache/`, write default config, open DB |
| `osm index` | incremental reindex of `memory/` |
| `osm index --rebuild` | full rebuild from markdown |
| `osm search "<query>"` | hybrid retrieval, top-K with citations |
| `osm explain <memoryId>` | dump memory + provenance + recent audit hits |
| `osm watch` | file watcher, incremental reindex on changes |
| `osm doctor` | health check (8 signals) |
| `osm eval <test-set>` | run frozen test set, score against v0.1 gates |

Add `--json` to most commands for machine-readable output. `--debug` on `search` adds candidate counts and rejection reasons.

## Goals (v0.1 mandatory)

The 12 mandatory requirements from the design spec:

1. read all markdown under `memory/`
2. chunk by heading + paragraph + size cap
3. embed new/changed chunks
4. store vectors and metadata in a disposable index
5. expose `retrieve(query)` returning v0.1 result schema
6. provide hybrid retrieval (semantic + lexical, fused)
7. emit citations for every result
8. write capture events as `episode` objects with provenance
9. never modify canonical markdown automatically
10. survive index deletion (rebuild from markdown must work)
11. log every retrieval with `whyMatched`
12. respect scope filters at retrieval time

All twelve are implemented and verified against the dogfood corpus.

## Hard rules (from v0.1 spec)

- markdown is the source of truth; the index can always be rebuilt from it
- inferred memory never auto-promotes to fact
- inferred memory never overrides `human_confirmed` memory
- secrets never enter the vector index
- archived memory never auto-resurrects
- failure recovery never auto-edits canonical markdown

## Stack

- TypeScript on Node 22+
- pnpm workspace
- SQLite (better-sqlite3) + FTS5 + cosine over BLOB-stored float32 vectors
- Hybrid retrieval via Reciprocal Rank Fusion (semantic + lexical)
- Pluggable embedding providers (`openai` / `local-onnx` / `local-stub`)

## Layout

```
packages/
├── core       # types, schemas, ids, hashing
├── chunker    # markdown chunker (heading + paragraph + bullet-aware)
├── embed      # embedding provider interface (openai, local-onnx, local-stub)
├── store      # sqlite + FTS5 backend
├── capture    # walker + extractor + importance scorer
├── retrieve   # hybrid retrieval + RRF + guardrails + whyMatched
├── eval       # test-set runner + v0.1 gate checker
└── cli        # `osm` binary
```

~4.8 KLoC TypeScript across 8 packages.

## Build milestones

| Milestone | Scope | Status |
|---|---|---|
| M1 | repo skeleton + core types + empty CLI | done |
| M2 | store + chunker | done |
| M3 | embed + index | done |
| M4 | retrieve | done |
| M5 | capture loop | done with M3 |
| M6 | audit + explain + doctor + watch | done |
| M7 | eval harness + gate | done |
| M8 | dogfood pass + real-embedding gate | done — see [`docs/21-dogfood-report.md`](docs/21-dogfood-report.md) |

## License

MIT.
