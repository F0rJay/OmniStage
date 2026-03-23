# @canonweave/mcp-dice-roller

CanonWeave 官方 MCP 服务器：**stdio**，工具 **`dice_roll`**（`NdM` 记法，密码学随机）。

## 开发

```bash
# 仓库根
npm install
npm run build:mcp-dice
```

## 运行（供宿主或调试）

```bash
node dist/index.js
```

进程从 stdin 读 MCP JSON-RPC；请勿在终端手动输入，应由 MCP Client 启动。

## 文档

见仓库根目录 **`docs/mcp.md`**。
