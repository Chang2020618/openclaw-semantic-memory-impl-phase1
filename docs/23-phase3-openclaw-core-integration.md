# Phase-3 OpenClaw Core Integration (minimal hook)

## Goal
把 `openclaw-semantic-memory-impl` 从外部 watcher 原型，推进到 **OpenClaw 插件真实接入** 的最小可用形态：
- **retrieval** 走 `before_prompt_build`
- **summarize enqueue / flush** 先走 `agent_end`，必要时再补 `session_end`
- **真正的 summarize 执行** 暂时仍复用现有 `osm summarize-watch` / `runSummarize(...)` 能力，不阻塞主回复链路

这份设计只收口 **最小可逆方案**，不在这一版直接侵入 OpenClaw 核心宿主代码。

---

## 已确认的宿主真实接入点

### 1) Prompt 注入入口：`before_prompt_build`
已确认在 OpenClaw 核心中存在 typed hook：
- `before_prompt_build`
- `before_model_resolve`
- `agent_end`
- `session_end`
- `before_message_write`
- `after_compaction`

其中：
- `before_prompt_build` 已被内置插件 `active-memory` 实际使用
- `skill-workshop` 也在用 `api.on("before_prompt_build", ...)`
- 宿主明确提示：
  - `still uses legacy before_agent_start; keep regression coverage on this plugin, and prefer before_model_resolve/before_prompt_build for new work.`

因此 Phase-3 的 retrieval 集成应优先挂在 **`before_prompt_build`**，不走 legacy `before_agent_start`。

### 2) 结束态入口：`agent_end` / `session_end`
已确认 hook 类型存在：
- `PluginHookAgentEndEvent`
- `PluginHookSessionEndEvent`
- `PluginHookSessionStartEvent`

其中：
- `agent_end` 带 `messages`, `success`, `error`, `durationMs`
- `session_end` 带 `sessionId`, `sessionKey?`, `messageCount`, `durationMs?`, `reason?`, `sessionFile?`, `transcriptArchived?`

结论：
- **最小 summarize hook** 先挂 `agent_end`
- 若后续需要更稳定的“会话结束归档点”，再补 `session_end`

### 3) Runtime lifecycle
已确认存在 `registerRuntimeLifecycle(record, lifecycle)`，且 loader 会校验：
- `id` 必填且对当前 plugin 唯一
- `cleanup` 若存在必须是函数

当前判断：
- Phase-3 最小版 **可以先不用** `registerRuntimeLifecycle`
- 如果后续做 sidecar / child process / queue worker，再用它做 `cleanup`

---

## 已确认的相关宿主事实

### `active-memory` 的 transcript 持久化不是通用 session hook
已确认 `active-memory` 有：
- `persistTranscripts: raw.persistTranscripts === true`
- `resolvePersistentTranscriptBaseDir(api, agentId)`
- 路径落在：
  - `api.runtime.state.resolveStateDir()/plugins/active-memory/transcripts/agents/<agentId>`

这说明它更像**插件私有持久化**，不是通用 `onSessionTranscriptUpdate` 插件 API。

### 当前版本未看到公开插件侧 `onSessionTranscriptUpdate` / `onSessionLifecycleEvent`
在已检查的 `plugin-sdk` / `host-hooks` / loader 中：
- 没找到插件 API 级别 `onSessionTranscriptUpdate`
- 没找到插件 API 级别 `onSessionLifecycleEvent`

所以最小方案不依赖它们，直接用 typed hooks。

---

## 最小集成方案

### A. Retrieval：插件内挂 `before_prompt_build`
职责：
1. 判断是否主 agent / direct / 允许 session
2. 读取最新用户问题 `event.prompt`
3. 调用我们现有 retrieval 逻辑（后续可直接复用 `@osm/retrieve`，或先 shell-out `osm search --json`）
4. 若命中记忆，返回：
   - `prependContext` 或 `prependSystemContext`
5. 若没命中，返回空

建议：
- **第一版直接复用现有检索链路**，避免重写 recall 判定器
- 先只支持 `agentId=main`
- 先只支持 direct chat

### B. Summarize：插件内挂 `agent_end`
职责：
1. 只在 `event.success === true` 时处理
2. 只处理 `agentId=main`
3. 只做**轻量 enqueue / marker 落盘**，不在 hook 内直接跑长时 summarize
4. 交给现有 watcher / runner 消化

为什么先这样：
- 不阻塞主回复
- 不把长时 LLM summarize 放进 hook timeout 风险区
- 与当前已经运行稳定的 `summarize-watch.service` 完全兼容

### C. 后续增强：`session_end`
如果后续验证发现 `agent_end` 粒度太细，会频繁重复触发：
- 再加 `session_end`
- 只在 `reason in ["idle", "daily", "shutdown", "restart"]` 等场景做更强 summarize

这属于第二步，不进最小版。

---

## 这版落代码的边界

### 本次会直接做
1. 新增一个 **OpenClaw 插件骨架包**
2. 在插件里注册：
   - `before_prompt_build`
   - `agent_end`
3. retrieval 先做成 **最小 stub / bridge**：把接入点和配置形状钉住
4. summarize 先做成 **enqueue marker**：证明真实 hook 已接上

### 本次不会做
1. 不直接修改 `/usr/lib/node_modules/openclaw/dist/...` 宿主核心
2. 不把 watcher 立即替换成插件内完整 worker
3. 不在 hook 内直接长时间跑 summarize LLM
4. 不做 promotion path

---

## 已落地的插件包形状

- 包目录：`/root/.openclaw/workspace/openclaw-semantic-memory-impl/packages/openclaw-plugin/`
- 运行时入口：`src/index.ts`
- manifest：`openclaw.plugin.json`
- 当前运行时导出：`default definePluginEntry({ ... })`
- `package.json` 已补：
  - `openclaw.extensions = ["./src/index.ts"]`
  - `openclaw.runtimeExtensions = ["./dist/index.js"]`
  - `openclaw.compat.pluginApi = ">=2026.5.18"`
  - `openclaw.build.openclawVersion = "2026.5.18"`
- `openclaw.plugin.json` 已补：
  - `id = "osm-semantic-memory"`
  - `activation.onStartup = true`
  - strict `configSchema`
  - `uiHints`

当前插件仍是 **hook-only 最小桥接版**：
- `before_prompt_build` 只写 marker；可选 `injectStubContext`
- `agent_end` 只写 marker
- marker 默认路径：`.cache/osm/plugin-markers/`

---

## 推荐的演进顺序

### P3-3a（本次）
- 插件骨架
- `before_prompt_build` / `agent_end` 挂接
- marker + 设计文档

### P3-3b
- retrieval 从 stub 接到真实 `@osm/retrieve`
- prompt 注入内容调优

### P3-3c
- summarize enqueue 改成更正式队列
- 必要时补 `session_end` + runtime lifecycle cleanup

---

## 最小安装 / 验证命令

```bash
cd /root/.openclaw/workspace/openclaw-semantic-memory-impl
pnpm install
pnpm --filter @osm/openclaw-plugin typecheck
pnpm --filter @osm/openclaw-plugin build
openclaw plugins install /root/.openclaw/workspace/openclaw-semantic-memory-impl/packages/openclaw-plugin --force
openclaw plugins inspect osm-semantic-memory --runtime --json
```

如要验证 stub 注入：
- 在 `plugins.entries.osm-semantic-memory.config.injectStubContext = true`
- 然后发起一次真实对话
- 检查：`.cache/osm/plugin-markers/before_prompt_build.jsonl`

---

## 验收标准（本次）
1. 仓库里有可编译的插件骨架
2. 代码里明确使用真实 typed hook：`before_prompt_build`、`agent_end`
3. 产出一页设计，解释为何这样接
4. 包形状满足 OpenClaw 原生插件最小要求：`openclaw.plugin.json` + `package.json#openclaw.extensions`
5. 不影响现有 `summarize-watch.service` 运行路径


---

## P3-3b 实际验收结果（2026-05-24）

### 结论
**P3-3b 真检索接入已跑通。**

### 已完成事项
- `before_prompt_build` 已从 stub bridge 接到真实 `@osm/retrieve`
- `agent_end` 已在真实宿主中触发并稳定写 marker
- 插件已安装到 OpenClaw，并通过 `allowConversationAccess` 放开会话读取权限
- 插件检索已改为读取 workspace OSM 配置作为 embedding fallback，避免插件配置与 CLI 配置漂移
- retrieval 最终切换到 `local-onnx:Xenova/multilingual-e5-small`（384 dims）
- `memory/.cache/index.db` 已用 local-onnx 全量 rebuild 成功

### 运行态证据
- `openclaw plugins inspect osm-semantic-memory --runtime --json`
  - `status = loaded`
  - `typedHooks = [agent_end, before_prompt_build]`
  - `diagnostics = []`
  - `policy.allowConversationAccess = true`
- marker 证据链：
  - `before_prompt_build.jsonl` 持续记录最新 query
  - `agent_end.jsonl` 持续记录成功回合
  - `retrieve_result.jsonl` 已产生真实结果（不再只有 marker / error）
- 真实 query 验证：
  - `现在我接下来该做什么？`
  - `达到你的判定结果了吗`
- 两次 query 均返回 `resultCount=3`，且 top hits 来自 ephemeral session summaries，whyMatched 包含：
  - `semantic_similarity`
  - `recent_within_30d`
  - `lexical_match:session_summary`
  - `lexical_match:layer=ephemeral`

### 这次打通时踩到的真实坑
1. 非 bundled 插件默认拿不到 conversation-access hook 权限，需显式开启：
   - `plugins.entries.osm-semantic-memory.hooks.allowConversationAccess = true`
2. 插件初始默认 DB 路径错误：
   - 默认值 `.cache/osm/osm.db` 不存在
   - 正确库路径为 `memory/.cache/index.db`
3. embedding 路线最初误走 OpenAI / jeniya embeddings：
   - 401 / invalid token
   - 且历史结论已证明 jeniya 不适合作为 embeddings 入口
4. DB 与 provider 维度一度不一致：
   - 旧库 1536 dims
   - local-onnx 384 dims
   - 通过切换全链路到 local-onnx + rebuild 解决
5. 插件运行时配置与 CLI 配置曾漂移：
   - 修复方式：插件在缺省时回退读取 `memory/.cache/config.json`

### 当前仍未完成（但不阻塞“已跑通”的判定）
- prompt 注入内容尚未做系统化人工评估
- summarize 已从纯 marker 升级到 queue-file enqueue，但 flush worker 仍未正式接通
- 如需更稳的会话级去重与归档时机，后续仍建议补 `session_end`

### 下一步优先级
1. 收尾文档 / 验收记录
2. 检索质量微调（topK / topN / minScore / weak query skip）
3. summarize 自动化（enqueue / flush / session_end）


### Phase-3 后续推进（2026-05-24 06:xx UTC）

本轮又向前推了一步：
- 检索质量：已新增 weak-query skip（默认跳过 `同意 / 继续 / 好 / 收到 / 嗯 / ok` 一类弱 query）
- summarize 自动化：`agent_end` 不再只写 marker，而是额外写入 queue file：
  - `workspace/.cache/osm/plugin-markers/summarize-queue.json`
  - 同时追加 `summarize_enqueue.jsonl` 作为审计 marker

当前 enqueue 记录字段包括：
- `sessionId`
- `sessionKey`
- `agentId`
- `queuedAt`
- `updatedAt`
- `nextRunAt`
- `ttlDays`
- `model`
- `idleMs`
- `settleMs`
- `status=queued`

这意味着 summarize 路径已经从“纯 marker 证明 hook 连上了”升级到“有结构化队列文件可供后续 flush worker 消费”。
真正剩下的只是不阻塞主回复的 flush 执行器，以及需要时补 `session_end` 做更稳的归档时机。


## P3-3c 最终自动化验收结果（2026-05-24）

### 结论
- **Phase-3 主路径已达到可交付状态**：
  - `before_prompt_build` 检索注入已真实跑通
  - `agent_end` summarize enqueue 已真实跑通
  - `summarize-watch` queue flush 已真实跑通
  - 主会话 summarize 自动执行并成功写入 ephemeral memories

### 本轮新增的关键实现
1. **弱 query skip**
   - CLI `search` 新增 `--skip-weak-query`
   - 插件默认跳过 `同意 / 继续 / 好 / 收到 / 嗯 / ok` 一类弱 query，避免低价值召回

2. **summarize queue enqueue**
   - 插件 `agent_end` 不再只写 marker，也会写：
     - `.cache/osm/plugin-markers/summarize-queue.json`
     - `.cache/osm/plugin-markers/summarize_enqueue.jsonl`

3. **queue flush worker 接通**
   - `osm summarize-watch` 已能周期性消费 `summarize-queue.json`
   - 到期后自动执行 `runSummarize(...)`
   - flush 结果写入 `summarize_flush.jsonl`
   - queue 条目状态更新为 `done` / `error`

4. **summarizer parser 容错修复**
   - 真实运行中发现 LLM 返回有时是“近似合法 JSON”
   - `parseSummaries()` 现已支持从响应中提取最外层 JSON array 再解析，避免因轻微脏输出导致整次 flush 失败

5. **active-memory 过滤 + error stop-retry**
   - enqueue 现已跳过：
     - `sessionId` 以 `active-memory-` 开头
     - `sessionKey` 含 `:active-memory:`
   - flush worker 遇到 `status=error` 的队列项时不再无限重试

### 最终运行态证据
- 主会话 queue flush 成功后，`summarize-queue.json` 已出现：
  - `status = done`
  - `lastRunAt = 2026-05-24T07:36:14.635Z`
  - `lastSuccessAt = 2026-05-24T07:36:33.317Z`
- 同次自动 summarize 实际输出：
  - `turns = 162`
  - `chars = 31002`
  - `proposed = 8`
  - `accepted = 8`
  - `embeddings = 8`
  - `llm tokens = 17927`
  - `duration = 18640ms`
- 自动 flush 成功写入 8 条新的 ephemeral memory ids：
  - `eph_b118d614c7302954fdfcb021`
  - `eph_f8de202ec7c9a3088658e5a6`
  - `eph_b42b1a4d280a7dee1d94d91b`
  - `eph_d407215a74b5ea871c29200a`
  - `eph_8e9478a94e7e5f428af046ae`
  - `eph_7b73110ae9b1db5a98d213cd`
  - `eph_114fedb0f044f515262cb67e`
  - `eph_88be8ab65720e36d8113b3f6`

### 剩余非阻塞项
- queue ingest 仍可能对同一 session 产生多批新的 ephemeral IDs（缺少去重 / 覆盖策略）
- 若后续追求更稳的“回合结束”语义，仍可补 `session_end` 作为归档时机
- prompt 注入质量仍可继续做人工评测与调参（topK / topN / minScore）

### 判定
**P3-3c PASS。**

Phase-3 的最小可用产品已经从“能证明 hook 存在”升级为“OpenClaw 真宿主中可自动检索、可自动 summarize、可落地入库的工作链路”。
