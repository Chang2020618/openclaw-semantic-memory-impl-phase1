# OpenClaw Semantic Memory — Phase-1 Reference Implementation

> **⚠️ Project Status**: This is a working reference implementation in active development (Phase-2). It is **open-source for learning and forking**, but **not currently accepting external contributions (PRs)**. Issues for bug reports are welcome.

A drop-in, file-system-first semantic memory layer for AI agents. Markdown stays the source of truth. The index is disposable. Every retrieved memory carries a real citation back to a line range in your source files.

This is the Phase-1 reference implementation of OpenClaw Semantic Memory v0.1. The design spec lives in a sibling design repo; this repo is the build.

```sh
$ osm init    --root /path/to/workspace
$ osm index   --rebuild
$ osm search  "Flutter Android APK 打包"
```

## Why this exists

Most AI agents forget everything between sessions. This gives them **durable, citation-backed memory** that:

- Survives restarts (markdown is truth, index is cache)
- Returns real citations (file path + line range)
- Runs locally (no API key required for default ONNX provider)
- Respects your files (never auto-edits markdown)

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
git clone https://github.com/Chang2020618/openclaw-semantic-memory-impl-phase1 osm
cd osm
pnpm install         # installs onnxruntime-node + transformers (~600 MB once)
pnpm build

# Point osm at a workspace that has memory/*.md (and optionally MEMORY.md at the root).
node packages/cli/dist/index.js init    --root /path/to/workspace
node packages/cli/dist/index.js index   --root /path/to/workspace --rebuild
node packages/cli/dist/index.js search  "your query" --root /path/to/workspace
```

First `index --rebuild` downloads the embedding model (~118 MB) into `~/.cache/huggingface/transformers/`. After that everything is offline.

### Using OpenAI / Jeniya / any OpenAI-compatible endpoint

Edit `<workspace>/memory/.cache/config.json`:

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

## Design principles (v0.1 spec)

**12 mandatory requirements:**

1. Read all markdown under `memory/`
2. Chunk by heading + paragraph + size cap
3. Embed new/changed chunks
4. Store vectors and metadata in a disposable index
5. Expose `retrieve(query)` returning v0.1 result schema
6. Provide hybrid retrieval (semantic + lexical, fused)
7. Emit citations for every result
8. Write capture events as `episode` objects with provenance
9. Never modify canonical markdown automatically
10. Survive index deletion (rebuild from markdown must work)
11. Log every retrieval with `whyMatched`
12. Respect scope filters at retrieval time

**Hard rules:**

- Markdown is the source of truth; the index can always be rebuilt from it
- Inferred memory never auto-promotes to fact
- Inferred memory never overrides `human_confirmed` memory
- Secrets never enter the vector index
- Archived memory never auto-resurrects
- Failure recovery never auto-edits canonical markdown

All requirements are implemented and verified against a real agent workspace (dogfood corpus).

## Architecture

**Stack:**
- TypeScript on Node 22+
- pnpm workspace
- SQLite (better-sqlite3) + FTS5 + cosine over BLOB-stored float32 vectors
- Hybrid retrieval via Reciprocal Rank Fusion (semantic + lexical)
- Pluggable embedding providers (`openai` / `local-onnx` / `local-stub`)

**Layout:**

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
| M1 | repo skeleton + core types + empty CLI | ✅ done |
| M2 | store + chunker | ✅ done |
| M3 | embed + index | ✅ done |
| M4 | retrieve | ✅ done |
| M5 | capture loop | ✅ done with M3 |
| M6 | audit + explain + doctor + watch | ✅ done |
| M7 | eval harness + gate | ✅ done |
| M8 | dogfood pass + real-embedding gate | ✅ done |
| **Phase-2** | Task control plane + agent delegation | 🚧 in progress |

## Contributing

**This project is currently NOT accepting pull requests.** The architecture is still evolving (Phase-2), and external contributions would slow down core development.

**What you CAN do:**
- ⭐ Star the repo if you find it useful
- 🐛 Open issues for bug reports (include repro steps)
- 🍴 Fork and adapt for your own use (MIT license)
- 📖 Learn from the code and design decisions

When Phase-2 stabilizes, I may open up to external contributions. For now, this is a **solo-maintained reference implementation**.

## Related projects

- [OpenClaw](https://github.com/openclaw/openclaw) — The AI agent framework this was built for
- [Design spec repo](https://github.com/Chang2020618/openclaw-semantic-memory-design) _(if public, otherwise remove this line)_

## License

MIT. See [LICENSE](LICENSE) for details.

---

**Author:** [Chang Zhang](https://github.com/Chang2020618)  
**Built for:** OpenClaw agent memory persistence  
**Status:** Phase-1 complete, Phase-2 in progress
