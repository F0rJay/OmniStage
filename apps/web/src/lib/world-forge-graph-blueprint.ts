import "server-only";

import { generateObject, generateText, zodSchema, type LanguageModel } from "ai";
import { z } from "zod";
import {
  extractJsonObjectFromModelOutput,
  isStructuredOutputUnsupportedError,
} from "@/lib/world-import-agent";
import { wfTruncateUtf8 } from "@/lib/world-forge-shared";

const GraphEntitySchema = z.object({
  name: z.string(),
  kind: z.string().optional(),
  notes: z.string().optional(),
});

const GraphRelationSchema = z.object({
  from: z.string(),
  to: z.string(),
  type: z.string().optional(),
  notes: z.string().optional(),
});

const GraphGapSchema = z.object({
  id: z.string().optional(),
  question: z.string(),
  priority: z.enum(["high", "medium", "low"]).optional(),
});

export const WorldForgeGraphBlueprintSchema = z.object({
  entities: z.array(GraphEntitySchema),
  relations: z.array(GraphRelationSchema),
  gaps: z.array(GraphGapSchema),
});

export type WorldForgeGraphBlueprint = z.infer<typeof WorldForgeGraphBlueprintSchema>;

const GRAPH_SYSTEM = `你是 CanonWeave **WorldForge·图谱解析员**（WF-3 节点）。
基于用户大纲与解析员摘要，输出**结构化 JSON**（通过 schema），包含：
- entities：已出现或隐含的角色、地点、势力、物品等（name 必填；kind/notes 选填）；
- relations：实体之间的关系边（from/to 用实体 name；type 如「隶属」「对立」「因果」等）；
- gaps：3～10 条待澄清缺口（question 必填；priority 可选 high/medium/low）。

不要编造摘要中完全不存在的实体；信息不足时 gaps 多列「待确认」类问题。`;

function graphBlueprintFromUnknown(parsed: unknown):
  | { ok: true; value: WorldForgeGraphBlueprint }
  | { ok: false; error: string } {
  const r = WorldForgeGraphBlueprintSchema.safeParse(parsed);
  if (!r.success) {
    return {
      ok: false,
      error: `图谱 JSON 与 schema 不符：${r.error.message}`,
    };
  }
  return { ok: true, value: r.data };
}

/**
 * 生成实体–关系–缺口蓝图，供下游 Agent 提示词与 UI 展示。
 */
export async function runWorldForgeGraphBlueprintStep(input: {
  model: LanguageModel;
  worldName: string;
  brief: string;
  summaryText: string;
}): Promise<
  { ok: true; blueprint: WorldForgeGraphBlueprint } | { ok: false; error: string }
> {
  const userPrompt =
    `【世界名称】${input.worldName}\n\n` +
    `【用户原始大纲】\n${wfTruncateUtf8(input.brief, 48_000)}\n\n` +
    `【解析员结构化摘要】\n${wfTruncateUtf8(input.summaryText, 8_000)}\n`;

  try {
    const result = await generateObject({
      model: input.model,
      schema: zodSchema(WorldForgeGraphBlueprintSchema),
      schemaName: "world_forge_graph_blueprint",
      schemaDescription:
        "WorldForge WF-3: entities, relations, gaps for world-building graph",
      system: GRAPH_SYSTEM,
      prompt: userPrompt,
      maxOutputTokens: 3072,
      temperature: 0.25,
    });
    const v = graphBlueprintFromUnknown(result.object);
    if (!v.ok) return { ok: false, error: v.error };
    return { ok: true, blueprint: v.value };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!isStructuredOutputUnsupportedError(msg)) {
      return { ok: false, error: msg || "图谱结构化生成失败。" };
    }
  }

  const fallbackSystem = `${GRAPH_SYSTEM}

【输出格式 — 文本回退】请**只输出一个**合法 JSON 对象，顶层键：entities（数组）、relations（数组）、gaps（数组）。不要前言或 Markdown 解释；可仅用一层 \`\`\`json … \`\`\` 包裹。`;

  try {
    const textResult = await generateText({
      model: input.model,
      system: fallbackSystem,
      prompt: userPrompt,
      maxOutputTokens: 3072,
      temperature: 0.25,
    });
    let parsed = extractJsonObjectFromModelOutput(textResult.text);
    if (!parsed) {
      // 二次修复：当模型在“文本回退”里输出了说明文字/Markdown 时，要求其仅做 JSON 转写。
      const repair = await generateText({
        model: input.model,
        system:
          "你是 JSON 修复器。将输入文本整理为一个合法 JSON 对象。仅输出 JSON，不要任何解释。",
        prompt:
          "目标顶层键必须且仅需包含：entities（数组）、relations（数组）、gaps（数组）。\n" +
          "若信息不足请给空数组，不要省略键。\n\n" +
          "待修复文本：\n" +
          textResult.text,
        maxOutputTokens: 2200,
        temperature: 0,
      });
      parsed = extractJsonObjectFromModelOutput(repair.text);
    }
    if (!parsed) {
      return {
        ok: false,
        error: "图谱步骤（文本回退）未能解析出 JSON 对象。",
      };
    }
    const v = graphBlueprintFromUnknown(parsed);
    if (!v.ok) return { ok: false, error: v.error };
    return { ok: true, blueprint: v.value };
  } catch (e2) {
    const msg2 = e2 instanceof Error ? e2.message : String(e2);
    return { ok: false, error: msg2 || "图谱步骤失败。" };
  }
}

export function formatGraphBlueprintForPrompt(
  blueprint: WorldForgeGraphBlueprint | undefined
): string {
  if (!blueprint) return "";
  const raw = JSON.stringify(blueprint, null, 2);
  return (
    `\n【解析员·图谱蓝图（实体 / 关系 / 缺口，WF-3）】\n` +
    `${wfTruncateUtf8(raw, 14_000)}\n`
  );
}
