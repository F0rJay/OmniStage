# CanonWeave 完整落地方案（SOTA 现成能力优先 · 多模型 API）

> 本文是在《角色扮演应用全栈方案设计》基础上的**可执行落地版**：写清**应用如何从头到尾运转**，各层尽量用**成熟产品 / 官方 SDK / 托管服务**，**不自研协议、不自研向量引擎、不自研工作流运行时**。  
> **所有 Agent / LLM 推理均通过 HTTP API 调用**；**终端用户可选择使用哪一家、哪一个具体模型**（含自带 Key 的 BYOK 可选）。

---

## 1. 设计原则（避免手搓）

| 原则 | 落地做法 |
|------|----------|
| 编排与状态机 | **LangGraph**（Python 或 JS 官方栈）+ 官方 **Checkpoint / Postgres** 持久化 |
| 模型调用 | **统一网关**：**LiteLLM Proxy** 或 **OpenRouter**，或 **Vercel AI SDK**（若前端直连需配合服务端代理） |
| 工具与外部世界 | **MCP**：用现成 **MCP Server**（官方/社区）+ 少量业务封装；骰子等用 **确定性代码 MCP** |
| 记忆 | **默认主线：Mem0（开源）** 作为统一记忆层；底层可接 **Qdrant/Pinecone/pgvector + Neo4j/Memgraph**，或按预算切到托管记忆产品 |
| 前端 | **Next.js App Router** + **Vercel AI SDK `useChat` / streamText** 或 **EventSource(SSE)** 消费后端流 |
| 观测与评测 | **LangSmith**（trace）+ **Braintrust / OpenEvals**（可选）+ **LLM-as-judge 用同一网关调裁判模型** |
| 身份与计费 | **Clerk / Auth0** + **Stripe**（订阅）+ **BYOK** 仅存 **用户自管 Key 的 KMS/加密字段**（见安全节） |

**不自研清单（明确禁止浪费工期）**：向量索引算法、图数据库内核、SSE 协议、OAuth 协议、支付对账、LLM 负载均衡（交给 LiteLLM/OpenRouter）。

---

## 2. 角色与对象模型（谁在用、存什么）

- **用户（User）**：登录、选模型、创建「世界/单人会话」、消费 Token 或自带 Key。  
- **世界（World）**：优先来自**用户导入世界书**（SillyTavern/通用 JSON/YAML/Markdown），经解析后落成结构化设定 + 版本号；WorldForge 仅作补全。Canonical 除实体/关系/规则等骨架外，可含可选 **`world_book`（世界书本体）** 与 **`character_books`（人物书）** 条目层（见 `docs/world-lorebook-spec.md`）。  
- **会话线程（Thread）**：LangGraph 的 `thread_id`，对应一次跑团/一条故事线。  
- **消息（Message）**：用户输入、导演输出、NPC 子轨迹（可折叠展示）。  
- **世界状态（WorldState）**：图谱节点/边 + 关键事实表 + 当前场景 id。  
- **Agent 角色（运行时）**：导演、NPC_i、法官（设定期）、工具执行器（无 LLM）。

### 2.1 单人酒馆域模型（Solo Tavern Layer，产品壳）

> 产品形态是“单人酒馆工作台”：一个用户在自己的酒馆空间里导入世界书、配置 Agent、进行沉浸式 RP。

- **单人酒馆（SoloTavern）**：用户私有空间，绑定偏好模型、默认世界版本与 UI 布局。  
- **会话（Session）**：一次单人剧情线程，绑定一个 `world_version`。  
- **驻场角色（Resident NPC）**：酒保、向导、公告官等，增强产品叙事一致性。  
- **会话日志（SessionEventLog）**：投骰、工具调用、剧情里程碑、世界状态变更摘要。  
- **会话资产（SessionAssets）**：世界书快照、角色卡、附件、回放摘要。

---

## 3. 端到端运作流程（用户视角 + 系统视角）

### 3.1 总览泳道（建议印在团队墙上）

```
用户(浏览器) → Next.js(BFF) → API(编排服务) → LangGraph → LiteLLM/OpenRouter → 各厂商 LLM API
                    ↓                ↓                ↓
                 Clerk           Postgres        Checkpointer
                    ↓                ↓                ↓
                 Stripe          世界/消息表      Redis(队列/限流)
                    ↓                ↓
                              向量库 + 图库 + 对象存储(导出)
```

### 3.2 流程 A：注册与选模型（每次会话可改）

1. 用户 **Clerk 登录**。  
2. 前端拉取 **`/api/models`**：由服务端读取 **LiteLLM/OpenRouter 模型列表**（或维护一份白名单映射表：展示名 → `model_id`）。  
3. 用户选择：  
   - **平台模型**：走你方统一计费（Stripe Metering / 预购包）。  
   - **BYOK**：用户在设置页粘贴 OpenAI/Anthropic/Google 等 Key（**仅服务端加密存储**，见 §8）。  
4. 选项写入 **`user_preferences`** 与当前 **`thread` 元数据**（`provider` + `model` + `routing`）。

**SOTA 要点**：用 **LiteLLM** 可在服务端一份配置支持多供应商、`fallbacks`、`rpm/tpm` 限流、统一日志字段。

### 3.2.1 流程 A2：单人酒馆初始化与开局（新增主链路）

1. 用户进入 **`/tavern` 单人酒馆主页**，选择默认世界与默认模型。  
2. 用户点击「开始新会话」：选择 `world_version`、难度与规则模板。  
3. 系统创建 `session_id`，写入 `sessions` + `session_settings`。  
4. 若用户导入了世界书，默认绑定其最新 `world_version`；也可在会话设置中切换版本。  
5. 会话采用 **SSE 增量事件**：`turn_started`、`dice_rolled`、`tool_called`、`state_patched`。  
6. 每条事件写入 `session_event_logs`，用于回放与复盘摘要。

### 3.3 流程 B：WorldBook 导入与解析（主路径，深度自定义）

**触发**：用户上传完整世界书文件（可多文件打包）或粘贴整段设定文档。

**系统步骤**：

1. **API** 创建 `world_job_id`，写入 DB：`status=queued`。  
2. **Parser Worker**（Celery / BullMQ / LangGraph Cloud Job，择一托管）拉取任务，启动 **LangGraph 子图 `world_import`**。  
3. 子图节点（尽量非 LLM，必要时才调用 API）：  
   - `detect_format`：识别来源与格式（SillyTavern Lorebook JSON、类 Tavern 卡片、YAML、Markdown、纯文本）。  
   - `schema_validate`：按已知 Schema 校验（Ajv/Pydantic），可直接通过则不改写。  
   - `normalize_to_canonical`：映射为你方统一 Canonical Schema（`entities`、`relations`、`rules`、`lore_entries`、`triggers`）。  
   - `llm_repair_optional`：仅在缺字段/脏字段时调用 API 做结构修复（JSON mode + 严格 schema）。  
   - `conflict_scan`：检测互斥设定、循环依赖、冲突触发词，生成 `warnings`。  
   - `build_indexes`：写入向量库/图库/全文索引，生成检索键与触发规则。  
4. 产物入库：`worlds`（主版本）+ `world_versions`（版本快照）+ 原始文件对象存储；前端 **SSE** 推送阶段：`upload`/`validate`/`normalize`/`index`/`done`。  
5. 若解析失败：返回**可修复报告**（精确到字段路径），用户可在 UI 一键修复并重试。

**SOTA 要点**：导入链路以 Schema 与规则引擎为主，LLM 只做兜底修复；避免“模型重写世界书”导致用户设定漂移。

### 3.4 流程 B2：WorldForge（补全路径，不是主入口）

**触发**：用户没有完整世界书，或导入后主动点击「自动补全空白设定」。

**系统步骤**：

1. **API** 创建 `world_patch_job_id`。  
2. 启动 **LangGraph 子图 `world_forge_patch`**，输入为现有 Canonical World。  
3. 子图节点（每个节点 = 一次 API 调用）：  
   - `extract_gaps`：识别缺失维度（地理、派系、时间线等）。  
   - `web_research_optional`：按需调用联网检索工具，搜索相关小说设定、世界观资料、酒馆社区条目作为参考证据。  
   - `source_rank_and_filter`：按来源可信度、时效性、相关性打分，过滤低质/广告/无授权来源。  
   - `evidence_to_facts`：将检索结果抽取成结构化事实（带 `source_url` 与 `confidence`），禁止直接复制长文本。  
   - `parallel_domain_agents`：并行生成补丁草稿。  
   - `debate_round`：法官 + 对抗角色多轮审查，输出 `patch JSON`。  
   - `apply_patch_with_guardrails`：仅允许修改白名单字段，禁止覆盖用户锁定条目。  
4. 写入 `world_versions` 新版本，附带 `citations`（引用来源列表）与 `research_trace`（检索轨迹），支持一键回滚。

**联网学习原则（补全阶段）**：

- 以用户原世界书为主，联网结果只作“补证与启发”，不覆盖用户锁定设定。  
- 输出必须是“抽象规则/事实摘要”，避免复制受版权保护的大段原文。  
- 每条外部启发都应可追溯到来源 URL 与抓取时间，便于用户审阅与禁用。

#### 实现现状对照（仓库 Web，持续演进）

本节上文描述的是 **B2 愿景**（含联网检索证据链、`patch` 白名单等）。**当前已落地的 WorldForge 主路径**见 **`docs/world-forge.md`**，代码入口 `apps/web/src/lib/world-forge-langgraph-unified.ts`：

- **WF-0 / WF-1**：解析 → 单次或循环 **扩写为 Canonical** →（WF-1）审查。  
- **WF-2 / WF-3**：解析 →（WF-3）**图谱蓝图** → **`Send` 三轨并行**：架构师、机制设计师、**人物卡设计师** → **合成**为 Canonical → **审查**循环。  
- Canonical 除骨架字段外，可选 **`world_book`** / **`character_books`**（SillyTavern 风格条目层），规范 **`docs/world-lorebook-spec.md`**；校验 `apps/web/src/lib/canonical-world.ts`。  
- 审查员提示 **`WF_REVIEWER_SYSTEM`** 明确要求 **世界书与人物书质量同审**（`apps/web/src/lib/world-forge-review.ts`）。  
- **联网 MCP**（如 `web_search` / `web_fetch_extract`）：当前 **未**作为 LangGraph 节点接入；解析员与各设计师的**系统提示**中已预留「宿主若提供工具则可检索」的说明，与上文本节愿景可逐步收敛。

### 3.5 流程 C：运行时扮演（核心 RP 循环）

**单次用户发送消息**：

1. **Next.js BFF** `POST /api/chat`：`{ threadId, text, modelChoice }`。  
2. **鉴权**：Clerk session → `user_id`，校验 `thread` 归属。  
3. **编排服务** 组装 **LangGraph `runtime` 图** 输入状态：  
   - 最近 k 轮对话（DB）  
   - **检索记忆**（见 §4）  
   - 当前世界版本、场景、NPC 列表  
4. **导演节点**（一次 API）：意图分类 + 是否触发全局事件 + 需要唤醒哪些 NPC。  
5. **并行 NPC 节点**（LangGraph 并行）：每个 NPC **独立 API 调用**（可同一模型或按配置映射不同「性格模型」——仍为用户可选策略）。  
6. **聚合节点**（一次 API）：合成最终叙事 + 标注「谁说了什么」。  
7. **工具阶段**（MCP）：骰子、改图谱、改物品栏等——**工具结果写回状态**，必要时 **再调一次**「润色输出」API。  
8. **持久化**：Checkpoint + 消息表 + 异步 **记忆摄取**（见 §4.3）。  
9. **流式返回**：LangGraph `stream_mode` → **SSE** → 前端展示 + 中间态（思考/工具）用 **UI 折叠面板**。
10. 输出仅回传当前用户会话，并按权限策略控制世界写入工具（默认仅导演/系统节点可写）。

**关键**：整条链路 **模型 ID 来自用户选择**，在调用 LiteLLM 时作为 `model=` 传入；BYOK 时在 LiteLLM 层切换 **virtual key** 或 **provider credential**。

### 3.6 流程 D：记忆写入与检索（后台管道）

- **同步路径**：本轮必须用的「热记忆」在导演前 **RAG 检索** 完成。  
- **异步路径**：消息落库后，**Inngest / Cloud Tasks** 触发 `ingest_memory`：  
  - 实体/关系抽取：**一次结构化输出 API**（JSON mode）  
  - 写入 **图库** + **向量库**（embedding 仍走 API：`text-embedding-3-*` 等）

### 3.7 流程 E：评测与回归（CI）

- **固定 thread fixture**  replay：同输入比对 **世界状态 diff**（图查询）+ **工具调用 JSON**。  
- **LLM-as-judge**：裁判模型通过 **同一 LiteLLM**，打分写入 LangSmith Dataset。

---

## 4. 记忆与检索：推荐「现成组合」（按预算三档）

> 为吸收“记忆机制优化版”优势，本方案将 **Mem0** 设为默认记忆中枢，其他向量库/图库是其可替换后端，而不是并列互斥方案。

### 4.0 记忆主线（默认）: Mem0

- **定位**：统一管理记忆写入、检索、更新策略，避免每个 Agent 各写一套记忆逻辑。  
- **部署**：优先使用 Mem0 开源版自托管（数据可控）；需要更少运维时再切托管层。  
- **原则**：不自研记忆框架内核，只做 RP 场景适配（字段映射、可见性、冲突规则）。

### 4.1 三层记忆映射（执行规范）

- **工作记忆（Working Memory）**：当前回合临时上下文（导演节点前后 1~2 步），生命周期短。  
- **短期记忆（Session Memory）**：单会话内有效，记录近期事件、NPC 态度变化、场景状态。  
- **长期记忆（Long-term Memory）**：跨会话保留，包含世界事实、实体关系、规则约束与里程碑。

### 4.2 私有记忆 / 共享记忆可见性规则

- **NPC 私有记忆**：仅该 NPC Agent 可读（角色秘密、偏见、个人目标）。  
- **会话共享记忆**：导演 + 场景内 NPC 可读（地形变化、公共事件、已公开信息）。  
- **世界公共记忆**：所有会话可检索（世界硬规则、稳定事实）。  
- **写入约束**：工具调用结果优先写共享记忆；推测性内容先写工作记忆，确认后再晋升。

### 4.3 写入时机与冲突消解（防“吃书”）

- **写入时机**：`工具返回成功`、`导演结算完成`、`回合结束` 三个检查点触发。  
- **冲突检测**：新事实写入前执行 `conflict_scan`，标记互斥事实与时间冲突。  
- **优先级**：`系统硬规则 > 工具确定结果 > 导演结算 > NPC 主观描述`。  
- **时间规则**：同实体同属性冲突时，默认新时间戳覆盖旧值，但保留历史版本可回溯。

### 档 ① 最快 MVP（尽量少服务）

- **Supabase Postgres**：`pgvector` 存段落向量；**一张 `facts` 表**存结构化事实（时间戳、来源 message_id）。  
- **检索**：混合 **向量 TopK + SQL 过滤**（场景 id、实体 id）。  
- **矛盾检测**：定时任务用 **一次 API** 输出 `conflict_candidates` + 规则优先（时间戳新者胜）。

### 档 ② 平衡（接近原文 GraphRAG 设想）

- **Neo4j Aura** 或 **Memgraph Cloud**：关系与多跳。  
- **Qdrant Cloud** 或 **Pinecone**：模糊召回。  
- **编排**：检索并行 → **RAG Fusion**（现成库如 `rank-bm25` + 向量重排可用 **Cohere Rerank API** 或开源交叉编码器托管）。

### 档 ③ 记忆 SaaS（最少自研）

- **Zep** 等托管「对话记忆」产品（按官方 API 接入），把 **摄取与检索** 外包；你方只保留 **世界设定** 与 **LangGraph 状态** 在自家库。

**原则**：不在第一期自研「时序图谱推理引擎」；用 **图查询 + 时间属性** 完成 80% 需求。

### 4.6 A2A 审查闭环（吸收优化版能力）

- 在世界书补丁阶段启用 **生成 Agent ↔ 审查 Agent** 的循环审查（最多 3 轮）。  
- 审查 Agent 每轮必须引用记忆检索结果（规则条目、历史版本、冲突记录）给出可执行修复建议。  
- 若 3 轮后仍冲突，进入 **Human-in-the-loop**：把冲突条目与建议 patch 直接呈现给用户确认。

### 4.7 记忆机制验收 KPI（可测试）

- **记忆检索命中率**（Top-K 包含正确事实）`>= 95%`。  
- **设定冲突率**（每 100 回合）`<= 4`。  
- **记忆写入成功率**（含重试）`>= 99.5%`。  
- **会话恢复成功率**（断线续跑）`>= 99%`。  
- **多 NPC 一致性偏差率**（同事件叙述冲突）`<= 5%`。

### 4.4 世界书导入的 Canonical Schema（建议固定）

为避免不同来源格式导致运行时混乱，导入后统一落为一份 Canonical JSON（建议版本化）：

- `meta`：世界名、作者、版本、来源格式、导入时间。  
- `entities`：角色/组织/地点/物品（含唯一 id、别名、标签）。  
- `relations`：实体关系（`subject`、`predicate`、`object`、`valid_time`）。  
- `rules`：世界硬规则（魔法边界、科技约束、死亡/复活规则）。  
- `timeline`：关键事件与时间锚点。  
- `lore_entries`：Lorebook 条目（文本、触发词、优先级、启用条件）。  
- `locks`：用户锁定字段（后续生成补全不得覆盖）。  
- `warnings`：导入阶段识别出的冲突与不确定项。

### 4.5 导入兼容策略（现成优先）

- **优先原生支持**：SillyTavern Lorebook JSON（直接映射）。  
- **通用文本格式**：Markdown/YAML/纯文本先做结构抽取，再写入 Canonical。  
- **多文件打包**：支持 zip（设定主文档 + 角色卡 + 地图描述），对象存储保留原件。  
- **失败可修复**：返回字段级错误（如 `lore_entries[12].keys missing`），用户可在 UI 修后重跑。  
- **最小模型介入**：只有在规则无法自动修复时才调用 LLM API 做结构补全，且输出受 Schema 强约束。

---

## 5. 多模型（用户可选）的技术实现

### 5.1 推荐架构：LiteLLM 作为唯一出口

```
应用代码 → LiteLLM SDK/HTTP → 供应商 API（OpenAI / Anthropic / Google / DeepSeek / …）
```

- **用户可选模型**：前端展示 `model_list`（过滤：你已开通的供应商 + 用户 BYOK 可用供应商）。  
- **线程级覆盖**：`threads.default_model` 覆盖用户默认。  
- **按 Agent 映射（可选高级）**：`director_model` / `npc_model` / `judge_model` 三个下拉，仍全部走 LiteLLM。  
- **观测**：LiteLLM 打点到 **LangSmith**（或 OpenTelemetry → Grafana Cloud）。

### 5.2 OpenRouter 模式（更省对接）

- 适合「一钥多模型」的快速迭代；仍建议在服务端代理，**禁止浏览器直连暴露 Key**。

### 5.3 API 形状（建议统一）

- 内部只认：`{ provider, model, messages, tools?, response_format? }`  
- 由 **LiteLLM Router** 转成具体供应商请求。

---

## 6. MCP：建议直接用的类型 + 你们只写薄封装

| 能力 | 现成方案 |
|------|----------|
| 官方/社区 MCP | **Filesystem / GitHub / Postgres / Brave** 等（按需启用） |
| 骰子与随机 | **自写 50 行 MCP**：`roll(dice_expr) -> int`（禁止让 LLM 算随机数） |
| 世界读写 | **自写 MCP**：封装对 Neo4j / Supabase 的 **受控 Cypher/SQL**（白名单操作） |
| 联网检索学习 | **WebSearch MCP/搜索 API**：仅抓取摘要与元信息，进入证据抽取节点后再用于补全 |
| MCP Host | **LangChain MCP Adapters** / **OpenAI Agents SDK MCP**（选一条技术栈统一） |

**不要**：自研 MCP 传输层；用官方 **stdio/SSE** 客户端即可。

### 6.1 联网检索工具治理（世界书补全专用）

- **白名单来源**：优先百科/设定站点/公开社区文档；支持用户自定义“可信站点清单”。  
- **黑名单策略**：盗版聚合站、低质量搬运站、无法确认来源站点默认禁用。  
- **配额控制**：每次补全最多 `N` 次搜索、`M` 个页面，防止成本失控。  
- **证据门槛**：低于阈值（如 `confidence < 0.6`）的事实不得自动写入世界书。  
- **用户可控**：提供“允许联网学习”开关与“仅本地资料模式”。

### 6.2 MCP 工具清单与优先级（可直接排期）

| 优先级 | 工具名 | 类型 | 主要用途 | 负责人建议 |
|---|---|---|---|---|
| P0 | `world_reader` | 自写 MCP | 读取 Canonical 世界书、规则、实体关系 | 后端 |
| P0 | `world_writer` | 自写 MCP | 写入补丁、更新版本、记录 citations | 后端 |
| P0 | `dice_roller` | 自写 MCP | D20/D100 等确定性检定 | 后端 |
| P0 | `memory_query` | Mem0 适配 | 工作/短期/长期记忆检索 | 后端 |
| P1 | `web_search` | 外部 API 封装 | 搜索公开资料（小说设定/世界观术语/酒馆社区） | 平台 |
| P1 | `web_fetch_extract` | 外部 API 封装 | 拉取网页摘要、正文抽取、清洗 | 平台 |
| P1 | `source_ranker` | 自写工具 | 来源打分与白名单过滤 | 平台 |
| P1 | `citation_builder` | 自写工具 | 生成 `citations` 与 `research_trace` | 后端 |
| P2 | `lore_diff` | 自写工具 | 世界书版本 diff、补丁可视化 | 前后端协作 |
| P2 | `safety_guard` | 自写工具 | 高风险补丁拦截（覆盖锁定字段/低置信来源） | 后端 |

**MVP 建议顺序**：先上 `P0`（保证能玩、能写、能记），再上 `P1`（联网学习增强），最后 `P2`（体验与治理增强）。

### 6.3 工具调用接口模板（统一 JSON 形状）

> 所有工具统一走 `tool_call` 封装，便于审计与回放。

```json
{
  "tool_name": "world_reader",
  "session_id": "sess_xxx",
  "thread_id": "thread_xxx",
  "actor": "director_agent",
  "arguments": {},
  "trace_id": "trace_xxx"
}
```

#### 6.3.1 `web_search`（联网搜索）

```json
{
  "tool_name": "web_search",
  "arguments": {
    "query": "蒸汽朋克 酒馆 设定 阶级冲突",
    "top_k": 5,
    "allowed_domains": ["wikipedia.org", "fandom.com", "docs.sillytavern.app"],
    "language": "zh-CN"
  }
}
```

#### 6.3.2 `world_reader`（读取世界书）

```json
{
  "tool_name": "world_reader",
  "arguments": {
    "world_id": "world_xxx",
    "world_version": 12,
    "query": {
      "entities": ["酒保", "灰港公会"],
      "rules": ["夜间施法限制"],
      "timeline_after": "Y3-M2"
    }
  }
}
```

#### 6.3.3 `world_writer`（写入补丁）

```json
{
  "tool_name": "world_writer",
  "arguments": {
    "world_id": "world_xxx",
    "base_version": 12,
    "patch": {
      "rules": [{"id": "r_magic_night", "op": "update", "value": "午夜后仅允许仪式法术"}],
      "entities": [{"id": "npc_bartender", "op": "create", "name": "洛温"}]
    },
    "citations": [
      {"url": "https://example.com/lore-article", "title": "Lore Article", "confidence": 0.78}
    ],
    "respect_locks": true
  }
}
```

#### 6.3.4 `memory_query`（Mem0 检索）

```json
{
  "tool_name": "memory_query",
  "arguments": {
    "scope": "session_shared",
    "query": "玩家与酒保最近冲突原因",
    "top_k": 8,
    "filters": {"session_id": "sess_xxx"}
  }
}
```

### 6.4 工具失败回退策略（必须实现）

- `web_search` 失败：降级到本地世界书 + Mem0 记忆补全，不阻塞主流程。  
- `world_writer` 失败：进入重试队列，超过阈值触发人工确认，禁止静默丢失。  
- `memory_query` 超时：回退最近回合缓存（Last-K turns），并标记低置信输出。  
- 任意工具异常：必须写 `tool_error_event` 到 `session_event_logs`，便于复盘。

---

## 7. 前端与实时（Next.js）

- **UI**：**shadcn/ui** + **Tailwind**（现成组件）。  
- **流式**：优先 **Vercel AI SDK**（若编排是 **LangGraph.js**）；若编排是 **Python**，用 **FastAPI SSE** 或 **Next Route Handler** 反向代理 SSE。  
- **状态**：**TanStack Query** 管理服务端状态；线程内事件用 **Zustand** 存 UI 折叠状态即可。  
- **协作（可选后期）**：先不做实时多人；若未来需要“围观/共创”，再引入异步分享与评论流。

### 7.1 单人酒馆前端信息架构（必须有）

- `"/tavern"`：单人酒馆主页（继续会话、最近世界、快捷设置）。  
- `"/tavern/sessions/[sessionId]"`：单人会话页（聊天流、投骰区、工具事件流、状态视图）。  
- `"/worlds/import"`：世界书导入页（拖拽上传、校验报告、版本比较）。  
- `"/worlds/[worldId]/versions"`：世界版本页（diff、回滚、锁定字段）。  
- `"/profile"`：个人中心（模型偏好、BYOK、导入历史、收藏世界）。

---

## 8. 数据与安全（上线必备）

- **密钥**：BYOK 用 **KMS 加密**（AWS KMS / GCP KMS）存密文；运行时解密仅在 **编排 Pod** 内存。  
- **租户隔离**：`thread_id` / `world_id` 全表强制 **user_id** RLS（Supabase）或 **WHERE** 断言。  
- **工具安全**：MCP 仅允许 **参数化查询**；图/SQL **禁止自由文本**。  
- **合规日志**：LangSmith **PII 脱敏规则**；欧盟用户考虑数据驻留（选 EU 区托管）。
- **版权与抓取合规**：只保存必要摘要与引用，不缓存受版权保护的大段正文；遵守站点条款与 robots 策略（若适用）。

---

## 9. 分阶段交付（可排期）

| 阶段 | 目标 | 主要依赖 |
|------|------|----------|
| **M0（2 周）** | 单用户单线程聊天 + 选模型 + 流式 | Clerk + Next + LiteLLM + LangGraph + Postgres Checkpoint |
| **M1（+3 周）** | 世界书导入（JSON/YAML/MD）+ 校验 + Canonical 映射 + 版本管理 | 同上 + 对象存储 + Job 队列 + Ajv/Pydantic |
| **M2（+4 周）** | 单人酒馆主页 + 新建会话 + 会话事件日志 + 导演 + 单 NPC 并行 | pgvector 或 Qdrant |
| **M3（+4 周）** | Mem0 记忆主线 + 图记忆 + 导入冲突检测 + 评测数据集 | Mem0 + Neo4j Aura + LangSmith Dataset |
| **M4** | 单人深度体验优化（回放、总结、世界状态可视化、导入修复助手） | 同上 + 对象存储/队列 |

---

## 10. 团队分工（参考）

- **1 人**：Next.js BFF + 鉴权 + 模型选择 UI + SSE。  
- **1 人**：LangGraph 图 + LiteLLM + MCP 薄封装 + Postgres。  
- **0.5 人**：记忆管道 + 检索调参 + 评测脚本。  
- **0.5 人**：Stripe 计费与用量对账。

---

## 11. 与原文架构的映射（方便对照）

| 原文模块 | 落地替代（现成优先） |
|----------|----------------------|
| LangGraph 编排 | LangGraph + Checkpointer（Postgres） |
| 分层记忆（优化版吸收） | **Mem0（默认）** + Qdrant/Pinecone/pgvector + Neo4j/Memgraph（可替换） |
| 用户世界书导入 | Schema 校验（Ajv/Pydantic）+ Canonical 映射 + 版本化 |
| A2A 对抗 | 多 Agent **皆为 Chat API**，用 LangGraph 控制轮次；**不实现自定义 A2A 传输** |
| MCP 工具链 | 官方 MCP Host + 自写 2～3 个领域 MCP |
| SSE 前端 | Vercel AI SDK 或原生 EventSource |
| 评测 | LangSmith +（可选）Braintrust |

---

## 12. 你方只需「手写」的最小代码清单（其余接 SDK）

1. **LangGraph 状态 Schema + 节点函数**（调用统一 `chat()` 封装）。  
2. **LiteLLM 路由配置** + **模型列表白名单**。  
3. **世界书导入解析器**（格式识别、Schema 校验、Canonical 映射、错误报告）。  
4. **Mem0 适配层**（私有/共享/公共记忆路由 + 写入时机 + 冲突规则）。  
5. **2～3 个 MCP**：骰子、世界读、世界写。  
6. **联网检索适配层**（来源白名单、证据评分、引用回填、版权约束）。  
7. **World / Thread / Message** 的 CRUD 与 RLS。  
8. **ingest_memory 异步任务**。  
9. **SSE 桥接**（Python→Next 或全栈 JS 选一）。

---

**结论**：完整应用 = **「用户世界书导入优先 + LangGraph 状态机 + LiteLLM 多模型 + 托管数据库/向量/图 + MCP 工具 + Next 流式 UI」**；用户选模型 = **线程/用户偏好写入 + 每次 API 透传 model id**。在此边界内，**尽量不手搓基础设施**，把创新放在 **设定资产管理、剧情结构、评测与产品体验**。
