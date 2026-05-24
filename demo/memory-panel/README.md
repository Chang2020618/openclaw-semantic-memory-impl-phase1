# Memory Panel Demo

最小可展示版 memory panel demo。

## 文件
- `index.html`：静态展示页
- `data.json`：最新一次生成的数据快照
- `data-<slug>.json`：按 query 预生成的 retrieval snapshot
- `queries.json`：预设 query 索引
- `generate-panel-data.sh`：生成/刷新数据

## 刷新一个 query snapshot

```bash
cd /root/.openclaw/workspace/openclaw-semantic-memory-impl
./demo/memory-panel/generate-panel-data.sh /root/.openclaw/workspace "向量记忆系统现在是什么状态？" 8
```

## 当前已生成的预设 query
- 向量记忆系统现在是什么状态？
- Phase-3 最后结论是什么？
- 为什么当时不走 OpenAI embedding？

## 说明
当前 demo 是**静态快照驱动**：
- 前端可以切换不同 query 的 snapshot
- 还不是浏览器直接调用后端实时 retrieval
- 这么做是为了先把产品演示链路跑通，避免被本机浏览器策略拦住
