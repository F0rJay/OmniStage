# 世界书：删除与编剧工坊

## 删除世界

- **UI**：世界列表每一项有「删除」按钮，二次确认后调用 `DELETE /api/worlds/[worldId]`。
- **数据**：删除 `worlds` 行会级联删除 `world_versions` 与 `world_screenwriter_*`。
- **酒馆**：凡 `threads.world_version_id` 指向该世界下任意版本的记录，会先被置为 `NULL`（解除绑定），避免悬挂引用。

## 编剧工坊（多轮 Agent）

- **入口**：`/worlds/[worldId]/workshop`，或版本页「编剧工坊」按钮。
- **新建世界**：世界书页「新建世界」会 `POST /api/worlds` 创建空世界并跳转 `/worlds/[id]/workshop?new=1`。此时聊天请求体带 `scratchCreation: true`（且尚无版本时生效），系统提示追加「新建模式」引导；首版合并成功后前端会 `replace` 去掉 `?new=1`。
- **行为**：每个用户 × 每个世界**一条长期会话**（`world_screenwriter_sessions`），消息存于 `world_screenwriter_messages`。
- **模型**：使用与用户偏好相同的 `provider` / `modelId`（`getUserModelPreference`）；`CW_CHAT_MOCK=1` 时返回演示流。
- **上下文**：系统提示中注入当前世界**最新版本**的 Canonical JSON（与酒馆相同的截断策略，由 `formatWorldContextForPrompt` 处理）；若无版本则提示从零协助搭建结构。

### API

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/api/worlds/[worldId]/screenwriter` | 创建或获取会话 id + 历史消息列表 |
| `POST` | `/api/worlds/[worldId]/screenwriter/chat` | Body `{ "text": "...", "scratchCreation"?: boolean }`（新建模式且尚无版本时服务端启用额外系统提示），SSE：`token` / `error` / `done` |
| `POST` | `/api/worlds/[worldId]/screenwriter/apply` | 无 Body；按当前会话 + 最新版本合并落库为新 `world_versions` |

### 将对话落库为新版本

- 点击 **「将对话合并为新版本」** 调用 `POST /api/worlds/[worldId]/screenwriter/apply`。
- 服务端把**整段编剧会话** + **当前最新 Canonical**（无版本则空白）交给合并模型，生成完整 Canonical，校验通过后 **`createWorldVersion` 追加新版本**。
- `source_raw_json` 记 `kind: "screenwriter_merge"` 等元数据。
- 受 **`CW_WORLD_IMPORT_AGENT=0`** 与 **`CW_CHAT_MOCK=1`** 影响（与导入 Agent 一致：Mock 时仅复制结构并打标，非真实合并）。

### 输入习惯

- 编剧工坊输入框：**Enter** 发送，**Shift+Enter** 换行。

### 合并失败：`This response_format type is unavailable now`

- **原因**：合并与导入共用 `generateObject`（向 API 发送 JSON Schema / structured output）。部分 **LiteLLM 转发模型**、**DeepSeek** 或非 OpenAI 兼容端**不支持**该 `response_format`，会返回上述错误。
- **行为（已实现）**：检测到此类错误后会**自动回退**为普通文本生成 + 服务端解析 JSON，再校验 Canonical。
- **可选**：在 `apps/web/.env.local` 设置 `CW_CANONICAL_TEXT_ONLY=1` 可**跳过** structured 调用，始终走文本回退（适合长期只用不支持 schema 的模型时）。

## 与 WorldForge（规划）的关系

- 当前编剧工坊是 **单会话、单「编剧顾问」人设**，合并落库为 **单次模型调用 + Canonical 校验**。
- **WorldForge（子系统 A）** 已实现 **WF-0～WF-3**（含 WF-2/3 **三轨并行**：架构师 / 机制师 / 人物卡设计师 → 合成 → 审查），产出与导入/编剧共用 Canonical，可选 **`world_book` / `character_books`**；详见 **`docs/world-forge.md`**、**`docs/world-lorebook-spec.md`**。编剧工坊仍可在数据面复用 `world_screenwriter_*` 与 `world_versions`，与 WorldForge **互补**（深聊修订 vs 多 Agent 一轮扩全）。
