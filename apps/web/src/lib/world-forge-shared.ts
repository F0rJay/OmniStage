import "server-only";

import { generateText } from "ai";
import type { LanguageModel } from "ai";
import {
  generateCanonicalDraftWithModel,
  WORLD_IMPORT_SYSTEM,
} from "@/lib/world-import-agent";

/** 用户大纲最大字节（UTF-8） */
export const WF_MAX_BRIEF_BYTES = 96 * 1024;
export const WF_MAX_CANONICAL_CONTEXT_BYTES = 24 * 1024;
export const WF_MAX_PARSE_OUTPUT_CHARS = 6_000;

export const WF_PARSE_SYSTEM = `你是 CanonWeave **WorldForge** 的解析员。用户会提供模糊大纲或残缺设定。
请输出一份**结构化摘要**（使用 Markdown 小节），须包含：
1. **体裁与基调**
2. **已出现的实体 / 势力 / 地点**（列表，信息不足可写「未明确」）
3. **规则或力量体系要点**（若有；无则写「未涉及」）
4. **设定空白**：3～8 条待澄清问题（编号列表）

若运行环境提供联网 MCP（如 web_search / web_fetch_extract），可检索同题材公开资料补充表达，但必须避免抄袭并与用户设定对齐。
不要输出 JSON；不要编造与用户原文无关的宏大设定；总长度控制在 4000 字以内。`;

export function wfTruncateUtf8(s: string, maxBytes: number): string {
  const enc = new TextEncoder();
  if (enc.encode(s).length <= maxBytes) return s;
  let lo = 0;
  let hi = s.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    const slice = s.slice(0, mid);
    if (enc.encode(slice).length <= maxBytes) lo = mid;
    else hi = mid - 1;
  }
  return s.slice(0, lo);
}

export function wfBuildLatestCanonicalBlock(
  currentCanonicalJson: string | null,
  mergeWithLatest: boolean
): string {
  if (!mergeWithLatest || !currentCanonicalJson?.trim()) {
    return "";
  }
  let raw = currentCanonicalJson.trim();
  const enc = new TextEncoder();
  if (enc.encode(raw).length > WF_MAX_CANONICAL_CONTEXT_BYTES) {
    raw =
      wfTruncateUtf8(raw, WF_MAX_CANONICAL_CONTEXT_BYTES) +
      "\n…[当前 Canonical 已截断；合并时请保留未展示部分的合理延续]";
  }
  return `\n【当前已保存的 Canonical 快照（须在输出中融合、未提及处尽量保留）】\n${raw}\n`;
}

export function wfBuildExpandSystem(mergeWithLatest: boolean, wfLabel: string): string {
  return `${WORLD_IMPORT_SYSTEM}

【WorldForge ${wfLabel} 扩写任务】
你会收到：用户原始大纲、解析员摘要${mergeWithLatest ? "、以及（若有）当前已保存 Canonical 快照" : ""}。
请输出**一份完整**的 Canonical 对象。若提供了当前快照，须在对话未要求删除的前提下**融合**快照与大纲/摘要的新增内容。

【世界书 / 人物书本体 — 本阶段必尽力产出】
1. **world_book**：面向「整个世界」的条目化 Lore（国家/地区/文化/主要组织/历史等），与单个人物解耦；entries 宜 8～20 条，每条 content 足够具体以约束 AI 创作边界，并配置 keys + strategy（keyword/constant）与 order。
2. **character_books**：对重要可扮演角色各建一本；bound_entity_id/name 与 entities 对齐；**每本必须含完整 character_card**（对齐 SillyTavern：description、personality、scenario、first_mes、mes_example 等，见 docs/world-lorebook-spec.md §3），并另附 3～8 条 entries 作 Lorebook 触发补充；多人组合卡在同一 character_books 项内写清结构。
3. 若 token 紧张：优先保证 world_book 与各 character_card 核心字段充实；可略减 entries 条数；character_books 至少覆盖主角与 2～3 名关键 NPC。
详细字段约定见项目文档 \`docs/world-lorebook-spec.md\`。`;
}

export function wfBuildExpandUserPrompt(input: {
  worldName: string;
  brief: string;
  summaryText: string;
  latestBlock: string;
  /** 审查不通过时附带，要求针对意见修订 */
  reviewFeedbackBlock?: string;
}): string {
  const fb = input.reviewFeedbackBlock?.trim();
  return (
    `【世界名称】${input.worldName}\n\n` +
    `【用户原始大纲】\n${input.brief}\n\n` +
    `【解析员结构化摘要】\n${input.summaryText}\n` +
    input.latestBlock +
    (fb
      ? `\n【审查员修订意见】（请优先消除下列问题，保持其余已合理内容）\n${fb}\n`
      : "") +
    `\n请输出合并/修订后的完整 canonical 对象。`
  );
}

export async function wfRunParseStep(input: {
  model: LanguageModel;
  worldName: string;
  brief: string;
}): Promise<{ ok: true; summary: string } | { ok: false; error: string }> {
  try {
    const parseResult = await generateText({
      model: input.model,
      system: WF_PARSE_SYSTEM,
      prompt: `【世界名称】${input.worldName}\n\n【用户大纲 / 残缺设定】\n${input.brief}`,
      maxOutputTokens: 2048,
      temperature: 0.35,
    });
    let summaryText = parseResult.text.trim();
    if (summaryText.length > WF_MAX_PARSE_OUTPUT_CHARS) {
      summaryText =
        summaryText.slice(0, WF_MAX_PARSE_OUTPUT_CHARS) + "\n…[摘要已截断]";
    }
    if (!summaryText) {
      return { ok: false, error: "解析步骤返回空内容。" };
    }
    return { ok: true, summary: summaryText };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: msg };
  }
}

export async function wfRunExpandStep(input: {
  model: LanguageModel;
  mergeWithLatest: boolean;
  wfLabel: string;
  userPrompt: string;
  objectSchemaName: string;
  objectDescription: string;
}): ReturnType<typeof generateCanonicalDraftWithModel> {
  const expandSystem = wfBuildExpandSystem(input.mergeWithLatest, input.wfLabel);
  return generateCanonicalDraftWithModel({
    model: input.model,
    system: expandSystem,
    userPrompt: input.userPrompt,
    maxOutputTokens: 8192,
    temperature: 0.2,
    objectGenMeta: {
      schemaName: input.objectSchemaName,
      schemaDescription: input.objectDescription,
    },
  });
}
