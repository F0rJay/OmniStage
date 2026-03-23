# 分层记忆架构（共享池 · 私域 · 洞察层）

实现用户设计的**三层记忆**（与 DRE、Mem0、`dreMemory` 可并存）：

| 层 | 存储 | 读写规则 |
|----|------|----------|
| **全局洞察层（Insight）** | SQLite `cw_insights` | 由**监督者**结构化输出 `insight_candidates` 后写入；按 `scope` 分为 `world` / `user` / `session` |
| **共享记忆池（Shared）** | `threads.session_state_json.sharedMemory` | **仅监督者**通过抽取更新；环境/NPC/导演**只读**注入 |
| **私有记忆库（Private）** | `session_state_json.privateMemory` | 按 NPC 分桶键 `npc:<名称>`；监督者仅为**当前 activeNpcs** 追加条目 |

## 开关与环境变量

| 变量 | 说明 |
|------|------|
| **`CW_LAYERED_MEMORY=1`** | 开启注入 +（动作线）监督者抽取 |
| `CW_LAYERED_MEMORY_DIALOGUE_EXTRACT=1` | 对话线也跑监督者抽取（多一次模型调用，默认关） |
| `CW_LAYERED_MEMORY_MAX_GOALS` | 共享目标条数上限，默认 8，最大 16 |
| `CW_LAYERED_MEMORY_MAX_PRIVATE` | 每 NPC 私域条目上限，默认 14，最大 40 |
| `CW_LAYERED_MEMORY_INSIGHT_LIMIT` | 注入提示的洞察条数，默认 10，最大 24 |

未绑定世界版本时，`scope=world` 的洞察候选会被丢弃（无法关联 `world_id`）。

## 数据形状（session_state_json）

### sharedMemory

- `version`, `updatedAt`
- `goals[]`: `{ id, text, status: active|done|dropped }`
- `worldStateSummary`: 监督者维护的可变世界状态摘要
- `userPreferences`: 文本累积（用户偏好/禁忌）
- `supervisorNotes`: 监督者时间序备注

### privateMemory

```json
{
  "npc:艾尔文": {
    "entries": [{ "id", "summary", "at", "beatId?" }]
  }
}
```

## 流水线

1. **读取**：`listInsightsForTavernContext` + 解析 `sharedMemory` / `privateMemory` → `formatLayeredMemoryContextBlock`。
2. **动作线**：块注入 `runDynamicRpActionBeat` 的 `layeredMemoryHint`（环境/NPC 可见共享+私域+洞察）。
3. **监督者抽取**（动作线每拍）：`runLayeredMemorySupervisorExtract` → 合并 `sharedMemory` / `privateMemory`，`insertInsight` 写入洞察。
4. **对话线**：默认只**注入**不抽取；`CW_LAYERED_MEMORY_DIALOGUE_EXTRACT=1` 时额外抽取并 `mergeThreadSessionState`。
5. **非 DRE**：仍注入分层块到模型附录（在 Mem0 与 Agent 工具文之前合并）。

## 可观测性

- SSE：`layered_memory`（`phase`: `inject` | `supervisor`）
- 事件：`layered_memory`、`state_patched`（`via: layered_memory_dialogue`）

## 代码入口

- `apps/web/src/lib/layered-memory.ts`
- `apps/web/src/lib/layered-memory-config.ts`
- `apps/web/src/lib/layered-memory-extract.ts`
- `apps/web/src/lib/db.ts`（`cw_insights`）
- `apps/web/src/app/api/chat/route.ts`
- `apps/web/src/lib/dynamic-rp-engine.ts`（`layeredMemoryHint`）

## 边界

- 监督者遵守靠**提示词**；服务端不按 NPC 身份校验「私域不可互读」（模型侧约束）。
- `mergeThreadSessionState` 为**顶层浅合并**；`sharedMemory` / `privateMemory` 每次写入完整对象。
