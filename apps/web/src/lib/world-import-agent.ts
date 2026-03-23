import "server-only";

import { generateObject, generateText, zodSchema, type LanguageModel } from "ai";
import * as z from "zod";
import {
  parseAndValidateCanonicalWorld,
  type CanonicalWorld,
  type ValidateResult,
} from "@/lib/canonical-world";
import { getLanguageModelForProvider } from "@/lib/llm";

/** AI 解析输入上限（略小于 Canonical 校验上限，控制成本） */
const MAX_AGENT_INPUT_BYTES = 256 * 1024;

export type WorldImportAgentSuccess = {
  ok: true;
  validated: Extract<ValidateResult, { ok: true }>;
};

export type WorldImportAgentFailure = {
  ok: false;
  error: string;
  errors?: string[];
};

/** 与 generateObject 共用，供编剧合并落库等复用 */
export const CanonicalDraftSchema = z.object({
  meta: z.record(z.string(), z.any()).default({}),
  entities: z.array(z.any()).default([]),
  relations: z.array(z.any()).default([]),
  rules: z.array(z.any()).default([]),
  timeline: z.array(z.any()).default([]),
  lore_entries: z.array(z.any()).default([]),
  locks: z.array(z.any()).default([]),
  warnings: z.array(z.any()).default([]),
  /** 可选：世界书本体（条目化 Lore），见 docs/world-lorebook-spec.md */
  world_book: z.record(z.string(), z.any()).optional(),
  /** 可选：人物书数组，每项绑定角色实体 */
  character_books: z.array(z.record(z.string(), z.any())).optional(),
});

/** 将模型返回的 draft 规范化为 CanonicalWorld 并做服务器校验 */
export function finalizeCanonicalDraftFromObject(
  object: z.infer<typeof CanonicalDraftSchema>
): WorldImportAgentSuccess | WorldImportAgentFailure {
  const draft: CanonicalWorld = {
    meta:
      object.meta && typeof object.meta === "object" && !Array.isArray(object.meta)
        ? (object.meta as Record<string, unknown>)
        : {},
    entities: Array.isArray(object.entities) ? object.entities : [],
    relations: Array.isArray(object.relations) ? object.relations : [],
    rules: Array.isArray(object.rules) ? object.rules : [],
    timeline: Array.isArray(object.timeline) ? object.timeline : [],
    lore_entries: Array.isArray(object.lore_entries) ? object.lore_entries : [],
    locks: Array.isArray(object.locks) ? object.locks : [],
    warnings: Array.isArray(object.warnings) ? object.warnings : [],
  };
  if (object.world_book !== undefined) {
    draft.world_book = object.world_book as CanonicalWorld["world_book"];
  }
  if (object.character_books !== undefined) {
    draft.character_books = object.character_books as CanonicalWorld["character_books"];
  }

  const normalizedJson = JSON.stringify(draft);
  const validated = parseAndValidateCanonicalWorld(normalizedJson);
  if (!validated.ok) {
    return {
      ok: false,
      error: "模型输出未通过服务器 Canonical 校验。",
      errors: validated.errors,
    };
  }

  return { ok: true, validated };
}

/** 从模型纯文本回复中尽量抠出 JSON 对象（支持 ```json 围栏或首尾杂质） */
export function extractJsonObjectFromModelOutput(text: string): unknown | null {
  const trimmed = text.trim();
  const tryParseCandidate = (candidateRaw: string): unknown | null => {
    const candidate = candidateRaw.trim();
    if (!candidate) return null;
    try {
      return JSON.parse(candidate) as unknown;
    } catch {
      const start = candidate.indexOf("{");
      const end = candidate.lastIndexOf("}");
      if (start < 0 || end <= start) return null;
      try {
        return JSON.parse(candidate.slice(start, end + 1)) as unknown;
      } catch {
        return null;
      }
    }
  };

  // 1) 优先遍历所有 fenced code block，而不是只吃第一个，避免首块半截 JSON 误伤。
  const fenceRegex = /```(?:json)?\s*([\s\S]*?)```/gi;
  const fenceCandidates: string[] = [];
  for (const match of trimmed.matchAll(fenceRegex)) {
    if (match[1]) fenceCandidates.push(match[1]);
  }
  for (const candidate of fenceCandidates) {
    const parsed = tryParseCandidate(candidate);
    if (parsed) return parsed;
  }

  // 2) 无 fence 或 fence 全失败时，对全文做一次兜底提取。
  return tryParseCandidate(trimmed);
}

export function isStructuredOutputUnsupportedError(message: string): boolean {
  const m = message.toLowerCase();
  return (
    m.includes("response_format") ||
    m.includes("json_schema") ||
    m.includes("unavailable now") ||
    m.includes("does not support") ||
    m.includes("structured output") ||
    m.includes("structured outputs") ||
    m.includes("invalid_request_error") && m.includes("response_format")
  );
}

function forceCanonicalTextOnlyMode(): boolean {
  const v = process.env.CW_CANONICAL_TEXT_ONLY?.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

export type CanonicalObjectGenMeta = {
  schemaName: string;
  schemaDescription: string;
};

/**
 * 优先用 generateObject（JSON Schema / structured output）；若上游不支持（如 LiteLLM 转发部分模型、部分兼容端），
 * 自动回退为 generateText + 解析 JSON，再经 CanonicalDraftSchema 与服务器校验。
 */
export async function generateCanonicalDraftWithModel(input: {
  model: LanguageModel;
  system: string;
  userPrompt: string;
  maxOutputTokens?: number;
  temperature?: number;
  objectGenMeta?: CanonicalObjectGenMeta;
}): Promise<WorldImportAgentSuccess | WorldImportAgentFailure> {
  const maxOutputTokens = input.maxOutputTokens ?? 8192;
  const temperature = input.temperature ?? 0.2;
  const meta = input.objectGenMeta ?? {
    schemaName: "canonical_world",
    schemaDescription:
      "CanonWeave world: meta, entities, relations, rules, timeline, lore_entries, locks, warnings; optional world_book, character_books (lorebook)",
  };

  if (!forceCanonicalTextOnlyMode()) {
    try {
      const result = await generateObject({
        model: input.model,
        schema: zodSchema(CanonicalDraftSchema),
        schemaName: meta.schemaName,
        schemaDescription: meta.schemaDescription,
        system: input.system,
        prompt: input.userPrompt,
        maxOutputTokens,
        temperature,
      });
      return finalizeCanonicalDraftFromObject(result.object);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!isStructuredOutputUnsupportedError(msg)) {
        return {
          ok: false,
          error: msg || "结构化生成失败。",
        };
      }
    }
  }

  const textSystem = `${input.system}

【输出格式 — 文本回退】当前 API 不支持严格的 JSON Schema 模式。请**只输出一个**合法 JSON 对象（UTF-8），顶层键必须包含：meta, entities, relations, rules, timeline, lore_entries, locks, warnings；可选 world_book、character_books（世界书/人物书本体，见系统说明）。不要写前言或解释；如需使用 Markdown，请仅用一层 \`\`\`json … \`\`\` 包裹该对象。`;

  try {
    const textResult = await generateText({
      model: input.model,
      system: textSystem,
      prompt: input.userPrompt,
      maxOutputTokens,
      temperature,
    });
    let parsed = extractJsonObjectFromModelOutput(textResult.text);
    if (!parsed) {
      // 二次修复：当文本回退输出混入解释/Markdown 时，再让模型只做 JSON 转写。
      const repair = await generateText({
        model: input.model,
        system:
          "你是 JSON 修复器。把输入整理为一个合法 JSON 对象，只输出 JSON，不要解释。",
        prompt:
          "目标顶层键必须包含：meta, entities, relations, rules, timeline, lore_entries, locks, warnings；" +
          "可选 world_book、character_books。若信息不足请保留键并给空数组/空对象，不要省略。\n\n" +
          "待修复文本：\n" +
          textResult.text,
        maxOutputTokens,
        temperature: 0,
      });
      parsed = extractJsonObjectFromModelOutput(repair.text);
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {
        ok: false,
        error:
          "文本回退：未能从模型输出中解析出 JSON 对象。可尝试换用支持 structured outputs 的模型，或设置 CW_CANONICAL_TEXT_ONLY=1 强制走文本模式。",
      };
    }
    const draft = CanonicalDraftSchema.safeParse(parsed);
    if (!draft.success) {
      return {
        ok: false,
        error: "文本回退：JSON 结构与 Canonical 草稿不符。",
        errors: [draft.error.message],
      };
    }
    return finalizeCanonicalDraftFromObject(draft.data);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      error: `文本回退生成失败：${msg}`,
    };
  }
}

/** 将非结构化素材扩写为 Canonical 时的系统提示（WorldForge WF-0 等可复用） */
export const WORLD_IMPORT_SYSTEM = `你是 CanonWeave 世界书结构化 Agent。用户会粘贴 Markdown、YAML 片段、条目列表或混杂纯文本的设定稿。
你的任务：提炼为**一个**符合 CanonWeave Canonical 形状的 JSON 对象（下列**必选**顶层键勿遗漏键名；**可选** lorebook 键在素材足够时务必填充）：

- meta：对象。必须尽量包含 title（字符串）。可含 subtitle、author、tone、notes 等。
- entities：数组。角色/地点/组织/物品等；每项建议为对象，含 id（英文 slug）、name、kind、summary 等；信息不足可少字段。
- relations：数组。实体关系；每项可为 { from, to, type, note } 或等价结构。
- rules：数组。世界规则、禁忌、魔法/科技约束；项可为对象或短字符串。
- timeline：数组。大事记；项可含 id、label、when、detail。
- lore_entries：数组。背景 Lore 摘要或索引；项可含 title、body 或 text（长文与触发策略请放 world_book / character_books）。
- locks：数组。用户强调不可被后续改写覆盖的设定锚点。
- warnings：数组。对叙事者的提醒（如「禁止 OOC」类可放 meta，此处放剧情雷区等）。
- world_book（可选但推荐）：对象。世界范围「世界书本体」，与具体人物解耦。建议含 name、kind:"world"、entries 数组。每个 entry 尽量含：id、title 或 memo、content（或 body）、keys（触发关键词数组）、strategy（constant|keyword）、position（如 before_character）、order、trigger_probability_percent（0–100）、enabled。
- character_books（可选但推荐）：数组。人物书列表；每项绑定一个可扮演主体（通常 1 人；多人组合卡写在同一项内说明）。除 kind:"character"、bound_entity_id、bound_entity_name、name、entries（Lorebook 触发条目）外，**必须**含 character_card 对象，与 SillyTavern 角色卡语义对齐，至少含：description、personality、scenario、first_mes、mes_example；建议含 appearance、backstory、relationships、speech_patterns、post_history_instructions、alternate_greetings、tags。entries 为关键词触发向补充，勿用空壳条目替代 character_card。

硬性要求：
1. 严格基于用户文本归纳，不要凭空扩写一整个无关世界观；不清楚处用简短占位或留空数组。
2. 所有数组必须是 JSON 数组；元素为对象时键名用英文小写+下划线风格。
3. 输出由工具/schema 约束为结构化对象，不要夹杂解释性散文。`;

/**
 * 使用结构化生成将自由文本转为 Canonical，再经服务器 parseAndValidateCanonicalWorld 校验。
 */
export async function convertWorldSourceWithAgent(input: {
  rawText: string;
  provider: string;
  modelId: string;
}): Promise<WorldImportAgentSuccess | WorldImportAgentFailure> {
  const raw = input.rawText.trim();
  if (!raw) {
    return { ok: false, error: "素材为空。" };
  }

  const enc = new TextEncoder();
  if (enc.encode(raw).length > MAX_AGENT_INPUT_BYTES) {
    return {
      ok: false,
      error: `素材过长（AI 解析上限 ${MAX_AGENT_INPUT_BYTES} 字节）。请精简或拆多次导入。`,
    };
  }

  let model;
  try {
    model = getLanguageModelForProvider(input.provider, input.modelId);
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : "模型不可用。",
    };
  }

  const result = await generateCanonicalDraftWithModel({
    model,
    system: WORLD_IMPORT_SYSTEM,
    userPrompt: `以下为用户世界书素材，请输出符合 schema 的对象：\n\n---\n${raw}`,
    maxOutputTokens: 8192,
    temperature: 0.2,
    objectGenMeta: {
      schemaName: "canonical_world",
      schemaDescription:
        "CanonWeave: canonical meta/entities/relations/rules/timeline/lore_entries/locks/warnings + optional world_book & character_books lorebook",
    },
  });

  if (!result.ok) {
    return {
      ok: false,
      error: `模型解析失败：${result.error}`,
      errors: result.errors,
    };
  }
  return result;
}

/**
 * 在已通过校验的 Canonical 基础上，尽量把角色类 entities 补齐到 character_books。
 * 仅做增量补齐：尽量保留现有字段与条目。
 */
export async function enrichCharacterBooksWithAgent(input: {
  canonicalJson: string;
  provider: string;
  modelId: string;
}): Promise<WorldImportAgentSuccess | WorldImportAgentFailure> {
  const raw = input.canonicalJson.trim();
  if (!raw) {
    return { ok: false, error: "Canonical 为空，无法补齐角色卡。" };
  }
  let model;
  try {
    model = getLanguageModelForProvider(input.provider, input.modelId);
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : "模型不可用。",
    };
  }
  const system = `${WORLD_IMPORT_SYSTEM}

【补齐任务：人物书优先】
你将收到一份已有 Canonical JSON。请只做“增量补齐”：
1) 保留已有 world_book / character_books / entities / rules / timeline，不要无关大改。
2) 识别 entities 中 kind/type/name 显示为“角色”或可扮演人物的项，尽量保证每个关键角色有对应 character_books 项。
3) 若已有 character_books，不重复造同名/同 bound_entity_id；缺则新增。
4) 每个新增项必须包含：bound_entity_id、bound_entity_name、name、character_card（description/personality/scenario/first_mes/mes_example）、entries(3~6)。
5) 输出必须是单个合法 Canonical JSON 对象。`;

  return generateCanonicalDraftWithModel({
    model,
    system,
    userPrompt:
      `请基于这份 Canonical 做“角色卡补齐”并输出完整 JSON：\n\n${raw}`,
    maxOutputTokens: 8192,
    temperature: 0.2,
    objectGenMeta: {
      schemaName: "canonical_world_character_books_enrich",
      schemaDescription:
        "Canonical enrich: preserve existing world and add missing character_books for role entities",
    },
  });
}
