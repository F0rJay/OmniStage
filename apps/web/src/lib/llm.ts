import {
  stepCountIs,
  streamText,
  type LanguageModel,
  type ModelMessage,
} from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { getUserModelEndpointById } from "@/lib/db";

/** 强制走旧版 mock 流（无 API Key 演示用） */
export function isChatMockMode(): boolean {
  const v = process.env.CW_CHAT_MOCK?.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

/** LiteLLM OpenAI 兼容根路径，须含 /v1 后缀 */
export function getLitellmBaseUrl(): string {
  const raw = process.env.LITELLM_BASE_URL?.trim();
  const base = raw && raw.length > 0 ? raw : "http://127.0.0.1:4000/v1";
  return base.replace(/\/+$/, "");
}

export function getApiKeyForProvider(provider: string): string | undefined {
  const p = provider.trim().toLowerCase();
  if (p.startsWith("custom_openai::")) {
    const endpointId = p.slice("custom_openai::".length).trim();
    if (!endpointId) return undefined;
    return getUserModelEndpointById(endpointId)?.api_key?.trim() || undefined;
  }
  if (p === "litellm") {
    return process.env.LITELLM_API_KEY?.trim() || undefined;
  }
  if (p === "openai") {
    return process.env.OPENAI_API_KEY?.trim() || undefined;
  }
  if (p === "anthropic") {
    return process.env.ANTHROPIC_API_KEY?.trim() || undefined;
  }
  if (p === "deepseek") {
    return process.env.DEEPSEEK_API_KEY?.trim() || undefined;
  }
  return undefined;
}

export function missingKeyMessage(provider: string): string {
  const p = provider.trim().toLowerCase();
  if (p.startsWith("custom_openai::")) {
    return "未配置或已失效的自定义 OpenAI 兼容接口。请在个人偏好中重新填写 API 地址/Key。";
  }
  if (p === "litellm") {
    return (
      "未配置 LITELLM_API_KEY（须与 LiteLLM 的 LITELLM_MASTER_KEY 一致）。请在 apps/web/.env.local 设置 LITELLM_BASE_URL + LITELLM_API_KEY；" +
      "本地 Proxy：docker compose -f docker-compose.litellm.yml up。详见 docs/litellm.md。"
    );
  }
  if (p === "openai") {
    return "未配置 OPENAI_API_KEY。请在 apps/web/.env.local 中设置，或暂时使用 CW_CHAT_MOCK=1 体验 mock 流。";
  }
  if (p === "anthropic") {
    return "未配置 ANTHROPIC_API_KEY。请在 apps/web/.env.local 中设置，或切换到 OpenAI 模型。";
  }
  if (p === "deepseek") {
    return "未配置 DEEPSEEK_API_KEY。请在 apps/web/.env.local 中设置。";
  }
  return `不支持的模型提供商: ${provider}`;
}

/**
 * UI / DB 里存的短 id → 供应商当前接受的 model id
 */
export function resolveProviderModelId(
  provider: string,
  modelId: string
): string {
  const p = provider.trim().toLowerCase();
  if (p === "anthropic" && modelId === "claude-3-5-sonnet") {
    return "claude-sonnet-4-20250514";
  }
  return modelId;
}

function getCustomOpenAIEndpoint(provider: string): {
  baseUrl: string;
  apiKey: string;
} | null {
  const p = provider.trim().toLowerCase();
  if (!p.startsWith("custom_openai::")) return null;
  const endpointId = p.slice("custom_openai::".length).trim();
  if (!endpointId) return null;
  const endpoint = getUserModelEndpointById(endpointId);
  if (!endpoint) return null;
  const baseUrl = endpoint.base_url.trim().replace(/\/+$/, "");
  const apiKey = endpoint.api_key.trim();
  if (!baseUrl || !apiKey) return null;
  return { baseUrl, apiKey };
}

export const TAVERN_SYSTEM_PROMPT = `你是 CanonWeave 单人酒馆里的叙事者与酒馆主人。用第二人称或自然叙事带玩家沉浸其中；回复简洁有画面感，适合文字角色扮演。不要输出系统说明或元评论。`;

/** 控制注入模型的世界观 JSON 长度，避免撑爆上下文 */
const MAX_WORLD_CONTEXT_CHARS = 28_000;

export function formatWorldContextForPrompt(
  worldName: string,
  version: number,
  canonicalJson: string
): string {
  let json = canonicalJson.trim();
  let suffix = "";
  if (json.length > MAX_WORLD_CONTEXT_CHARS) {
    json = json.slice(0, MAX_WORLD_CONTEXT_CHARS);
    suffix = "\n…[世界观 JSON 已截断以控制长度]";
  }
  return (
    `【绑定世界】${worldName}（版本 v${version}）\n` +
    "以下为当前会话绑定的 Canonical 设定（JSON）。叙事时请遵守其中的实体、地点、事件与关系，避免无依据吃书：\n" +
    json +
    suffix
  );
}

export function buildTavernSystemPrompt(worldContext: string | null | undefined): string {
  const extra = worldContext?.trim();
  if (!extra) return TAVERN_SYSTEM_PROMPT;
  return `${TAVERN_SYSTEM_PROMPT}\n\n---\n${extra}`;
}

const MAX_CONTEXT_MESSAGES = 48;

export function buildCoreMessages(
  rows: Array<{ role: string; content: string }>
): ModelMessage[] {
  const slice = rows.slice(-MAX_CONTEXT_MESSAGES);
  const out: ModelMessage[] = [];
  for (const row of slice) {
    if (row.role === "user" || row.role === "assistant") {
      out.push({
        role: row.role,
        content: row.content,
      });
    }
  }
  return out;
}

type TavernStreamTextExtras = Pick<
  Parameters<typeof streamText>[0],
  "tools" | "stopWhen" | "toolChoice"
>;

export function streamTavernCompletion(
  input: {
    provider: string;
    modelId: string;
    messages: ModelMessage[];
    /** 已由路由层格式化的世界观块；空则仅用语义酒馆 system */
    worldContext?: string | null;
    /** 会话运行时状态摘要（JSON 文本块） */
    sessionStateHint?: string | null;
    /** 追加到 system（例如 Agent 工具说明） */
    extraSystemAppend?: string | null;
  } & Partial<TavernStreamTextExtras>
) {
  const provider = input.provider.trim().toLowerCase();
  const modelId = resolveProviderModelId(provider, input.modelId);
  let system = buildTavernSystemPrompt(input.worldContext);
  const st = input.sessionStateHint?.trim();
  if (st) {
    system = `${system}\n\n---\n${st}`;
  }
  const extra = input.extraSystemAppend?.trim();
  if (extra) {
    system = `${system}\n\n---\n${extra}`;
  }

  const tools = input.tools;
  const hasTools = Boolean(tools && Object.keys(tools).length > 0);
  const toolStreamOpts = hasTools
    ? {
        tools,
        stopWhen: input.stopWhen ?? stepCountIs(12),
        ...(input.toolChoice !== undefined ? { toolChoice: input.toolChoice } : {}),
      }
    : {};

  const custom = getCustomOpenAIEndpoint(provider);
  if (custom) {
    const gateway = createOpenAI({
      apiKey: custom.apiKey,
      baseURL: custom.baseUrl,
    });
    return streamText({
      model: gateway.chat(modelId),
      system,
      messages: input.messages,
      maxOutputTokens: 2048,
      ...toolStreamOpts,
    });
  }

  if (provider === "litellm") {
    const apiKey = getApiKeyForProvider("litellm");
    if (!apiKey) {
      throw new Error(missingKeyMessage("litellm"));
    }
    const gateway = createOpenAI({
      apiKey,
      baseURL: getLitellmBaseUrl(),
    });
    return streamText({
      model: gateway.chat(modelId),
      system,
      messages: input.messages,
      maxOutputTokens: 2048,
      ...toolStreamOpts,
    });
  }

  if (provider === "openai") {
    const apiKey = getApiKeyForProvider("openai");
    if (!apiKey) {
      throw new Error(missingKeyMessage("openai"));
    }
    const openai = createOpenAI({ apiKey });
    return streamText({
      model: openai.chat(modelId),
      system,
      messages: input.messages,
      maxOutputTokens: 2048,
      ...toolStreamOpts,
    });
  }

  if (provider === "deepseek") {
    const apiKey = getApiKeyForProvider("deepseek");
    if (!apiKey) {
      throw new Error(missingKeyMessage("deepseek"));
    }
    const deepseek = createOpenAI({
      apiKey,
      baseURL: "https://api.deepseek.com/v1",
    });
    return streamText({
      model: deepseek.chat(modelId),
      system,
      messages: input.messages,
      maxOutputTokens: 2048,
      ...toolStreamOpts,
    });
  }

  if (provider === "anthropic") {
    const apiKey = getApiKeyForProvider("anthropic");
    if (!apiKey) {
      throw new Error(missingKeyMessage("anthropic"));
    }
    const anthropic = createAnthropic({ apiKey });
    return streamText({
      model: anthropic(modelId),
      system,
      messages: input.messages,
      maxOutputTokens: 2048,
      ...toolStreamOpts,
    });
  }

  throw new Error(missingKeyMessage(provider));
}

/**
 * 通用流式补全（固定 system，无酒馆专用拼接）。供编剧工坊等复用。
 */
export function streamRawCompletion(input: {
  provider: string;
  modelId: string;
  system: string;
  messages: ModelMessage[];
  maxOutputTokens?: number;
}) {
  const provider = input.provider.trim().toLowerCase();
  const modelId = resolveProviderModelId(provider, input.modelId);
  const system = input.system;
  const maxOut = input.maxOutputTokens ?? 4096;

  const custom = getCustomOpenAIEndpoint(provider);
  if (custom) {
    const gateway = createOpenAI({
      apiKey: custom.apiKey,
      baseURL: custom.baseUrl,
    });
    return streamText({
      model: gateway.chat(modelId),
      system,
      messages: input.messages,
      maxOutputTokens: maxOut,
    });
  }

  if (provider === "litellm") {
    const apiKey = getApiKeyForProvider("litellm");
    if (!apiKey) {
      throw new Error(missingKeyMessage("litellm"));
    }
    const gateway = createOpenAI({
      apiKey,
      baseURL: getLitellmBaseUrl(),
    });
    return streamText({
      model: gateway.chat(modelId),
      system,
      messages: input.messages,
      maxOutputTokens: maxOut,
    });
  }

  if (provider === "openai") {
    const apiKey = getApiKeyForProvider("openai");
    if (!apiKey) {
      throw new Error(missingKeyMessage("openai"));
    }
    const openai = createOpenAI({ apiKey });
    return streamText({
      model: openai.chat(modelId),
      system,
      messages: input.messages,
      maxOutputTokens: maxOut,
    });
  }

  if (provider === "deepseek") {
    const apiKey = getApiKeyForProvider("deepseek");
    if (!apiKey) {
      throw new Error(missingKeyMessage("deepseek"));
    }
    const deepseek = createOpenAI({
      apiKey,
      baseURL: "https://api.deepseek.com/v1",
    });
    return streamText({
      model: deepseek.chat(modelId),
      system,
      messages: input.messages,
      maxOutputTokens: maxOut,
    });
  }

  if (provider === "anthropic") {
    const apiKey = getApiKeyForProvider("anthropic");
    if (!apiKey) {
      throw new Error(missingKeyMessage("anthropic"));
    }
    const anthropic = createAnthropic({ apiKey });
    return streamText({
      model: anthropic(modelId),
      system,
      messages: input.messages,
      maxOutputTokens: maxOut,
    });
  }

  throw new Error(missingKeyMessage(provider));
}

/**
 * 非流式调用（如世界书导入 generateObject）使用的语言模型。
 * 与 {@link streamTavernCompletion} 使用相同的供应商路由与 Key。
 */
export function getLanguageModelForProvider(
  provider: string,
  modelId: string
): LanguageModel {
  const p = provider.trim().toLowerCase();
  const mid = resolveProviderModelId(p, modelId);

  const custom = getCustomOpenAIEndpoint(p);
  if (custom) {
    const gateway = createOpenAI({
      apiKey: custom.apiKey,
      baseURL: custom.baseUrl,
    });
    return gateway.chat(mid);
  }

  if (p === "litellm") {
    const apiKey = getApiKeyForProvider("litellm");
    if (!apiKey) {
      throw new Error(missingKeyMessage("litellm"));
    }
    const gateway = createOpenAI({
      apiKey,
      baseURL: getLitellmBaseUrl(),
    });
    return gateway.chat(mid);
  }

  if (p === "openai") {
    const apiKey = getApiKeyForProvider("openai");
    if (!apiKey) {
      throw new Error(missingKeyMessage("openai"));
    }
    const openai = createOpenAI({ apiKey });
    return openai.chat(mid);
  }

  if (p === "deepseek") {
    const apiKey = getApiKeyForProvider("deepseek");
    if (!apiKey) {
      throw new Error(missingKeyMessage("deepseek"));
    }
    const deepseek = createOpenAI({
      apiKey,
      baseURL: "https://api.deepseek.com/v1",
    });
    return deepseek.chat(mid);
  }

  if (p === "anthropic") {
    const apiKey = getApiKeyForProvider("anthropic");
    if (!apiKey) {
      throw new Error(missingKeyMessage("anthropic"));
    }
    const anthropic = createAnthropic({ apiKey });
    return anthropic(mid);
  }

  throw new Error(missingKeyMessage(p));
}
