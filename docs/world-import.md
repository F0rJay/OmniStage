# 世界书导入与 AI 解析

## 页面：上传文件（主路径）

- **规则模式**：上传 `.json` 或 `.yaml` / `.yml`（YAML 会先解析为对象再序列化为 JSON，再走 Canonical 校验）。
- **AI 解析模式**：上传 `.md`、`.txt`、`.json` 等，由模型结构化后再校验。
- 请求：`multipart/form-data`，字段 **`file`**（文件本体）、`useAgent`（`"true"` / `"false"`）、`worldName` / `worldId`、可选 `modelProvider` / `modelId`。
- 新世界默认名称由**文件名去扩展名**推断（未填「已有世界 ID」时）。

## 两种方式（逻辑）

| 方式 | 说明 |
|------|------|
| **规则：JSON / YAML** | 文件内容 →（YAML 则先 `yaml` 解析）→ `parseAndValidateCanonicalWorld` → 写入。不调用 LLM。 |
| **AI Agent** | 文件全文 → `generateObject` → 再经同一套规则校验 → 写入。 |

符合分步指南原则：**规则引擎 + Schema 校验为主，LLM 负责非结构化 → 结构化**。

Canonical 除 `meta` / `entities` / … / `warnings` 外，可含可选 **`world_book`**（世界书本体）与 **`character_books`**（人物书数组）；字段与 ST 式条目对齐说明见 **`docs/world-lorebook-spec.md`**。

> **WorldForge**：Web 已实现 **WF-0～WF-3**（单图 LangGraph；WF-2/3 含 **架构师 ∥ 机制师 ∥ 人物卡设计师** 并行 → 合成 → 审查），产出可与导入共用同一 Canonical（含可选 **`world_book` / `character_books`**）。详见 **`docs/world-forge.md`**、**`docs/world-lorebook-spec.md`**。  
> **本导入接口**仍为**单 Agent 单次结构化**（加文本回退），与 WorldForge **并行演进**、不阻塞现有路径；需要多 Agent 补全时请走 `/worlds/[id]/world-forge`。

## API

`POST /api/worlds/import`

### `multipart/form-data`（推荐）

| 字段 | 说明 |
|------|------|
| `file` | **必填**。世界书文件。 |
| `useAgent` | `"true"` / `"false"`。 |
| `worldName` / `worldId` / `worldDescription` | 与原先相同。 |
| `modelProvider` / `modelId` | Agent 模式下可选，覆盖用户默认模型。 |

### `application/json`（脚本 / 高级）

| 字段 | 说明 |
|------|------|
| `rawJson` | 必填。正文等价于上传文件内容。 |
| `fileName` | **建议填写**（含扩展名），便于 YAML 分支与错误提示；缺省视为 `pasted.txt`。 |
| `useAgent` / 模型 / 世界字段 | 同上。 |

成功响应含 `fileName`（来自上传或 JSON 的 `fileName`）；Agent 路径另含 `agentUsed: true`。

## 环境变量

| 变量 | 说明 |
|------|------|
| `CW_CHAT_MOCK=1` | 禁止使用 Agent 导入（需真实 Key）。 |
| `CW_WORLD_IMPORT_AGENT=0` | **关闭**服务端 AI 导入（403），仅允许直传 JSON。 |

需为所选 `modelProvider` 配置对应 Key（与酒馆聊天相同），例如 `DEEPSEEK_API_KEY`、`LITELLM_*` 等。

## 溯源快照

- **直传 JSON**：`source_raw_json` 存用户粘贴原文。
- **Agent**：存 JSON 字符串，`kind: "agent_import"`，内含 `rawText`、`modelProvider`、`modelId`、`at`。

## 限制与建议

- Agent 输入上限 **256KB**（UTF-8 字节），防止单次请求过大。
- 结构化输出依赖模型能力；若某模型频繁失败，可换网关上的 GPT 系或提高 `maxOutputTokens`（代码内可调）。
- 实现位置：`apps/web/src/lib/world-import-agent.ts`、`getLanguageModelForProvider`（`llm.ts`）。
