import "server-only";

import { generateObject, zodSchema } from "ai";
import * as z from "zod";
import { getLanguageModelForProvider } from "@/lib/llm";
import {
  classifyDynamicRpIntent,
  type DynamicRpIntent,
} from "@/lib/dynamic-rp-intent";
import { getDreIntentLlmMode, type DreIntentLlmMode } from "@/lib/dynamic-rp-config";

const LlmIntentSchema = z.object({
  kind: z.enum(["dialogue", "action"]),
  reason: z.string().max(220),
});

export type ResolvedDynamicRpIntent = DynamicRpIntent & {
  /** 本条意图最终来自规则、纯模型或 hybrid 二次判定 */
  source: "rules" | "llm" | "hybrid";
};

async function classifyIntentWithLlm(input: {
  text: string;
  provider: string;
  modelId: string;
}): Promise<DynamicRpIntent> {
  const model = getLanguageModelForProvider(input.provider, input.modelId);
  const line = input.text.trim().slice(0, 2000);
  const r = await generateObject({
    model,
    schema: zodSchema(LlmIntentSchema),
    prompt: `你是 TRPG 的「意图网关」。把玩家这句话分成两类之一：

- dialogue：寒暄、提问、对 NPC 说话、心理描写、不改变当场局势的陈述（如「你好」「他是谁」「我打量四周」若仅观察且无明确检定宣告）。
- action：玩家**试图改变场面**（移动、攻击、偷袭、偷窃、潜行、开锁、施法、推拉门窗、投掷、拔武器、逃跑路线等），包括「我要…」「试着…」「对…动手」类。

玩家原话：
${line}

只输出 JSON 结构。reason 为极短中文依据（≤40 字）。`,
    maxOutputTokens: 120,
  });
  return r.object;
}

/**
 * DRE-1：规则 fast-path + 可选 LLM（hybrid / full）。
 * LLM 失败时回退到规则结果。
 */
export async function resolveDynamicRpIntent(input: {
  text: string;
  provider: string;
  modelId: string;
  mode?: DreIntentLlmMode;
}): Promise<ResolvedDynamicRpIntent> {
  const mode = input.mode ?? getDreIntentLlmMode();
  const rules = classifyDynamicRpIntent(input.text);

  if (mode === "off") {
    return { ...rules, source: "rules" };
  }

  if (mode === "full") {
    try {
      const llm = await classifyIntentWithLlm(input);
      return { ...llm, source: "llm" };
    } catch {
      return { ...rules, source: "rules" };
    }
  }

  // hybrid
  if (rules.kind === "action") {
    return { ...rules, source: "rules" };
  }
  if (rules.reason !== "default_dialogue") {
    return { ...rules, source: "rules" };
  }

  try {
    const llm = await classifyIntentWithLlm(input);
    return { ...llm, source: "hybrid" };
  } catch {
    return { ...rules, source: "rules" };
  }
}
