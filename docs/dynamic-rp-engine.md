# Dynamic RP Engine（动态扮演引擎）· 子系统 B

## 定位

对接**酒馆前端**的运行时多 Agent 系统：在单条用户消息上打破「单体模型一口气说完」的局限，按意图分流，在**动作线**上显式跑 **环境判定 → 多 NPC 并行意图 → A2A 协调摘要 → 导演流式成文**，最终仍通过现有 **SSE `token` 流**落到同一条助手气泡（产品体验不变，幕后可观测）。

与 **WorldForge（子系统 A）** 的关系：WorldForge 偏**离线/半离线**设定生产；DRE 偏**会话内**叙事运行时。二者共享同一套模型路由（`getLanguageModelForProvider` / `streamTavernCompletion`），但**不共用** LangGraph 图（避免把酒馆延迟拉到 WorldForge 级别）。

## 架构（目标 vs 当前落地）


| 环节 | 目标能力 | 当前落地 |
|------|----------|----------|
| 意图路由 | 网关区分对话 / 动作 | **规则** + 可选 **LLM**（`CW_DRE_INTENT_LLM`：`hybrid` / `full`）；`dre_intent` 带 `source` |
| 环境 Agent | 事件触发、与随机性衔接 | **结构化 `generateObject`**；**注入 `lastDice`**（会话状态）供因果叙事 |
| 多 NPC | 并行思考、多轮 A2A 总线 | **`CW_DRE_A2A_ROUNDS`**（1~4）：每轮全员并行发帖，总线累加后再协调摘要；可选 **Redis** 镜像与跨拍上下文 |
| 导演 Agent | 流式成文 | `streamTavernCompletion`，system 追加本回合简报 + **实体锚点（DRE-4）** + **工作记忆（DRE-3）** |
| 世界书实体 | Canonical ID 对齐 | **`CW_DRE_WORLD_ENTITIES`**：从绑定版本 `entities[]` 解析目录；**启发式**匹配玩家句与上文；可选 **`CW_DRE_ENTITY_LLM`** 从编号候选中精排；注入环境/NPC/导演 |
| 工作记忆 | 会话内事实与吃书张力 | **`CW_DRE_MEMORY`**：动作线后 `generateObject` 抽取 `dreMemory`；冲突台账不自动覆盖 |
| 观测 | 回放 | `session_event_logs` + SSE：… + **`dre_entities`** / `dre_memory` |
| Agent MCP | 掷骰 / 世界书 | **动作回合**不挂载工具；**对话回合**保持原样 |


## 环境变量


| 变量 | 说明 |
|------|------|
| `CW_DYNAMIC_RP_ENGINE=1` | 开启 DRE。 |
| `CW_CHAT_MOCK=1` | Mock 流时 **不启用** DRE。 |
| `CW_DRE_INTENT_LLM=1` / `true` / `hybrid` | **DRE-1**：规则已明确判为 `action` 则不再问模型；仅当规则落到 `default_dialogue`（模糊句）时再调用模型分 `dialogue` / `action`。 |
| `CW_DRE_INTENT_LLM=full` / `always` | 每轮意图**仅**走模型（成本高）；失败回退规则。 |
| `CW_DRE_A2A_ROUNDS` | **DRE-2**：NPC 后台广播轮数，默认 `1`（等同早期单轮并行）；`2`~`4` 启用多轮总线（每轮成本 ≈ NPC 数次 `generateObject`）。 |
| `CW_DRE_A2A_REDIS_URL` | 若设置（如 `redis://localhost:6379`）：① 每条总线消息 `RPUSH` 到 `cw:dre:a2a:beat:{threadId}:{beatId}`；② 本拍结束将完整总线 `SET` 到 `cw:dre:a2a:ctx:{threadId}`，下一拍动作线可读入「上一拍残响」。**不配 Redis 时，多轮总线仍在进程内完成，仅无跨请求持久与多实例共享。** |
| `CW_DRE_MEMORY=1` | **DRE-3**：动作线合并前跑一次记忆摄取；写入 `dreMemory`；导演 system 附带摘要；**对话线**仅只读注入记忆块（不本回合再抽取）。 |
| `CW_DRE_MEMORY_MAX_ENTRIES` | 事实条数上限，默认 `28`，最大 `80`。 |
| `CW_DRE_MEMORY_MAX_CONFLICTS` | 冲突记录条数上限，默认 `20`，最大 `60`。 |
| `CW_DRE_WORLD_ENTITIES=1` | **DRE-4**：本会话**已绑定世界版本**时，抽取实体目录并生成本回合锚点块（无绑定则无操作）。 |
| `CW_DRE_ENTITY_LLM=1` | 在启发式候选池上再用模型选相关实体（仅可选用表中 ID）。 |
| `CW_DRE_WORLD_ENTITY_CATALOG_MAX` | 解析目录最大条数，默认 `150`，最大 `400`。 |
| `CW_DRE_WORLD_ENTITY_PICK_MAX` | 每回合写入锚点的实体数上限，默认 `10`，最大 `24`。 |

实现：`dynamic-rp-config.ts`；意图：`dynamic-rp-intent-llm.ts`；总线：`dre-a2a-bus.ts`；Redis：`dre-a2a-redis.ts`；记忆：`dre-memory.ts`；**实体**：`dre-world-entities.ts`。

## 会话状态（`threads.session_state_json`）

可选顶层键 **`dynamicRp`**（对象），用于配置与追溯：

| 字段 | 说明 |
|------|------|
| `activeNpcs` | `string[]`，最多 4 名 NPC |
| `sceneTag` | 预留 |
| `lastIntent` / `lastEventSummary` / `lastA2a` / `lastA2aRounds` / `lastBeatId` / `lastEntityAnchors?` / `lastAt` | 动作回合成功后写入（`lastEntityAnchors` 为当拍选取的实体 ID 列表，DRE-4） |

另：**`lastDice`**（与掷骰逻辑已有）在动作线中会格式化为环境/NPC 提示词。

顶层键 **`dreMemory`**（对象，DRE-3）：

| 字段 | 说明 |
|------|------|
| `entries` | `{ id, summary, at, beatId? }[]` 已采纳的短事实 |
| `conflicts` | `{ id, note, severity, existingSummary, newSummary, at }[]` 与既有条目的矛盾记录 |

用户可通过 **PATCH `/api/threads/[id]`** 的 `sessionStatePatch` 维护 `activeNpcs`；**不建议手改** `dreMemory` 结构除非调试。

## SSE 事件（相对 `POST /api/chat`）

在既有 `turn_started` / `token` / `turn_finished` 等之外增加：

- `dre_intent`：`{ kind, reason, source?: "rules" | "llm" | "hybrid" }`
- `dre_environment`：环境结构化结果
- `dre_a2a`：`{ summary, npcLines, roundsUsed?, beatId?, transcriptPreview? }`
- `dre_memory`：`{ addedFacts, newConflicts, totalEntries, totalConflicts }`
- `dre_entities`：`{ method: "heuristic" \| "llm", pickedIds, pickedNames }`

前端可将摘要写入助手消息的 **`dreTrace`**（折叠展示）。

动作回合导演输出现支持「群像场景包」协议（用于沉浸渲染）：

- 首行 `"[CW_SCENE]"`，随后 1~2 段环境/动作前置描写
- 中段 2~4 行 `"[CW_VOICE:角色名] 台词"`
- 末段 `"[CW_WRAP]"` 收束并给玩家留后续动作空间

`ChatPanel` 会识别并渲染为「场景 + 多 NPC 发言卡 + 收束」块；普通对话回合不受影响。

另外支持「无用户发言的主动推进」触发：前端输入 `/推进`（或 `/next`）后，`/api/chat` 以 `mode=auto` 运行一拍，不落库用户消息，仅写入本拍 assistant 结果。

会话页还提供「真自动档（静默时自动推进）」：

- 打开后在输入框为空、页面处于可见、且当前不在流式生成时，按设定间隔自动触发一拍 `mode=auto`
- 可选间隔（8/12/18/25/35 秒）
- 任意手动发送会重置自动计时，避免抢话

自动档新增「导演前置调度」：每拍先由导演规划 `should_advance` 与 `npc_names`（从在场 NPC 池选择），再决定本拍是否走动作推演与调用哪些 NPC。对应 SSE 事件：`dre_autopilot_plan`。

自动档节奏档位：

- `conservative`（保守）：低频推进，优先 1~2 名 NPC
- `standard`（标准）：平衡推进，优先 1~3 名 NPC
- `aggressive`（激进）：高频推进，优先 2~4 名 NPC

**注意**：`CW_DRE_A2A_ROUNDS` > 1 时，导演 system 里「各 NPC 意图」行取自**最后一轮**广播；**协调纪要**仍基于**完整总线**生成，请以摘要为准把握分歧与默契。

## 演进路线（建议）

1. **DRE-0**：规则意图 + 多段 Agent + 导演；`CW_DYNAMIC_RP_ENGINE`。
2. **DRE-1**（已落地）：`CW_DRE_INTENT_LLM` 模型意图；环境/NPC **读取 `lastDice`**。
3. **DRE-2**（已落地）：进程内多轮 A2A + 可选 Redis 镜像/跨拍上下文；导演仍引用协调摘要与世界书注入。
4. **DRE-3**（已落地）：工作记忆 `dreMemory` + 冲突台账 + 导演/对话注入（见上）。
5. **DRE-4**（已落地）：绑定世界时 **Canonical `entities` → 本回合实体锚点**（启发式 + 可选 LLM）；写入 `dynamicRp.lastEntityAnchors`；SSE `dre_entities`。

6. **后续**：关系边 `relations` 子图检索、`lore_entries` 按需 RAG。

## 相关代码

- `apps/web/src/lib/dynamic-rp-config.ts`
- `apps/web/src/lib/dynamic-rp-intent.ts`
- `apps/web/src/lib/dynamic-rp-intent-llm.ts`
- `apps/web/src/lib/dynamic-rp-engine.ts`
- `apps/web/src/lib/dre-a2a-bus.ts`
- `apps/web/src/lib/dre-a2a-redis.ts`
- `apps/web/src/lib/dre-memory.ts`
- `apps/web/src/lib/dre-world-entities.ts`
- `apps/web/src/app/api/chat/route.ts`

