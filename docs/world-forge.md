# WorldForge（世界熔炉）— 子系统 A：多智能体设定流

> **状态：愿景 + 已实现基线**  
> **WF-0～WF-3** 由 **单一 LangGraph**（`world-forge-langgraph-unified.ts`）承载：**WF-2** 为 **`Send` 三轨并行**（架构师 ∥ 机制师 ∥ 人物卡设计师）→ 扇入 `synthesize`；**WF-3** 在并行前增加 **图谱 JSON** 节点（`world-forge-graph-blueprint.ts`）。审查员 ReAct、治理 UI、WF-4 等仍属规划，见 §6。

---

## 1. 定位

WorldForge 是一条**生产力向**的世界构建流水线：从模糊大纲或残缺文本出发，通过**多智能体协同 + 可循环审查**，收敛到可版本化的 **Canonical** 世界书（与现有 `world_versions`、酒馆绑定模型一致）。

典型场景：用户要构建**带独特力量体系、硬核规则**的历史/奇幻世界——系统协助完成从意象到**可执行规则与叙事约束**的落地，而不是单次聊天即终稿。

---

## 2. 目标能力（愿景）

### 2.1 文件解析与图谱构建（解析员 Agent）

- 用户上传**残缺设定**、半成品世界书或非结构化长文。
- **解析员 Agent**读取后构建**轻量级实体–关系视图**（不必一开始就是完整知识图谱，可从「实体列表 + 关系边 + 未解析片段」起步）。
- 基于图谱与文本对比，**标出设定空白**（缺字段、缺关系、缺规则边界），并以**反问/待办**形式推回给用户或下游节点。

### 2.2 多职能 Agent 并行生成

- 用户确认需求与缺口后，多个**角色化 Agent**在编排图中**并行**工作，例如：
  - **架构师 Agent**：宏大叙事、历史背景、势力与时间线骨架；
  - **机制设计师 Agent**：力量/科技/社会规则的**升级路径、代价、反噬与边界**，防止「口胡设定」无法落地。
  - **人物卡设计师 Agent**：人物书优先，沉淀角色关系、动机、禁忌、地名关联与扮演边界，减少 OOC/超游。
- 输出在**聚合节点**合并为单一草稿对象，仍须落入同一套 **Canonical Schema**（与导入/编剧合并共用校验），避免多源分叉吃书。
- 并行设计师与解析员可在运行环境支持时使用联网工具（如 `web_search` / `web_fetch_extract`）检索公开资料，用于术语校正与灵感补全，但必须与用户设定对齐并避免抄袭。

### 2.3 A2A 对抗审查（审查员 Agent）

- 初稿进入**审查员 Agent**：目标不是润色文笔，而是**一致性、平衡性与可叙事性**。
- 审查员可采用 **ReAct 式**调用（读 Canonical 片段、对比规则表、简单「强度/代价」启发式等），查找：
  - 逻辑自相矛盾；
  - 数值或设定强度**破坏世界平衡**（例如某技能无代价过强）；
  - 与 `locks`、用户显式锚点冲突。
- **Lorebook 双轨同审**：须同时审查 **`world_book`（世界范围条目质量）** 与 **`character_books`（人物书）**，不得因侧重人物书而弱化世界书；实现见 `world-forge-review.ts` 中 `WF_REVIEWER_SYSTEM`。
- 审查结论结构化：**通过 / 不通过 + 具体违规点 + 建议修改范围**。

### 2.4 循环重试（Cyclic Edges）

- 若审查不通过，编排层通过**条件边**将流程**打回** `expand` 修订（携带审查意见）。**尚未**实现「仅重跑某一并行轨」的选择性重算（见 §6 演进）。
- 循环直至达到「通过阈值」或「最大轮次」（需产品配置与用户可见的进度/中止），再进入**用户确认**与**写入新版本**（`createWorldVersion`）。

**编排实现方向（建议）**：使用 **LangGraph**（或等价显式状态机）表达节点、并行扇出与条件回边；**状态**中单写 Canonical 草稿指针或 JSON Patch 序列，避免多 Agent 各写各库。

---

## 3. 与当前实现对照

| 能力 | 当前 CanonWeave（约） | WorldForge 目标 |
|------|----------------------|-----------------|
| 非结构化 → Canonical | 导入 Agent、编剧「合并为新版本」各为**单次/单线** LLM + 校验 | 多阶段、多角色、可循环 |
| 缺口发现 | 主要靠用户与单会话编剧对话 | 解析员 + 图谱/清单驱动反问 |
| 并行角色 | WF-2/3：**LangGraph `Send` 扇出** 架构师 ∥ 机制师 ∥ 人物卡设计师，`NamedBarrier` 扇入合成 | 继续加更多并行轨、子图 |
| 审查 | 服务端 Schema/业务校验；无独立「对抗审查」Agent | 审查员 + 工具/ReAct |
| 编排 | **单一 `StateGraph`**，`WorldForgeProfile`：`wf0`…`wf3` | 继续加节点、工具、子图 |

---

## 4. 数据与产品原则（与 Phase E 一致）

- **真源**：仍以 **Canonical + `world_versions`** 为落库真相；WorldForge 运行中产生的过程态建议写入**运行记录表或事件流**（后续设计），便于审计与回放。
- **locks**：用户锁定项在审查与重写中**不可被静默覆盖**（与现有世界书原则一致）。
- **可追溯**：补全/改写建议应能关联到**来源片段、轮次、审查意见**（与分步指南 Phase E「来源、置信度、回滚」对齐）。
- **成本**：并行与 ReAct 会放大 token 消耗，需配额、超时与降级策略（例如审查轮次上限、弱化工具调用）。

### 4.1 双产物：图谱骨架 + Lorebook 本体

WorldForge / 导入管线除 `entities` / `relations` / `lore_entries` 等**骨架**外，应产出 **SillyTavern 风格可运营条目层**（对齐触发、位置、顺序等概念）：

| 产物 | Canonical 字段 | 用途 |
|------|----------------|------|
| 世界书本体 | **`world_book`** | 国家、文化、组织、历史等**与人物解耦**的全局设定；长文 + `keys`/`strategy` 约束 AI 边界 |
| 人物书 | **`character_books[]`** | 每项含 **`character_card`**（对齐 SillyTavern 完整角色卡：描述/性格/场景/开场/示例对话等）+ **`entries`** 触发向 Lore；绑定实体，减少 OOC |

规范与字段表见 **[world-lorebook-spec.md](./world-lorebook-spec.md)**。运行时按关键词合并进提示词属于后续注入引擎（与 `formatWorldContextForPrompt` 演进对接）。

---

## 5. 统一 LangGraph 工作流（WF-0～WF-3，已实现）

**产品语义**：用户发起**一轮**请求即可；**同一次**图运行内会**多次调用**不同 Agent（解析、图谱、并行角色、合成、审查等）——不是「先选四种产品再提交」。`WorldForgeProfile`（wf0～wf3）是**实现上的路径分支**（默认完整链 = wf3；缩短路径 = 更少节点/省 token），Web 面板以「单轮多 Agent 协作」为主文案，缩短选项收在高级里。

**一张图**、`StateGraph` + 条件边；WF-2/3 在 `parse`（及 WF-3 的 `graph`）之后用 **`new Send("architect", state)` + `new Send("mechanist", state)` + `new Send("character_designer", state)`** 扇出，三轨均 **`addEdge` → `synthesize`**，由 LangGraph **屏障**等待并行轨完成后扇入合成。

| Profile | 节点路径（简） | 说明 |
|---------|----------------|------|
| **wf0** | `parse` → `expand` → `END` | 解析后**单次**扩写为 Canonical，无审查。 |
| **wf1** | `parse` → `expand` ↔ `review` | 首扩写 + **审查员 JSON 判决**；不通过则回到 `expand`。 |
| **wf2** | `parse` → **并行** `architect` ∥ `mechanist` ∥ `character_designer` → `synthesize` ↔ `review`（失败 `expand` 修订） | 三轨**互不读对方成稿**；`synthesize` 合并为 Canonical + 审查闭环。 |
| **wf3** | `parse` → `graph`（结构化 **entities / relations / gaps**）→ **同上并行** → `synthesize` ↔ `review` | 图谱写入 state，注入架构师/机制师/人物卡设计师提示词；成功响应带 `graphBlueprint` 供 UI。 |

- **核心实现**：`world-forge-langgraph-unified.ts`  
- **图谱**：`world-forge-graph-blueprint.ts`（`generateObject` + 文本回退）  
- **入口**：`world-forge-wf0.ts` … `world-forge-wf3.ts`  
- **类型 / 步骤**：`world-forge-pipeline-types.ts`（含 `graph_blueprint` 步骤）  
- **UI**：`workflow-panel.tsx`（默认走 **stream** 实时步骤 + 末包结果）  
- **API**：`POST .../world-forge/wf0` | `wf1` | `wf2` | `wf3`；**流式进度**：`POST .../world-forge/stream`（`application/x-ndjson`，body 含 `profile` 等，与单次接口相同字段；先多行 `{"type":"progress",...}`，末行 `{"type":"result",...}`）  
- **并行约束**：`architect` / `mechanist` / `character_designer` 同一 super-step 内**不得**各写 `pipelineError`、`finished`、`success`（`LastValue` 冲突）；错误只写入 `steps`，由 `synthesize` 合并说明。  
- **Send 与模型**：图 state 仅存 `provider` + `modelId`，节点内 `getLanguageModelForProvider` 再取实例，避免 `Send` 拷贝导致 `doGenerate is not a function`。  
- **落库 source**：`world_forge_wf2_parallel`、`world_forge_wf3_graph_parallel` 等  

### 5.1 审查策略与用尽轮次

- **审查员倾向**：`world-forge-review.ts` 中审查员**优先放行**——轻微不一致、可补丁问题、时间线轻度前后矛盾等**不卡死**；仅 **locks 冲突、致命逻辑、结构不可用** 等才倾向 `passed:false`。
- **用尽最大轮次仍产出**：若最后一轮审查仍 `passed:false`，流水线会 **仍判成功（`ok: true`）** 并返回当前 **Canonical**（含 `world_book` / `character_books`），响应字段 **`reviewWarnings`** 携带残余意见；勾选落库时会**正常写入新版本**，便于你后续在版本或编剧里打补丁。
- **配置**：面板 **「最大审查轮次」** 可选 **1～10**（默认 3）；常量见 `world-forge-review-config.ts`。需要更多轮时请**分多次运行**或**人工改 JSON** 后再跑。
- **抢救/合并**：仍可勾选 **用尽轮次仍附带 lastNormalizedJson**（在**真失败**路径下有用；最佳努力成功路径直接返回 `normalizedJson`）。

**与愿景差距**：审查员尚无 ReAct/工具；审查打回仍走统一 `expand`（未拆「仅机制轨重算」）；WF-4 治理 UI 未做。

---

## 6. 后续演进（WF-4+）

1. **WF-4**：治理与产品化（Patch diff、来源、回滚与 Phase E 验收对齐）。  
2. 审查失败时**选择性重跑**某一并行轨或子图。  
3. 图谱节点与 UI 深挖（交互式缺口确认、子图）。

---

## 7. 相关文档与代码入口

| 主题 | 文档 / 代码 |
|------|-------------|
| **统一 LangGraph** | `world-forge-langgraph-unified.ts`，`world-forge-pipeline-types.ts` |
| **WF-0～3 路由** | `.../world-forge/wf0`…`wf3` 的 `route.ts`，`world-forge/stream/route.ts`，`workflow-panel.tsx` |
| **审查轮次上限** | `world-forge-review-config.ts` |
| **共用解析/扩写** | `world-forge-shared.ts` |
| 世界书导入 | `docs/world-import.md` |
| 编剧工坊 | `docs/world-screenwriter.md` |
| Canonical 校验 | `canonical-world.ts`（含可选 `world_book` / `character_books`） |
| Lorebook 规范 | [world-lorebook-spec.md](./world-lorebook-spec.md) |
| Phase E | `CanonWeave-分步开发指南.md` §5 |

---

## 8. 修订记录

| 日期 | 说明 |
|------|------|
| 2026-03-22 | 初版：子系统 A 愿景、与现状对照、演进路线；与 Phase E 文档互链。 |
| 2026-03-22 | WF-0 实现：两步流水线 API + `/worlds/[id]/world-forge` 试验页；导出 `WORLD_IMPORT_SYSTEM` 供扩写复用。 |
| 2026-03-22 | WF-1：审查员 JSON 判决 + 扩写循环；`world-forge-shared.ts` 抽取共用解析/扩写；`maxDuration` 放宽。 |
| 2026-03-22 | WF-1 改为 **LangGraph** `StateGraph`；新增 `world-forge-review.ts` 等。 |
| 2026-03-22 | **统一图**：`world-forge-langgraph-unified.ts` 合并 WF-0/1/2；删除独立 `world-forge-langgraph-wf1.ts`。 |
| 2026-03-22 | Canonical 扩展可选 **`world_book` / `character_books`**；新增 [world-lorebook-spec.md](./world-lorebook-spec.md)；`WORLD_IMPORT_SYSTEM` 与 WF 扩写提示要求产出 Lorebook 本体。 |
| 2026-03-22 | WF-2/3：**`Send` 并行扇入合成**（演进为 **三轨**：架构师 ∥ 机制师 ∥ 人物卡设计师）；新增 **WF-3** 图谱节点 + `wf3` API；`world-forge-graph-blueprint.ts`。 |
| 2026-03-22 | 产品呈现：**单轮多 Agent 协作**（非「四档切换」）；面板默认完整链，缩短路径收高级。 |
| 2026-03-22 | 审查员提示升级：**显式保留并强化** `world_book` 世界书质量审查，与 `character_books` 并列（`world-forge-review.ts`）。 |
| 2026-03-22 | 文档同步：`README`、Phase E（`CanonWeave-分步开发指南.md`）、`CanonWeave-完整落地方案-SOTA.md` §3.4 实现对照、`world-import` / `world-screenwriter` / `mcp` / `world-lorebook-spec` 与主文一致。 |
| 2026-03-22 | `character_books[]` 每项约定 **`character_card`**（SillyTavern 语义完整角色卡）；人物卡设计师提示、合成说明、`WORLD_IMPORT_SYSTEM`、审查员与 `world-lorebook-spec.md` §3 已对齐。 |
| 2026-03-23 | 审查轮次：硬上限由 5 提至 **10**，抽离 `world-forge-review-config.ts`；文档 §5.1 说明用尽轮次时的处理建议。 |
| 2026-03-23 | 审查**放宽** + **用尽轮次仍成功落稿**：`WF_REVIEWER_SYSTEM` 倾向放行轻微问题；`nodeReview` 达上限时 `success:true` 并返回 `reviewWarnings`；`WorldForgePipelineSuccess.reviewWarnings`；API/UI 透传。 |
