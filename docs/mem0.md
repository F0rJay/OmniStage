# Mem0 接入（酒馆 `/api/chat`）

Next.js 路由中**不能**直接打包 `mem0ai/oss`（其单文件会静态依赖 Qdrant、Neo4j、Azure 等全部可选驱动，导致 Turbopack 构建失败）。因此 CanonWeave 使用官方 **`MemoryClient`**（`import { MemoryClient } from "mem0ai"`），走 **Mem0 Platform HTTP API**（默认 `https://api.mem0.ai`，亦可指向[自托管 REST 服务](https://docs.mem0.ai/open-source/features/rest-api)）。

行为与原先设计一致：

- **回合前**：用当前用户句对 Mem0 `search`，命中摘要注入系统附录。
- **回合后**：`add` 本回合用户句 + 助手全文，由云端（或自建服务）抽取、索引记忆。

与 **DRE-3 `dreMemory`**：`dreMemory` 是会话 JSON 内工作记忆；Mem0 为**跨回合语义记忆**，可同时开启。

## 环境变量

| 变量 | 说明 |
|------|------|
| **`CW_MEM0=1`** | 开启检索与摄取 |
| **`CW_MEM0_PLATFORM_API_KEY`** | Mem0 Platform Token（推荐）；或 `MEM0_API_KEY` / `CW_MEM0_API_KEY` |
| `CW_MEM0_PLATFORM_HOST` | API 根 URL（无尾斜杠）。不设则 `https://api.mem0.ai`；自托管 REST 时填你的地址 |
| `CW_MEM0_SCOPE` | `thread`（默认）或 `user`（跨会话共享同一 `user_id`） |
| `CW_MEM0_SEARCH_LIMIT` | 检索条数上限，默认 `8`，最大 `24` |

`CW_CHAT_MOCK=1` 仍会执行上述逻辑；若未配 Platform Key，首次会跳过并打警告日志。

## 依赖

在 `apps/web` 已声明 `mem0ai`。若安装时与 `redis@5` 报 peer 冲突，可使用：

```bash
cd apps/web && npm install mem0ai --legacy-peer-deps
```

（仅影响 npm 解析；运行时仍走 Platform `MemoryClient`，不加载 `mem0ai/oss`。）

## 可观测性

- **SSE**：`mem0_context`（命中数 > 0 时）。
- **事件**：`mem0_context`、`mem0_ingest_ok`、`mem0_ingest_failed`。

## 代码入口

- `apps/web/src/lib/mem0-config.ts`
- `apps/web/src/lib/canonweave-mem0.ts`
- `apps/web/src/app/api/chat/route.ts`

## 若必须在进程内跑 OSS Mem0

请将 `mem0ai/oss` 放在 **独立 Node 服务**（或 Sidecar）中运行，CanonWeave 通过 HTTP 调用该服务；不要在与 Next 同进程的 bundle 中 `import "mem0ai/oss"`。
