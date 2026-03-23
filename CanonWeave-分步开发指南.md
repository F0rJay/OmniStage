# CanonWeave 分步开发指南

> 目标：将 CanonWeave 作为完整 C 端应用持续迭代上线，核心聚焦「单人酒馆体验 + 深度世界书自定义」。

---

## 0. 开发总原则

### 0.1 Conda + Node（推荐本地约定）

- 使用仓库根目录 **`environment.yml`** 维护 **`canonweave`** 环境：`conda env create -f environment.yml` 或 `conda env update -f environment.yml --prune`。
- 激活后由 Conda 提供 **`node` / `npm`**；**前端与工具链依赖**仍在仓库根执行 **`npm install`**（写入 `node_modules`，与 Conda 互补）。
- 启动 Web：`conda activate canonweave` → `npm run dev:web`。
- **模型网关**：推荐 **LiteLLM Proxy** 统一路由（`docker-compose.litellm.yml` + `docs/litellm.md`），Web 侧配置 `LITELLM_BASE_URL` / `LITELLM_API_KEY`。

- 先打通用户主链路，再做高级智能能力。
- 每个阶段都必须有可演示、可验收的结果。
- 世界书是核心资产，必须具备版本化与回滚能力。
- 复杂能力（多 Agent、联网补全、评测）逐步上线，不阻塞首发。
- 统一日志与追踪字段，保证排障与复盘效率。

---

## 1. Phase A：最小可玩闭环（M0，2~3 周）

### 1.1 阶段目标

让用户在产品内完成一次完整、可保存的 RP 会话。

### 1.2 交付范围

- 登录鉴权（Clerk/Auth0 任选其一）
- 酒馆主页 `"/tavern"` 与新建会话
- 会话页 `"/tavern/sessions/[sessionId]"` 流式聊天
- 模型选择（至少 1~2 个模型可切换）
- 线程与消息持久化（`threads` / `messages`）

### 1.3 技术要点

- 编排先采用单导演节点，确保稳定。
- `POST /api/chat` + SSE 优先落地。
- 明确 thread 归属校验与基础鉴权中间件。

### 1.4 验收标准

- 新用户 5 分钟内可开局并完成一轮互动。
- 首 token 延迟可接受（建议目标 < 3s）。
- 刷新后可恢复会话上下文。

---

## 2. Phase B：世界书导入与版本资产化（M1，3~4 周）

### 2.1 阶段目标

把“深度自定义世界书”做成产品主能力。

### 2.2 交付范围

- **会话绑定世界版本**：`threads.world_version_id` → 聊天时在 system 中注入该版本 `canonical_json`（过长截断）；会话页可选「世界 · vN」。
- **版本恢复与导入快照**：`world_versions.source_raw_json` 保存导入原文；`POST .../versions/restore` 将某历史版本 Canonical **追加为新版本号**（`restored_from_version_id` 溯源，不删历史）。
- 世界书导入页 `"/worlds/import"`
- 多格式解析（先 JSON + Markdown，再补 YAML）
- **AI Agent 解析（已落地切片）**：`POST /api/worlds/import` + `useAgent: true`，Markdown/纯文本 → 结构化 Canonical → 同套校验；详见 `docs/world-import.md`
- Canonical Schema 映射与校验
- `world_versions` 版本管理与回滚
- 字段级错误报告与重试

### 2.3 技术要点

- 优先规则引擎与 Schema 校验，LLM 只做兜底修复。
- 保留原始文件快照，便于审计和溯源。
- 支持 `locks`（锁定字段）防止后续补全覆盖。

### 2.4 验收标准

- 样本集导入成功率 > 90%。
- 导入失败可精确定位字段路径。
- 版本切换与回滚可用。

---

## 3. Phase C：酒馆体验强化与工具事件流（M2，3~4 周）

### 3.1 阶段目标

从“能聊天”升级为“可沉浸、可复盘”。

### 3.2 交付范围

- 会话事件流（`turn_started` / `tool_called` / `state_patched`）
- MCP 骰子工具（`dice_roller`）
- 会话事件日志 `session_event_logs`
- 会话回放基础能力

**当前仓库已落地的 Phase C 切片（可继续迭代）：**

- `session_event_logs` 表 + `GET /api/threads/[threadId]/events`
- 聊天 SSE 增加 `tool_called`；每回合持久化 `turn_started` / `turn_finished` / `error`
- 首行指令 `/roll 2d6`、`/r d20+3` → 服务端确定性掷骰（`dice_roller` 形状），结果注入模型上下文与会话事件
- 会话页可折叠「会话事件流」面板与刷新

**待办：** 时间线回放 UI（进阶）、叙事与工具过程分层展示。

**MCP：** `dice_roll`（`mcp-servers/dice-roller`）+ `world_reader` / `world_writer`（`mcp-servers/world-tools`）；Web 代理 `POST /api/mcp/world-reader|world-writer`；详见 `docs/mcp.md`。

**补充（state / 回放）：**

- `threads.session_state_json` + SSE / 事件 `state_patched`；掷骰后写入 `lastDice` 并注入系统提示。
- `GET /api/threads/[id]` 拉取当前状态；`PATCH` 支持 `sessionStatePatch` 浅合并并记事件。
- 事件流中 `turn_started` 可「跳转该轮」（锚定用户气泡 `chat-turn-N`）。

### 3.3 技术要点

- 工具调用统一 JSON 形状，便于审计与回放。
- 随机与规则类行为由确定性代码执行，不交给 LLM。
- UI 上将叙事与工具过程分层展示（可折叠）。

### 3.4 验收标准

- 关键事件全链路可追踪。
- 回放可还原关键剧情节点。
- 用户体验明显优于普通聊天界面。

---

## 4. Phase D：多 Agent 与记忆主线（M3，4~5 周）

### 4.1 阶段目标

提升剧情一致性与跨会话延续能力；**运行时**由「动态扮演引擎」承接多 NPC 与导演，**离线设定**仍由 WorldForge（§5）负责。

### 4.0 子系统 B：Dynamic RP Engine（动态扮演引擎）

**定位**：对接酒馆前端的**会话内**多 Agent 运行时——意图路由 →（动作线）环境判定 → 多 NPC 并行意图 → A2A 协调 → **导演流式**成文；对用户仍是一条助手气泡 + SSE。

**规格与演进**：`docs/dynamic-rp-engine.md`。

**当前仓库已落地（DRE-0 ~ DRE-4，可开关）**：

- **`CW_DYNAMIC_RP_ENGINE=1`** 开启；`CW_CHAT_MOCK=1` 时不启用。
- **`POST /api/chat`**：意图 `dialogue` | `action`；动作线多次 `generateObject` + 导演 `streamTavernCompletion`；SSE 含 `dre_intent` / `dre_environment` / `dre_a2a` / **`dre_entities`** / `dre_memory`；`session_event_logs` 可追溯。
- **DRE-1 / DRE-2**：见 `docs/dynamic-rp-engine.md`。
- **DRE-3**：`CW_DRE_MEMORY` + `dreMemory` 工作记忆与冲突台账。
- **DRE-4**：`CW_DRE_WORLD_ENTITIES` + 绑定世界版本时从 **`canonical_json.entities`** 解析目录，启发式（可选 **`CW_DRE_ENTITY_LLM`**）选取本回合 **实体锚点**，注入环境/NPC/导演/对话；`dynamicRp.lastEntityAnchors` 记录当拍 ID。
- 动作线会读取 **`lastDice`**；**动作回合**不挂载 Agent MCP；可选 **`dynamicRp.activeNpcs`**。
- **Mem0（Platform API）**：`CW_MEM0=1` + `CW_MEM0_PLATFORM_API_KEY` 时，`/api/chat` 回合前 `search`、回合后 `add`；见 **`docs/mem0.md`**（Next 内用 `MemoryClient`，不打包 `mem0ai/oss`）。
- **分层记忆**：`CW_LAYERED_MEMORY=1` 时，共享池 `sharedMemory` + NPC 私域 `privateMemory` + 表 **`cw_insights` 洞察层**；动作线注入 DRE 并由监督者抽取更新；详见 **`docs/layered-memory.md`**。

**待办（DRE-5+）**：环境状态机、`relations`/`lore_entries` 检索、跨会话长期 `ingest_memory`（Mem0 已覆盖部分长期语义记忆场景）。

### 4.2 交付范围

- **（进行中）** 子系统 B：运行时意图路由、多 NPC、导演汇总（见上）。
- 导演 + 多 NPC 并行节点（与 DRE 共用产品方向，记忆层另列）。
- 记忆分层（工作/会话/长期）
- 异步摄取任务（`ingest_memory`）
- 冲突检测（防“吃书”）

### 4.3 技术要点

- 写入优先级：系统规则 > 工具结果 > 导演结算 > NPC 主观描述。
- 冲突保留历史版本，不静默覆盖。
- 聚合节点负责口径统一，降低多 NPC 叙事冲突。

### 4.4 验收标准

- 多 NPC 一致性冲突率显著下降。
- 跨会话剧情承接稳定。
- 记忆写入成功率建议 >= 99%。

---

## 5. Phase E：WorldForge 补全与内容治理（M4，4 周）

### 5.0 子系统 A：WorldForge（世界熔炉）

**WorldForge** 定位为「多智能体设定流」：**解析与轻量图谱 → 多职能 Agent 并行生成 → 审查员对抗审查 → 条件边循环直至自洽 → 落库 Canonical 新版本**。  
与当前已实现能力的关系：**导入 / 编剧工坊 / 合并落库** 提供数据面与单线 LLM 能力；WorldForge 在其上增加**编排图、多角色与审查闭环**。

**详细规格与分步演进（WF-0～WF-4）见：`docs/world-forge.md`。**  
**WF-0～WF-3** 已在 Web 落地（**单图 LangGraph**）：`/worlds/[worldId]/world-forge` 以**单轮多 Agent 协作**为主交互（默认完整链；高级可选缩短路径），`POST .../world-forge/wf0`…`wf3` 为对应 API（见 `docs/world-forge.md`）。

**已实现要点（与愿景对齐）**：WF-2/3 在解析（及 WF-3 的图谱）之后 **`Send` 三轨并行**——**架构师 / 机制设计师 / 人物卡设计师**——扇入 **合成节点** 产出单一 Canonical；审查员 **`WF_REVIEWER_SYSTEM`** 须**同时**审查 **`world_book`（世界书条目质量）** 与 **`character_books`（人物书）**（见 `apps/web/src/lib/world-forge-review.ts`）。Canonical 可选 Lorebook 字段见 **`docs/world-lorebook-spec.md`**。

### 5.1 阶段目标

实现“补全增强而非改写世界”，并以 WorldForge 工作流承载**高质量、可审计**的设定生产（从模糊大纲到严谨规则）。

### 5.2 交付范围

- **WorldForge 编排**（建议 LangGraph 或等价状态机）：并行节点、审查节点、循环重试与最大轮次/降级策略。
- **解析员路径**：残缺文本/半成品世界书 → 结构化摘要 + 轻量实体–关系视图 + **设定缺口反问**（可与现有导入 Agent 渐进融合或并存）。
- **多职能生成**：**架构叙事 / 机制规则 / 人物卡与人物书** 三类 Agent **并行**扇出，扇入合成节点，聚合为单一 Canonical 草稿（当前实现为三轨并行，见 `docs/world-forge.md`）。
- **审查员路径**：一致性/平衡性审查 + **Lorebook 双轨同审**（`world_book` 与 `character_books` 并列，不可偏废）；结构化通过/不通过与打回理由；可选 ReAct 与工具扩展。
- **治理与产品**：世界补全子流程（可配置开关）、来源白名单、置信度阈值、引用追踪、Patch 审查与用户确认、一键回滚（与下述技术要点一致）。

### 5.3 技术要点

- 每条新增事实必须附来源和抓取时间。
- 锁定字段不可覆盖。
- 检索与抓取有成本配额上限，避免失控。
- **编排状态**中单写 Canonical 草稿或受控 Patch，避免多 Agent 直接写分裂数据源；落库仍走现有 `world_versions` 与校验。

### 5.4 验收标准

- 补全结果可解释、可追溯、可回滚。
- 用户设定不发生非预期漂移。
- 成本与性能可控。
- WorldForge：**审查未通过时可观测地打回重试**；通过后产出与现有导入/编剧**同一 Canonical 契约**，可绑定酒馆与版本恢复。

---

## 6. Phase F：上线与增长（并行 2~3 周）

### 6.1 阶段目标

从“可玩”升级到“可持续运营”。

### 6.2 交付范围

- 订阅与计费（Stripe）
- BYOK 安全存储（KMS）
- 限流、风控、告警
- 新手引导与留存漏斗

### 6.3 核心指标建议

- D1 / D7 留存
- 会话完成率
- 平均会话时长
- 世界书导入成功率
- 人均模型成本

---

## 7. 工程管理与验收机制

- 每周固定一次主链路演示（真实账号、真实会话、真实数据）。
- 每个需求卡必须包含验收标准和日志字段。
- 每阶段末执行固定回归剧本（线程回放 + 状态 diff）。
- 高风险功能必须配套可回滚策略。

---

## 8. 首周执行清单（建议）

- 完成鉴权与酒馆首页。
- 打通 `POST /api/chat` 流式返回。
- 建立核心数据表：`users` / `threads` / `messages` / `worlds` / `world_versions`。
- 完成 `GET /api/models` 与模型切换。
- 准备 10 份世界书样本用于导入测试基线。

---

## 9. 里程碑总结（建议版）

- **M0**：可玩闭环（开局、聊天、保存）
- **M1**：世界书资产化（导入、校验、版本）
- **M2**：酒馆体验增强（事件流、工具、回放）
- **M3**：记忆与一致性（多 Agent、冲突控制；**运行时**含 DRE-3 `dreMemory`、DRE-4 实体锚点，见 `docs/dynamic-rp-engine.md`）
- **M4**：WorldForge / 补全与治理（多 Agent 设定流、引用、审查、回滚；见 `docs/world-forge.md`）
- **M5**：运营与增长（计费、留存、监控）

