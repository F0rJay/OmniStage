export type ModelOption = {
  provider: string;
  modelId: string;
  label: string;
  tier: "fast" | "balanced" | "quality";
};

/**
 * 列表第一项为默认新会话模型（当前为 DeepSeek 直连，仅需 DEEPSEEK_API_KEY）。
 * 带「网关」的项走 LiteLLM：modelId 须与 infra/litellm/config.yaml 的 model_name 一致，
 * 且 Next 侧需 LITELLM_BASE_URL + LITELLM_API_KEY；上游 Key 在 infra/litellm/.env。
 */
export const MODEL_OPTIONS: ModelOption[] = [
  /** 仅需 apps/web/.env.local 的 DEEPSEEK_API_KEY，无需 LiteLLM */
  {
    provider: "deepseek",
    modelId: "deepseek-chat",
    label: "DeepSeek Chat（直连）",
    tier: "fast",
  },
  {
    provider: "litellm",
    modelId: "deepseek-chat",
    label: "DeepSeek Chat（网关）",
    tier: "fast",
  },
  {
    provider: "litellm",
    modelId: "gpt-4o-mini",
    label: "GPT-4o mini（网关）",
    tier: "fast",
  },
  {
    provider: "litellm",
    modelId: "gpt-4.1",
    label: "GPT-4.1（网关）",
    tier: "balanced",
  },
  {
    provider: "litellm",
    modelId: "claude-sonnet",
    label: "Claude Sonnet（网关）",
    tier: "quality",
  },
];

export const DEFAULT_MODEL = MODEL_OPTIONS[0];
