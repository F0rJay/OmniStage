# CanonWeave MCP 接入

## 架构概览

| 包 | 工具 | 说明 |
|----|------|------|
| `mcp-servers/dice-roller` | `dice_roll` | 确定性掷骰 |
| `mcp-servers/world-tools` | `world_reader`, `world_writer` | 读/写 SQLite 世界书（Canonical） |

均为 **stdio** MCP；Web 通过 `StdioClientTransport` 子进程调用，并注入环境变量。

### 实现状态说明（world_reader / world_writer）

**已实现**，代码在：

- **MCP 服务端**：`mcp-servers/world-tools/src/index.ts`（注册 `world_reader`、`world_writer`，操作见下文表格）。
- **Web 侧封装**：`apps/web/src/lib/mcp-world-tools.ts` 的 `callWorldMcpTool`。
- **HTTP 代理**：`POST /api/mcp/world-reader`、`POST /api/mcp/world-writer`（需登录 Cookie）。

若你感觉「没有实现」，常见原因是：

1. **未编译 MCP**：仓库默认忽略 `dist/`。必须先执行根目录 `npm run build:mcp-world`，否则 Web 调用会报脚本不存在或 **503**。  
2. **Claude Desktop 等外部宿主**：需自行配置 `command`/`args` 指向 **`world-tools/dist/index.js`**，并设置 `CANONWEAVE_DB_PATH`、`CANONWEAVE_MCP_USER_ID`（见本文「外部 MCP 宿主」）。  
3. **酒馆里模型不自动读写世界书**：默认仅注册 `dice_roll`；需在 `.env.local` 开启 **`CW_AGENT_MCP=1`** 才会把 `world_reader` 交给模型；**写入**还需 **`CW_AGENT_ALLOW_WORLD_WRITE=1`**（有风险，默认关闭）。  
4. **WorldForge / 编剧工坊**：编排**不走 MCP**，直接走 Next.js API + SQLite；与 MCP 世界工具是**两条并行能力**。WorldForge 内解析员与各设计师的**提示词**中已写明：若运行宿主另行提供 **`web_search` / `web_fetch_extract`** 等工具，可用于检索公开资料（需对齐用户设定、避免抄袭）；**尚未**在 LangGraph 中实现为固定工具节点。
5. **动态扮演引擎（DRE）**：`CW_DYNAMIC_RP_ENGINE=1` 时，酒馆 `/api/chat` 在**动作回合**会多段模型调用；该路径**不挂载** Agent MCP 工具（见 `docs/dynamic-rp-engine.md`）。

---

## 构建

产物在各自 `dist/index.js`（根目录 `.gitignore` 已忽略 `dist/`，部署前需编译）：

```bash
npm install
npm run build:mcp-dice
npm run build:mcp-world
# 或一次性
npm run build:all   # dice + world-tools + web
```

---

## 世界书 MCP：`@canonweave/mcp-world-tools`

### 环境变量（宿主负责）

| 变量 | 说明 |
|------|------|
| `CANONWEAVE_DB_PATH` | `canonweave.sqlite` 绝对路径 |
| `CANONWEAVE_MCP_USER_ID` | 当前操作所属用户（与 `users.id` 一致） |

**安全模型**：用户身份**只认环境变量**，工具参数里**不要**也不要求传 `user_id`，避免被模型注入越权。

### `world_reader`（`operation` 区分）

| `operation` | 必填参数 | 说明 |
|-------------|----------|------|
| `list_worlds` | — | 最多 50 个世界摘要 |
| `get_summary` | `world_id` | 元数据 + 版本数量 + 最新版号 |
| `list_versions` | `world_id` | 版本列表（id / version / created_at） |
| `get_canonical` | `world_id`，可选 `version` | 某版 `canonical_json`（过长截断并 `truncated: true`） |
| `get_canonical_by_version_id` | `version_id` | 按 `world_versions.id` 取正文 |

### `world_writer`

| `operation` | 说明 |
|-------------|------|
| `create_world` | `name`，可选 `description` → 新建空世界壳 |
| `append_version` | `world_id` + `canonical_json`（须通过 Canonical 校验）；可选 `source_note`、`citations_json`（合法 JSON 字符串）写入 `source_raw_json` 审计 blob |

### Web 代理（已登录 Cookie）

- `POST /api/mcp/world-reader` — Body 与 `world_reader` 参数相同。  
- `POST /api/mcp/world-writer` — Body 与 `world_writer` 参数相同。  

服务端自动设置 `CANONWEAVE_DB_PATH`、`CANONWEAVE_MCP_USER_ID`（当前 `cw_user_id`）。

可选环境变量：`CW_MCP_WORLD_SERVER` — 自定义 `world-tools/dist/index.js` 路径。

---

## 掷骰 MCP：`dice_roll`

见下文「启用 MCP 掷骰」；工具契约：`expression`（`2d6`、`d20+3` 等）。

### 启用 MCP 掷骰（可选）

在 **`apps/web/.env.local`**：

```env
CW_USE_MCP_DICE=1
# CW_MCP_DICE_SERVER=.../mcp-servers/dice-roller/dist/index.js
```

未构建却开启时会 **503**。

---

## 酒馆 Agent 自动调 MCP（可选）

在 **`apps/web/.env.local`** 开启后，真实模型路径（非 `CW_CHAT_MOCK`）会在 `streamText` 上挂载工具，由**模型按需**调用，执行逻辑仍复用本仓库的 MCP stdio 封装（`rollDiceViaMcp` / `callWorldMcpTool`）。

| 变量 | 说明 |
|------|------|
| `CW_AGENT_MCP=1` | 启用 Agent 工具：`dice_roll`、`world_reader` |
| `CW_AGENT_ALLOW_WORLD_WRITE=1` | 额外注册 `world_writer`（**会改库**，默认勿开） |
| `CW_AGENT_MCP_MAX_STEPS` | 可选，工具循环最大步数，默认 `12`，范围约 `2–32` |

SSE 事件：

- `tool_called`：`source: "agent"` 表示模型发起工具调用（含 `toolName`、`toolCallId`、`input`）。
- `agent_tool_finished`：工具执行结束（成功含 `outputPreview` 或掷骰的 `dice` 摘要；失败含 `error`）。
- 模型通过 `dice_roll` 掷骰成功后，仍会合并 `lastDice` 并推送 `state_patched`（与首行 `/roll` 行为一致）。

**说明**：需模型与网关支持 **Function / tool calling**；`CW_CHAT_MOCK=1` 时不会挂载 Agent 工具。

**前端（酒馆会话页）**：开启后，助手气泡内会展示 **调用 / 结果** 轨迹；会话页顶部与「会话事件流」中会提示/列出 `agent_tool_call`、`agent_tool_finished`。

---

## 外部 MCP 宿主（如 Claude Desktop）

**骰子**（仅需可执行文件）：

```json
{
  "mcpServers": {
    "canonweave-dice": {
      "command": "node",
      "args": ["/absolute/path/to/mcp-servers/dice-roller/dist/index.js"]
    }
  }
}
```

**世界书**（必须带 `env`）：

```json
{
  "mcpServers": {
    "canonweave-world": {
      "command": "node",
      "args": ["/absolute/path/to/mcp-servers/world-tools/dist/index.js"],
      "env": {
        "CANONWEAVE_DB_PATH": "/absolute/path/to/data/canonweave.sqlite",
        "CANONWEAVE_MCP_USER_ID": "你的用户 UUID（与 cw_user_id 一致）"
      }
    }
  }
}
```

---

## 后续扩展

- 更多工具可继续加在同一 `world-tools` 进程，或拆新 MCP 包。  
- Phase D 编排层可复用 `callWorldMcpTool` 或直连子进程工厂。
