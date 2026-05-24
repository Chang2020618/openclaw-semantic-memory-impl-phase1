# OpenClaw Semantic Memory 产品化路线图

> 日期：2026-05-24  
> 仓库：`/root/.openclaw/workspace/openclaw-semantic-memory-impl/`

## 1. 当前状态

截至 2026-05-24，这套 OpenClaw Semantic Memory 已不再是概念验证，而是已经跑通真实主链路的可交付工程能力：

1. `before_prompt_build` 检索注入已真实接入宿主
2. `agent_end` summarize enqueue 已真实接入宿主
3. `summarize-watch` queue flush 已真实跑通
4. summarize 结果已成功写入 ephemeral memories
5. CLI 已具备 `osm panel --json`，可输出 persistent / ephemeral 统计与 retrieval debug
6. 已有可工作的 memory panel demo（静态 snapshot 驱动）

这意味着：

- 底层“记忆引擎”已经存在
- 但“产品壳”和“交付形式”还未成型
- 下一阶段重点不再是证明 memory 可行，而是把它变成用户能理解、能使用、能信任、能购买的产品

---

## 2. 产品定义：我们到底在做什么

不建议把这套能力对外定义为“向量记忆工具”或“embedding 产品”。

更合理的产品定义是：

> **一个带持续工作记忆的 AI 工作台。**

用户真正购买的不是：

- 向量检索
- embedding model
- summarize queue
- SQLite + FTS5 + vec0

用户购买的是：

- AI 能记住项目进展
- AI 能跨天继续工作
- AI 不需要用户反复重复上下文
- AI 的记忆可查看、可解释、可管理

所以产品层的核心包装应该是：

- 长期项目上下文
- AI 工作记忆
- 记忆可视化与治理
- 持续协作能力

而不是底层实现名词。

---

## 3. 为什么 memory panel 有产品化价值

memory panel 的价值不在于“页面好看”，而在于它把黑盒 memory 变成：

1. **可理解**：用户能看到系统记住了什么
2. **可解释**：用户能看到为什么这次召回了这些内容
3. **可审计**：用户能看到 citation、置信度、来源、过期时间
4. **可治理**：后续删除 / 确认 / 晋升 / suppress 都需要一个入口
5. **可销售**：演示时能把“AI 真的会记住你”讲清楚

如果没有 panel，memory 系统很容易停留在：

- 工程上已经存在
- 但产品上像黑盒
- 用户不敢信
- 销售讲不清
- 团队很难定位问题到底出在 recall、summary 还是模型本身

所以 panel 不是“附属 UI”，而是 memory 商业化和治理化的第一入口。

---

## 4. 产品路线：先 Web，再桌面安装包

### 4.1 为什么不建议一开始就做“全本地安装包”

如果太早做本地完整安装包，会立刻掉进以下复杂度：

- 本地 runtime 管理
- SQLite / cache / model 路径管理
- 本地 embedding / summarize 依赖安装
- Electron / Tauri 打包差异
- Windows 杀软误报
- 自动更新与 schema migration
- 多平台兼容性

这些问题都是真问题，但当前阶段不应该抢在“产品定义”和“用户价值验证”前面。

### 4.2 推荐路线

推荐两阶段推进：

#### Phase A：先做 Web 产品
先把这套 memory 能力包成一个可用的 AI 工作台 Web 版。

#### Phase B：再做桌面安装包
在 Web 产品壳稳定后，用 Electron 打成 Windows / macOS 桌面安装包。

结论：

> **先验证产品，再优化交付形式。**

---

## 5. Web MVP 应该长什么样

### 5.1 核心页面

Web MVP 不需要太大，最小可用版本建议包含：

1. **聊天主界面**
   - 和 AI 对话
   - 支持持续上下文

2. **记忆面板**
   - persistent / ephemeral 统计
   - recent memories
   - 类型、来源、置信度、citation、TTL

3. **retrieval explain 面板**
   - 当前 query
   - recall results
   - whyMatched
   - score / confidence
   - 是否注入 prompt

4. **记忆治理入口**
   - 删除 memory
   - 晋升 memory
   - suppress 某类记忆（后续）

5. **设置页**
   - API key / gateway / 模型
   - memory 开关
   - retrieval 参数（后续）

### 5.2 MVP 成功标准

如果 Web MVP 做到以下几点，就已经算进入产品阶段：

- 用户能肉眼看到“AI 记住了什么”
- 用户能理解“为什么这次会想起这些内容”
- 用户能对记忆做最基础控制
- 用户愿意把它用于跨天项目协作

---

## 6. Desktop 安装包路线

### 6.1 推荐技术：Electron

当前阶段更推荐 Electron，而不是一开始就选 Tauri。

原因：

- 生态成熟
- Windows 安装包产出最顺
- React / Next.js 前端易复用
- Node 侧更方便复用现有 TypeScript / CLI / retrieval 逻辑

### 6.2 安装包的合理定位

桌面安装包不是产品本身，而是产品的交付形式。

建议把安装包定义为：

> **AI 工作台桌面客户端**

包含：

- 聊天界面
- memory panel
- retrieval explain
- 配置页
- 本地启动/连接远端服务能力

### 6.3 两种桌面模式

#### 模式 A：云端模式（推荐先做）
桌面端只是 UI 壳，真正的 memory runtime 在 VPS / 云端。

优点：

- 上线快
- 包小
- 统一维护
- 升级简单

缺点：

- 依赖网络
- 本地隐私叙事较弱

#### 模式 B：本地完整模式（后续再做）
桌面端本地直接运行 memory runtime。

优点：

- 更像真正本地 AI 工作助手
- 更适合打“隐私 / 本地优先”故事
- 可部分离线运行

缺点：

- 包大
- 安装复杂
- 升级复杂
- 多平台环境坑显著增多

结论：

> **先做云端模式桌面壳，再评估本地完整模式。**

---

## 7. 服务层 / API 拆分建议

当前很多能力已经存在于 CLI 层。若要产品化，建议抽出一层轻量 API。

### 7.1 最小 API 清单

#### 1. 统计概览
```http
GET /api/memory/stats
```
返回：
- persistent total
- ephemeral total
- overdue
- avg confidence
- source/status breakdown

#### 2. 记忆列表
```http
GET /api/memory/list
```
支持参数：
- `source=persistent|ephemeral`
- `sessionId`
- `type`
- `limit`

#### 3. 检索解释
```http
GET /api/memory/retrieve?q=...
```
返回：
- query
- results
- whyMatched
- score
- confidence
- citation
- debug counters

#### 4. 删除记忆
```http
POST /api/memory/delete
```

#### 5. 晋升记忆
```http
POST /api/memory/promote
```

#### 6. 刷新 snapshot / summarize
```http
POST /api/memory/refresh
```

### 7.2 实现原则

建议服务层优先“薄封装”现有能力，而不是重写逻辑：

- 复用 `@osm/store`
- 复用 `@osm/retrieve`
- 复用 `@osm/summarize`
- 复用 `osm panel`
- 尽量先抽 service adapter，而不是重构整个底层

---

## 8. Electron 架构建议

### 8.1 推荐目录结构（示意）

```text
product/
  desktop/
    electron-main/
    electron-preload/
    renderer/
  service/
    api/
    memory/
    openclaw/
  shared/
    types/
    schemas/
```

### 8.2 职责拆分

#### Electron main
负责：
- 创建窗口
- 管理本地配置目录
- 启动/停止本地 service
- 处理自动更新
- 管理系统托盘（后续）

#### Renderer（前端 UI）
负责：
- 聊天界面
- 记忆面板
- explain 面板
- 设置界面

#### Local service
负责：
- 暴露 memory API
- 连接 OpenClaw / gateway
- 读写 store
- 调用 retrieval / summarize

---

## 9. 安装包打包建议

### 9.1 首发平台
建议先做：

- Windows 安装包（`.exe`）

理由：

- 用户装机习惯最明确
- Electron 打包成熟
- 当前工作流和用户环境更偏 Windows

### 9.2 打包工具
推荐：

- `electron-builder`

预期产物：

- `YourApp Setup.exe`
- 后续再补 `dmg` / `AppImage`

### 9.3 首次启动流程建议

1. 初始化应用目录
2. 检查本地/远端服务可用性
3. 让用户选择模式：
   - 连接远端
   - 本地模式（后续）
4. 填写 API key / gateway 地址
5. 完成初始化后进入工作台

---

## 10. 分阶段实施清单

### Phase 1：产品最小壳（当前最值得做）
- [ ] 把当前 memory panel demo 升级成正式 UI 页面
- [ ] 补 retrieval explain 的更清晰布局
- [ ] 补记忆删除 / 晋升操作
- [ ] 补基础设置页
- [ ] 定义 API contract

### Phase 2：服务层
- [ ] 抽 `stats/list/retrieve/delete/promote/refresh` API
- [ ] 前端改从 API 取数，而不是 snapshot 文件
- [ ] 整理本地与远端两种模式的 service adapter

### Phase 3：Web 产品化
- [ ] 完成完整 Web 工作台
- [ ] 提供登录 / 配置 / 环境检测
- [ ] 形成可对外 demo 的正式版本

### Phase 4：Windows 安装包
- [ ] 引入 Electron
- [ ] 打本地桌面壳
- [ ] 接远端 memory service
- [ ] 产出 `.exe`

### Phase 5：本地完整模式（可选）
- [ ] 本地 runtime
- [ ] 本地 DB / cache / config 管理
- [ ] 本地 summarize / retrieval
- [ ] 升级 / 迁移 / 故障恢复机制

---

## 11. 风险与取舍

### 风险 1：过早投入安装包工程
如果太早做安装包，会消耗大量时间在：
- 路径
- 权限
- 更新
- 平台兼容
- 本地依赖

而不是用户价值本身。

### 风险 2：产品定义被“技术名词”绑架
如果对外讲的是：
- 向量库
- embedding
- FTS5
- RRF

那很容易变成技术演讲，而不是产品叙事。

### 风险 3：没有治理入口，用户不敢长期启用记忆
仅有 recall 能力，不足以支撑长期使用。治理入口是必须补的。

---

## 12. 推荐决策（当前最现实的路线）

### 一句话决策

> **先做 Web 产品化，再做 Electron Windows 安装包；不要现在就做本地全家桶安装包。**

### 推荐顺序

1. 继续完善 memory panel + retrieval explain
2. 增加记忆治理能力（删除 / 晋升）
3. 抽轻量 API
4. 做正式 Web 工作台
5. 用 Electron 打 Windows 安装包
6. 视验证结果再决定是否做本地完整模式

这条路线的好处是：

- 最快看到产品价值
- 最快得到真实反馈
- 最少陷入安装包工程泥潭
- 最适合当前阶段的 OpenClaw memory 能力成熟度

---

## 13. 最终判断

当前阶段，这套 OpenClaw Semantic Memory 的关键任务已经不是“继续证明技术能不能跑”，而是：

> **把它从黑盒能力，变成用户能理解、能信任、能管理、能购买的产品。**

安装包很重要，但它是第二层。

第一层始终是：

- 产品定义
- 交互壳
- 可视化
- 解释性
- 治理能力

这些成立之后，安装包只是顺势交付，而不是硬拗出来的壳。
