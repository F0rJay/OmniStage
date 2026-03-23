# CanonWeave

![Platform](https://img.shields.io/badge/platform-web-blue)
![Mode](https://img.shields.io/badge/mode-multi--agent-purple)
![Experience](https://img.shields.io/badge/experience-immersive-green)
![License](https://img.shields.io/badge/license-Apache--2.0-blue)

> 一个面向长期游玩的 AI 角色扮演产品：  
> 用 **世界熔炉（WorldForge）** 共创世界，用 **酒馆（Tavern）** 进入世界并持续推进剧情。

---

## 这是什么

CanonWeave 不是“你问一句、AI 回一句”的聊天工具。  
它的核心目标是：把角色扮演做成一个可持续演化的世界体验。

你可以把它理解为一个双系统循环：

1. 在 **世界熔炉** 中生成/导入/修订世界设定与角色资料（可版本化）。
2. 在 **酒馆** 中绑定该世界版本，进入多角色沉浸互动。
3. 剧情推进后再回到世界熔炉继续补设定，形成长期连载闭环。

---

## 两个核心子系统

### 1) 酒馆（Tavern）

面向“游玩”的系统，强调沉浸感与剧情推进：

- 导演 Agent 负责节奏与场面组织
- 环境 Agent 负责局势反馈与后果表达
- 多个 NPC Agents 可协同回应、互相对话、共同推进同一幕
- 支持角色抬头渲染与场景分段，尽量做到“谁说话就是谁”

### 2) 世界熔炉（WorldForge）

面向“创作与维护世界”的系统，强调结构化与可复用：

- 多 Agent 协作生成世界结构、机制规则、角色卡与 lore
- 世界书支持版本管理与增量更新
- 角色资料可同步到角色库，便于后续会话复用

---

## 你能获得什么体验

- **群像演出感**：不止一个角色在回应你，而是多个角色共同“演一幕戏”
- **世界连续性**：设定、角色、会话状态互相联动，适合长期游玩
- **可控可扩展**：可手动推进，也可自动推进；可全量共创，也可增量补丁
- **世界与玩法一体化**：你写下的设定，不是文档，而是会被真正用到的游玩上下文

---

## 产品入口

- 世界列表：`/worlds`
- 世界详情与版本：`/worlds/[id]`、`/worlds/[id]/versions`
- 世界熔炉：`/worlds/[worldId]/world-forge`
- 世界导入：`/worlds/import`
- 酒馆会话：`/tavern/sessions/[sessionId]`
- 角色库：`/tavern/characters`

---

## 3 分钟上手

1. 创建或导入一个世界（推荐先完成基础设定）。  
2. 在世界熔炉里生成第一个可扮演角色与关键 NPC。  
3. 创建酒馆会话并绑定世界版本。  
4. 开始互动：输入行动或台词。  
5. 需要时使用自动推进，让 NPC 主动演化下一步。  
6. 发现设定不足时回到世界熔炉做增量补充，再继续游玩。

---

## 推荐玩法流程

### 新世界开局

- 先做“世界骨架 + 2~4 个关键角色”
- 第一次会话只推进一个小事件，验证角色语气与关系
- 根据会话表现回炉补齐缺失设定

### 已有世界续玩

- 直接在世界熔炉做“增量目标”（新增人物/地点/组织）
- 合并到最新版本后继续会话
- 把每次推进形成的新事实沉淀回世界书

---

## 设计原则（面向使用者）

- **先可玩，再完美**：优先保证你能持续推进故事
- **设定服务叙事**：世界书是为了让剧情更稳、更准，而不是堆字段
- **角色可辨识**：尽量减少“谁在说话”的歧义
- **长期可维护**：通过版本化让世界不断迭代，而不是一次性生成

---

## 本地启动（Fork 后最快路径）

### A. 无密钥快速体验（推荐先跑通）

1. 安装依赖
2. 准备环境变量（开启 mock）
3. 启动 Web

Windows（PowerShell）：

```powershell
npm install
Copy-Item apps/web/.env.example apps/web/.env.local
# 打开 apps/web/.env.local，把 CW_CHAT_MOCK=1 取消注释
npm run dev:web
```

macOS / Linux：

```bash
npm install
cp apps/web/.env.example apps/web/.env.local
# 编辑 apps/web/.env.local，取消注释 CW_CHAT_MOCK=1
npm run dev:web
```

启动后打开：`http://localhost:3000`

### B. 接入真实模型（LiteLLM 代理，推荐）

1. 复制并填写 LiteLLM 环境变量  
2. 启动 LiteLLM 容器  
3. 配置 `apps/web/.env.local` 中 `LITELLM_BASE_URL` 与 `LITELLM_API_KEY`  
4. 启动 Web

```bash
# 1) 复制模板
cp infra/litellm/.env.example infra/litellm/.env
cp apps/web/.env.example apps/web/.env.local

# 2) 启动 LiteLLM
docker compose -f docker-compose.litellm.yml up

# 3) 另开终端启动 Web
npm run dev:web
```

> 详细配置见 `docs/litellm.md`。  
> 如果你不想走 LiteLLM，也可以在 `apps/web/.env.local` 直接填 `OPENAI_API_KEY` / `DEEPSEEK_API_KEY` / `ANTHROPIC_API_KEY`。

### C. 在前端配置你自己的模型接口（已支持）

你可以不改代码，直接在前端配置并切换模型接口：

1. 打开 `个人偏好`（`/profile`）
2. 在“自定义 OpenAI 兼容接口”中填写：
   - 名称
   - Base URL（需含 `/v1` 或兼容路径）
   - API Key
   - 默认模型 ID
3. 保存后，该接口会出现在模型下拉中，可设为新会话默认模型或在会话内切换

当前内置一键预设（填 Key 即可）：

- DeepSeek 官方
- Qwen（阿里百炼）
- Kimi（月之暗面）
- Gemini（OpenAI 兼容）

> 说明：自定义接口要求兼容 OpenAI Chat Completions 风格请求。

### 常用命令

- 开发启动：`npm run dev:web`
- 构建 Web：`npm run build:web`
- 生产启动：`npm run start:web`
- 构建 MCP（可选）：`npm run build:mcp-dice`、`npm run build:mcp-world`

---

## 文档导航

- `docs/README.md`：文档总索引（建议从这里进入）
- `docs/dynamic-rp-engine.md`：动态 RP 引擎与群像编排
- `docs/world-forge.md`：世界熔炉工作流
- `docs/world-lorebook-spec.md`：Canonical/世界书结构规范
- `docs/layered-memory.md`：分层记忆机制
- `docs/mem0.md`：记忆系统集成说明
- `docs/litellm.md`：模型接入说明

---

## Contributing

欢迎提交 Issue / PR。  
建议先阅读：`docs/dynamic-rp-engine.md` 与 `docs/world-forge.md`。

---

## License

Apache License 2.0（见仓库根目录 `LICENSE`）。

