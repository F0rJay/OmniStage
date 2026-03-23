# LiteLLM 接入说明（CanonWeave）

## 架构

- **LiteLLM Proxy**：统一 OpenAI 兼容入口（`/v1/chat/completions`），按 `model` 路由到 DeepSeek / OpenAI / Anthropic 等。
- **Next.js `apps/web`**：会话所选 `provider` + `modelId` 在走 **`litellm`** 时，只把 **`modelId`** 当作 Proxy 上的 **`model_name`**；**鉴权**使用与 Proxy **`LITELLM_MASTER_KEY`** 一致的 **`LITELLM_API_KEY`**。

## 本地启动 Proxy

```bash
# 1) 准备密钥（勿提交）
copy infra\litellm\.env.example infra\litellm\.env   # Windows
# 编辑 .env：LITELLM_MASTER_KEY、各上游 DEEPSEEK_API_KEY / OPENAI_API_KEY / ANTHROPIC_API_KEY

# 2) 启动
docker compose -f docker-compose.litellm.yml up
```

健康检查：浏览器或 `curl http://127.0.0.1:4000/health/liveliness`（视镜像版本路径可能略有差异）。

## 配置 Next.js

在 **`apps/web/.env.local`**（可参考 `.env.example`）：

- `LITELLM_BASE_URL=http://127.0.0.1:4000/v1`
- `LITELLM_API_KEY=<与 infra/litellm/.env 中 LITELLM_MASTER_KEY 相同>`

## 增删模型

1. 编辑 **`infra/litellm/config.yaml`** 的 `model_list`（`model_name` = 对外别名）。
2. 在 **`apps/web/src/lib/models.ts`** 中为 `provider: "litellm"` 增加同名的 `modelId`。
3. 重启 LiteLLM 容器。

## 直连模式（无 LiteLLM）

历史会话若 `model_provider` 仍为 `deepseek` / `openai` / `anthropic`，后端 **`llm.ts`** 仍保留直连分支；默认 UI 模型列表以 **LiteLLM** 为主，需在 Proxy 与 `.env` 就绪后使用。
