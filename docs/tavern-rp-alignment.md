# 酒馆对话与 SillyTavern 对齐（角色 / Persona / 选角 / 注入顺序）

CanonWeave 酒馆会话在调用模型前合并系统侧上下文，语义对齐 [SillyTavern「角色」](https://sillytavern.wiki/usage/characters/)、[人格（Personas）](https://sillytavern.wiki/usage/core-concepts/personas/) 与「世界书 + 角色卡」工作流（本仓库不含头像/语音等多模态）。

## 数据落点

| 概念 | 存储 | 会话字段 |
|------|------|----------|
| 世界版本 / Canonical | `world_versions.canonical_json` | `threads.world_version_id` |
| **AI 酒馆角色**（模型扮演谁） | `tavern_characters`（`character_card_json`） | `threads.assistant_character_id` |
| 玩家人格（Persona） | `personas` 表 | `threads.persona_id` |
| 世界书中玩家扮演条目 | `canonical_json.character_books[]` | `threads.active_character_bound_entity_id` |

`active_character_bound_entity_id` 与人物书条目的 `bound_entity_id` / `bound_entity_name` / `name` 匹配逻辑见 `apps/web/src/lib/tavern-rp-context.ts`（`matchesCharacterBook`）。

## 注入顺序

由 `buildTavernInjectedWorldContext`（`tavern-rp-context.ts`）拼接：

1. **世界块**：`formatWorldContextForPrompt` 生成的设定摘要（绑定世界版本时）。
2. **AI 酒馆角色**：用户库中角色的 `character_card_json`（`formatAssistantTavernCharacterForPrompt`）。
3. **世界书中扮演角色**：选中人物书条目的 `character_card`。
4. **人格**：Persona 的 `name` / `title` / `description`。

合并后作为 `streamTavernCompletion` 等的 `worldContext` 传入（见 `apps/web/src/app/api/chat/route.ts`）。

## API

- `GET/POST /api/characters` — AI 酒馆角色列表与创建。
- `GET/PATCH/DELETE /api/characters/[characterId]` — 读写删（删除时会将相关会话的 `assistant_character_id` 置空）。
- `GET/POST /api/personas` — 列表与创建。
- `PATCH/DELETE /api/personas/[personaId]` — 更新与删除（删除时会将该人格从相关会话解绑）。
- `PATCH /api/threads/[threadId]` — 可选字段 `assistantCharacterId`、`personaId`、`activeCharacterBoundEntityId`（`null` 或空字符串表示解绑）。
- `GET /api/threads/[threadId]/rp-bindings` — 返回人格列表、**酒馆角色列表**、当前世界版本下的 `character_books` 选项及会话绑定快照（供 UI）。
- `POST /api/threads/[threadId]/seed-first-mes` — 空会话时尝试插入绑定角色的 `first_mes` 为一条 `assistant` 消息（幂等）。

## 按回合切换「谁在说话」（UI）

- `threads.assistant_character_id` 仍是**默认主视角**（角色卡与系统注入），但多人剧情中模型可在**每条助手回复最前**单独一行输出：
  - `[CW_SPEAKER:弗兰德院长]` 或
  - `【说话者：林风】`
- 服务端解析后写入 `messages.speaker_label`，**正文存剥离后的文本**；会话气泡旁显示该名字；无此行时回退为角色库里的默认角色名或「叙事者」。
- 协议全文见 `apps/web/src/lib/chat-speaker.ts`（`TAVERN_SPEAKER_LINE_PROTOCOL` 注入 `/api/chat` 的 system 追加块）。

## UI

- **`/tavern/characters`**：角色列表、创建、编辑（表单字段对齐 ST 文档中的描述/个性/场景/第一条消息等）。
- 会话页 `ChatPanel`：绑定世界版本 → **选择 AI 酒馆角色**（可跳转管理库、一键填入 `first_mes`）→ 人格 → 世界书中扮演角色。
- **空会话自动开场**：会话中尚无任何消息、且已绑定带 `first_mes` 的 AI 酒馆角色时，进入会话页或在面板中刚绑定该角色后，会自动写入一条 `assistant` 消息的 `first_mes`（服务端 `tryInsertAssistantFirstMesForEmptyThread` + `POST /api/threads/[threadId]/seed-first-mes`，已有任意消息则幂等跳过）。
- 表单与 JSON 互转见 `apps/web/src/lib/tavern-character-form.ts`。
