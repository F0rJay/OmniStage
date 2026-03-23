# CanonWeave 项目开发进度与能力总览

> 本文档基于当前仓库代码与目录结构整理，用于快速了解**已实现功能**与**技术栈**。更新日期：2026-03-22（随迭代请同步修订）。

---

## 1. 产品定位（当前阶段）

- **单人 AI 文字角色扮演**：酒馆会话、世界书（Canonical）版本化、流式对话。
- **对齐 SillyTavern 心智的子集**：AI「角色」、玩家人格（Persona）、世界书中扮演条目、系统提示注入顺序、`first_mes` 空会话开场等（无头像/语音等多模态）。
- **阶段**：README 标注为 **alpha**；部分 README Roadmap 项（公开试玩打包、高级可视化等）仍在规划中。

---

## 2. 技术栈总览

### 2.1 前端与 BFF

| 技术 | 用途 |
|------|------|
| **Next.js 16**（App Router） | Web 应用、服务端组件、Route Handlers（`/api/*`） |
| **React 19** | UI（含 Client Components：酒馆对话面板等） |
| **TypeScript 5.x** | 全栈类型 |
| **Google Fonts（Noto Sans SC）** | 中文界面字体 |

### 2.2 AI / LLM 编排

| 技术 | 用途 |
|------|------|
| **Vercel AI SDK（`ai`）** | `streamText`、流式补全、工具调用循环（酒馆对话等） |
| **@ai-sdk/openai**、**@ai-sdk/anthropic** | 对接 OpenAI 兼容端点与 Anthropic |
| **LiteLLM（推荐部署）** | 统一网关；Web 通过 `LITELLM_BASE_URL` + Key 访问多模型（见 `docs/litellm.md`） |
| **Zod** | 结构化输出 / 校验（如 DRE、记忆抽取等） |

### 2.3 世界生产（WorldForge）

| 技术 | 用途 |
|------|------|
| **LangGraph**（`@langchain/langgraph`） | WorldForge 多 Agent 协作图（WF-0～WF-3） |
| **@langchain/core** | 与 LangGraph 配套的消息与抽象 |

### 2.4 数据与基础设施

| 技术 | 用途 |
|------|------|
| **better-sqlite3** | 嵌入式 SQLite；库文件默认 `data/canonweave.sqlite`（相对 `apps/web` 工作目录解析） |
| **Redis（可选，`redis` 包）** | DRE 多轮 A2A 总线镜像与跨拍上下文（`CW_DRE_A2A_REDIS_URL`） |

### 2.5 工具与集成

| 技术 | 用途 |
|------|------|
| **Model Context Protocol（`@modelcontextprotocol/sdk`）** | MCP 服务端与 Web 侧桥接 |
| **npm workspaces** | 单体仓库：`apps/web`、`mcp-servers/*` |
| **MCP Servers（自建）** | `dice-roller`（掷骰）、`world-tools`（世界读/写） |
| **YAML** | 世界书规则导入等 |
| **mem0ai** | 可选记忆层集成（见 `docs/mem0.md` 与相关配置） |

### 2.6 开发与部署

| 技术 | 用途 |
|------|------|
| **Node.js** | 运行时 |
| **Docker Compose（可选）** | LiteLLM 代理示例（`docker-compose.litellm.yml`） |
| **Conda（可选）** | `environment.yml` 管理 Node/npm 运行时（README 说明） |

### 2.7 文档中规划但代码占位较多的部分

| 路径 | 状态 |
|------|------|
| `workers/*` | 主要为 `.gitkeep`，异步导入/记忆/评测 worker **尚未实现业务代码** |
| `packages/`、部分 `infra/`、`tests/` | 以仓库结构预留为主，需以实际目录为准 |

---

## 3. 已实现功能模块

### 3.1 账户与入口

- **演示登录**（Cookie 会话）：`POST /api/auth/demo-login`、`POST /api/auth/logout`。
- **首页** `/` → 重定向至 `/tavern`。
- **登录页** `/sign-in`。
- **主导航**：酒馆、角色、世界书、导入、偏好、登录（`layout.tsx`）。

### 3.2 酒馆（单人会话）

- **酒馆主页** `/tavern`：新开会话、继续上次、会话列表分页、世界书/偏好入口。
- **会话页** `/tavern/sessions/[sessionId]`：
  - 流式聊天（SSE：`turn_started`、`token`、`turn_finished`、`error` 等）。
  - 绑定**世界版本**、选择**本会话模型**（`PUT /api/threads/[id]/model`）。
  - **SillyTavern 对齐绑定**（见 `docs/tavern-rp-alignment.md`）：
    - **AI 酒馆角色**（`tavern_characters` / `assistant_character_id`）。
    - **玩家人格 Persona**（`personas` / `persona_id`）。
    - **世界书中扮演角色**（`character_books` / `active_character_bound_entity_id`）。
  - 系统提示注入顺序：**世界 → AI 角色 → 世界书中扮演 → 人格**。
  - **空会话自动 `first_mes`**：服务端页面加载 + `POST .../seed-first-mes` + 绑定 AI 角色后客户端补种（幂等）。
  - **按回合说话者**：模型可在回复首行输出 `[CW_SPEAKER:名字]` / `【说话者：名字】`，解析入 `messages.speaker_label`，气泡旁按回合切换（见 `chat-speaker.ts`、`docs/tavern-rp-alignment.md`）。
  - `/roll` 掷骰、会话状态 `session_state_json`、`state_patched` 事件流。
  - 可选 **Agent MCP**（工具调用轨迹）、**ReAct** 轨迹展示、**DRE** 轨迹与事件（由环境变量控制）。
- **会话列表 API**：`GET /api/threads`（分页/筛选）；**创建** `POST /api/threads/create`；**归档/改名/补丁** `PATCH /api/threads/[id]`；**永久删除** 等。
- **事件流** `GET /api/threads/[id]/events`。
- **rp-bindings** `GET /api/threads/[id]/rp-bindings`：人格、酒馆角色列表、`character_books` 选项、当前绑定快照。

### 3.3 角色与人格（ST 概念）

- **AI 酒馆角色** `/tavern/characters`：列表、新建、编辑、删除；API `GET/POST /api/characters`、`GET/PATCH/DELETE /api/characters/[characterId]`。
- **人格 Persona**：`GET/POST /api/personas`、`PATCH/DELETE /api/personas/[personaId]`；会话内快速新建人格。

### 3.4 用户偏好

- **模型偏好** `/profile`：`GET/PATCH`（或相关 API）默认模型；线程级模型覆盖见会话页。

### 3.5 世界书与世界版本

- **世界列表** `/worlds`：创建、删除（级联版本与编剧会话等，行为以 `db.ts` 为准）；列表主链进入 **世界详情**。
- **世界详情（只读浏览）** `/worlds/[worldId]`：解析当前或 `?version=<world_versions.id>` 的 Canonical，展示世界书条目、人物书/角色卡摘要、实体列表；入口跳转熔炉、编剧工坊、版本管理（`world-canonical-browse.ts`）。**保存新世界版本**（`createWorldVersion`）时自动将含 `character_card` 的 `character_books` upsert 到 `tavern_characters`（按 `world_id` + `bound_entity_id` 稳定键；删世界时清理同步行）；详情页可「同步角色库」对指定版本补跑。实现见 `character-world-sync.ts` 与 `db.ts` 内 `applyTavernCharacterWorldSync` / `replayTavernSyncFromWorldVersion`。
- **版本管理** `/worlds/[worldId]/versions`：版本列表、新建版本、**恢复版本** API。
- **Canonical**：每版本 `canonical_json` 存储；会话绑定 `world_version_id` 后注入对话。

### 3.6 世界导入

- **导入页** `/worlds/import`：规则导入（JSON/YAML）与 AI Agent 导入（MD/文本等）；API `POST /api/worlds/import`（详见 `docs/world-import.md`）。

### 3.7 编剧工坊（Screenwriter）

- **页面** `/worlds/[worldId]/workshop`。
- API：会话创建/消息、应用补丁到新世界版本等（`screenwriter/*` 路由）。

### 3.8 WorldForge（世界熔炉）

- **页面** `/worlds/[worldId]/world-forge`。
- **LangGraph** 多阶段：`wf0`～`wf3`、流式 `stream`；产出 Canonical，可含 `world_book` / `character_books`（见 `docs/world-forge.md`、`docs/world-lorebook-spec.md`）。

### 3.9 酒馆对话「重型」运行时（可选开关）

以下由 **`/api/chat`** 与相关 `lib/*` 实现，默认依赖环境变量开启：

| 能力 | 说明文档 |
|------|-----------|
| **动态扮演引擎 DRE** | `docs/dynamic-rp-engine.md`：意图分流、环境/NPC/A2A、导演成文、可选 Redis |
| **DRE 工作记忆 / 实体锚点** | 同上 + `session_state` 中的 `dreMemory` 等 |
| **分层记忆（Layered Memory）** | `docs/layered-memory.md`：监督抽取、注入 beat |
| **Mem0** | `docs/mem0.md` |
| **ReAct 认知框架** | `docs/react-cognitive-framework.md`（与 Agent 工具配合） |
| **cw_insights** | 数据库表 + 对话上下文检索等（见实现于 `db.ts` / chat 路由） |

### 3.10 MCP 与 HTTP 桥接

- 独立 **MCP 服务**：掷骰、世界读写（构建脚本见根 `package.json`）。
- Web：**Agent 模式**下挂载工具；`POST /api/mcp/world-reader`、`world-writer`；聊天内 MCP 掷骰（`CW_USE_MCP_DICE` 等）。详见 `docs/mcp.md`。

### 3.11 模型列表

- `GET /api/models`：供前端下拉选择提供商与模型 ID。

---

## 4. 数据模型（SQLite 核心表）

| 表 | 作用 |
|----|------|
| `users` | 用户、默认模型偏好 |
| `threads` | 会话；含 `world_version_id`、`session_state_json`、`persona_id`、`active_character_bound_entity_id`、`assistant_character_id`、归档等 |
| `messages` | 会话消息（user/assistant/system）；助手可选 `speaker_label`（按回合 NPC 名） |
| `session_event_logs` | 审计与回放事件 |
| `worlds` / `world_versions` | 世界与版本化 Canonical |
| `world_screenwriter_sessions` / `world_screenwriter_messages` | 编剧工坊对话 |
| `cw_insights` | 洞察条目（世界/用户/会话范围） |
| `personas` | 玩家人格 |
| `tavern_characters` | AI 酒馆角色卡（JSON） |

*启动时执行 `CREATE TABLE IF NOT EXISTS` 与 `ALTER TABLE` 迁移（见 `getDb()`）。*

---

## 5. 前端页面一览

| 路径 | 说明 |
|------|------|
| `/` | → `/tavern` |
| `/sign-in` | 登录 |
| `/tavern` | 酒馆主页 |
| `/tavern/sessions/[sessionId]` | 会话与聊天 |
| `/tavern/characters` | AI 角色列表 |
| `/tavern/characters/new` | 新建角色 |
| `/tavern/characters/[characterId]` | 编辑角色 |
| `/worlds` | 世界列表 |
| `/worlds/[worldId]` | 世界详情（Canonical 只读列表 + 版本切换） |
| `/worlds/import` | 导入 |
| `/worlds/[worldId]/versions` | 版本管理 |
| `/worlds/[worldId]/workshop` | 编剧工坊 |
| `/worlds/[worldId]/world-forge` | 世界熔炉 |
| `/profile` | 模型偏好 |

---

## 6. 文档索引（仓库内）

| 文档 | 内容 |
|------|------|
| `README.md` | 产品说明、快速开始、API 提要、Roadmap |
| `docs/tavern-rp-alignment.md` | 酒馆与 ST 对齐：角色/Persona/注入/`first_mes` |
| `docs/litellm.md` | LiteLLM 网关 |
| `docs/mcp.md` | MCP 与 Web 桥接 |
| `docs/world-import.md` | 世界导入 |
| `docs/world-screenwriter.md` | 编剧工坊 |
| `docs/world-forge.md` / `docs/world-lorebook-spec.md` | 世界熔炉与 Lorebook 规范 |
| `docs/dynamic-rp-engine.md` | DRE |
| `docs/layered-memory.md` | 分层记忆 |
| `docs/mem0.md` | Mem0 |
| `docs/react-cognitive-framework.md` | ReAct |
| `CanonWeave-分步开发指南.md` / `CanonWeave-完整落地方案-SOTA.md` | 规划与分步指南（根目录） |

---

## 7. 小结：当前成熟度一句话

- **已具备**：可玩的 **Next.js 全栈酒馆** + **SQLite 持久化** + **世界书版本化** + **WorldForge / 编剧 / 导入** + **多模型路由** + **可选 DRE/记忆/MCP/Agent** + **ST 式角色与人格闭环**。
- **仍偏规划/占位**：README 中的部分产品化目标（公开 Demo 打包、世界 diff UI、剧情一键回放、市场等）及 **`workers/` 异步任务** 实体代码。

---

*若你后续增加大功能模块，请在本文件对应章节打勾或补充「版本/日期/负责人」，避免与 README Roadmap 长期脱节。*
