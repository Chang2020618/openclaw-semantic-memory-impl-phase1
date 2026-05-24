# Phase-2 Dogfood Report (M2-5)

**Date:** 2026-05-21
**Branch:** `phase-2`
**Scope:** session summary → ephemeral memory → dual-source retrieval

## What we built

| Milestone | Deliverable | Status |
|---|---|---|
| M2-1 | Ephemeral schema (DDL + 7 store APIs) | ✅ |
| M2-2 | Transcript normalizer + summarizer prompt + LLM client | ✅ |
| M2-3 | `osm summarize` CLI + dual-source retrieval (RRF + 0.85 weight) | ✅ |
| M2-4 | `osm doctor` ephemeral signals + `--vacuum` | ✅ |
| M2-5 | This report | ✅ |

## End-to-end smoke test

### Input
- Source session: `9d5fae64-033d-4ffc-bd75-027fc223339a.jsonl`
- 313 turns, 16-hour real working session about Phase-2 itself
- Workspace: `/tmp/p2-test/` (clean, single placeholder memory)

### Summarize step (`--ingest-file`, bypassing LLM)
```
osm summarize: session 9d5fae64-033d-4ffc-bd75-027fc223339a
  turns      = 313
  chars      = 55790  [trimmed from ~60k budget]
  span       = 2026-05-21T06:30 → 2026-05-21T22:42
  proposed   = 5
  accepted   = 5
  embeddings = 5
  duration   = 6614ms (local ONNX e5-small)
```

Five hand-written candidates exercised every accepted memory type
(decision × 2, fact × 1, preference × 1, episode × 1).

### Retrieval step

Query: `Phase-2 范围 ephemeral 摘要`

| # | Source | Type | Score | Conf | Why |
|---|---|---|---|---|---|
| 1 | ephemeral | decision | 0.0216 | 0.80 | semantic + lexical + ephemeral layer |
| 2 | ephemeral | decision | 0.0209 | 0.75 | same |
| 3 | ephemeral | episode | 0.0192 | 0.70 | same |
| 4 | **persistent** | episode | 0.0164 | 1.00 | semantic + human_confirmed |
| 5 | ephemeral | fact | 0.0105 | 0.80 | semantic + ephemeral |

Behaviors confirmed:
- Both layers contributed; merged ranking is monotone in `rrf × sourceWeight × confidence`.
- Persistent (conf=1.00) ranked below 3 ephemeral hits because RRF dominated.
- `recent_within_30d`, `layer=ephemeral`, `session_summary` whyMatched tags all emitted.
- `--no-ephemeral` correctly dropped to 1 result (only persistent).
- `--only-ephemeral` correctly dropped persistent and returned 3 ephemeral with weight=1.0.

### Doctor + vacuum

Healthy state:
```
✓ ephemeral_total            = 5      active=5 expired=0
✓ ephemeral_expired          = 0      none
✓ ephemeral_avg_confidence   = 0.76   mean=0.76 (clamped to [0.5, 0.8])
```

After hand-injecting `expires_at='2020-01-01'` on one row:
```
✓ ephemeral_expired          = 1      1 past TTL — run `osm doctor --vacuum` to delete
```

`osm doctor --vacuum` → `deleted 1 memories and 0 chunks past TTL` (chunk
deleted via FK cascade; report counts the direct delete only — cosmetic,
end-state correct: 4 memories / 4 chunks).

## Phase-2 v0.2 acceptance gates

Per `docs/22-phase2-spec.md`:

| Gate | Target | Actual | Pass |
|---|---|---|---|
| Session summary citation accuracy | 100% reference `session://<id>#range=…` | 5/5 | ✅ |
| Ephemeral confidence clamped | ∈ [0.5, 0.8] | min=0.70 max=0.80 mean=0.76 | ✅ |
| Persistent untouched by summarize | 0 writes to `memories`/`chunks` | 0 | ✅ |
| Hybrid merges both layers | ≥ 1 ephemeral hit + persistent visible | 4 eph + 1 persistent | ✅ |
| TTL hard rule | `expires_at` required, NULL rejected | enforced by schema | ✅ |
| Vacuum semantics | overdue rows deletable in one command | yes | ✅ |
| `osm doctor` reports ephemeral health | 3 new signals | total/expired/avg_conf | ✅ |
| Secrets filter | `sk-*/ghp_*/PEM` etc dropped before insert | regex active in parseSummaries | ✅ |
| Build clean | `pnpm build` exits 0 | yes | ✅ |

**Gate: PASS ✅**

## Known gaps (deferred to Phase-3)

1. **Real LLM dogfood not yet run.** All summaries above are hand-written via
   `--ingest-file`. `chatComplete()` path needs `OSM_OPENAI_API_KEY` env or
   the OpenClaw spawn variant. Plan: pick this up next session with the
   jeniya middleman credential.
2. **Vacuum chunk count off-by-one.** Report shows `chunks: 0` even when the
   FK cascade removed one chunk row. End-state correct; report is cosmetic.
3. **`osm summarize` does not yet auto-detect duplicate ingest.** Re-running
   on the same session will create new ephemeral IDs (different timestamp →
   different content hash). Acceptable for ephemeral; will tighten in Phase-3
   if it becomes noisy.
4. **No automatic OpenClaw hook.** The main agent does not call
   `osm summarize` after a session ends. Manual invocation only. By design
   per the Phase-2 charter (scoped narrow on purpose).
5. **No promotion path.** Ephemeral never becomes persistent automatically.
   By design per v0.1 spec hard rules.

## Files of record

```
packages/store/src/schema.sql                +50 lines   ephemeral DDL
packages/store/src/sqlite.ts                 +220 lines  10 ephemeral APIs
packages/store/src/index.ts                  +2 exports
packages/core/src/types.ts                   +60 lines   EphemeralMemory/Chunk, AuditKind
packages/summarize/                          NEW         transcript/prompt/llm/ingest
packages/retrieve/src/ephemeral.ts           NEW         hybrid + result mapper
packages/retrieve/src/index.ts               +50 lines   fan-out + merge
packages/cli/src/cmd-summarize.ts            NEW         CLI driver
packages/cli/src/cmd-search.ts               +20 lines   --no-ephemeral / --only-ephemeral
packages/cli/src/cmd-doctor.ts               +90 lines   3 new signals + --vacuum
packages/cli/src/index.ts                    +50 lines   subcommand wiring
```

Total ~4.8 KLoC → ~5.5 KLoC.

## Next session

1. Push `phase-2` branch to GitHub.
2. Wire real LLM (`OSM_OPENAI_API_KEY` against jeniya middleman) and
   re-run summarize on this same session — compare hand vs LLM candidates.
3. Open the Phase-3 charter: OpenClaw runtime hook + promotion UX.


---

## Phase-3 follow-up note (2026-05-24)

Phase-2 的 retrieval / summarize 基础设施后来已在 OpenClaw 真宿主里完成最小接入验证：
- retrieval 通过 `before_prompt_build` 插件 hook 真实触发
- summarize side 通过 `agent_end` 真实触发 marker
- local-onnx (`Xenova/multilingual-e5-small`, 384 dims) rebuild 成功
- `retrieve_result.jsonl` 已产出真实 ephemeral hits，说明 Phase-2 的 dual-source retrieval 能被宿主插件链路直接复用

详见：`docs/23-phase3-openclaw-core-integration.md` 的 “P3-3b 实际验收结果（2026-05-24）”。
