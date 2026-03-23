# @canonweave/mcp-world-tools

CanonWeave 官方 MCP：**`world_reader`**、**`world_writer`**（stdio），读写与 Web 共用的 SQLite 世界书。

## 环境变量（必填）

- `CANONWEAVE_DB_PATH` — `canonweave.sqlite` 绝对路径  
- `CANONWEAVE_MCP_USER_ID` — 与 `users.id` 一致的用户 UUID  

## 构建

```bash
# 仓库根
npm install
npm run build:mcp-world
```

## Web 调用

已登录时：

- `POST /api/mcp/world-reader`  
- `POST /api/mcp/world-writer`  

Body 与 MCP 工具参数相同（见 **`docs/mcp.md`**）。

## 外部宿主

配置示例见 **`docs/mcp.md`**（需在 `env` 中传入上述两个变量）。
