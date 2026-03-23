import "server-only";

import {
  parseAndValidateCanonicalWorld,
  type CanonicalWorld,
} from "@/lib/canonical-world";
import { invokeWorldForgeUnifiedLangGraph } from "@/lib/world-forge-langgraph-unified";
import type {
  Wf1PipelineResult,
  Wf1StepRecord,
} from "@/lib/world-forge-pipeline-types";
import { clampWorldForgeReviewRounds } from "@/lib/world-forge-review-config";
import { wfBuildLatestCanonicalBlock, WF_MAX_BRIEF_BYTES } from "@/lib/world-forge-shared";
import { getLanguageModelForProvider } from "@/lib/llm";

export type {
  Wf1PipelineFailure,
  Wf1PipelineResult,
  Wf1PipelineSuccess,
  Wf1StepId,
  Wf1StepRecord,
  WorldForgePipelineFailure,
  WorldForgePipelineResult,
  WorldForgePipelineSuccess,
  WorldForgeProfile,
  WorldForgeStepId,
  WorldForgeStepRecord,
} from "@/lib/world-forge-pipeline-types";

/**
 * WorldForge **WF-1**：统一 LangGraph 中的 **解析 → 扩写 ↔ 审查**（profile=`wf1`）。
 */
export async function runWorldForgeWf1Pipeline(input: {
  worldName: string;
  rawBrief: string;
  provider: string;
  modelId: string;
  mergeWithLatest: boolean;
  currentCanonicalJson: string | null;
  useMock: boolean;
  maxReviewRounds?: number;
  withLastDraftOnFail?: boolean;
}): Promise<Wf1PipelineResult> {
  const steps: Wf1StepRecord[] = [];
  const brief = input.rawBrief.trim();
  const maxRounds = clampWorldForgeReviewRounds(input.maxReviewRounds);

  if (!brief) {
    return { ok: false, profile: "wf1", steps, error: "大纲/素材为空。" };
  }

  const enc = new TextEncoder();
  if (enc.encode(brief).length > WF_MAX_BRIEF_BYTES) {
    return {
      ok: false,
      profile: "wf1",
      steps,
      error: `大纲过长（上限 ${WF_MAX_BRIEF_BYTES} 字节），请精简或拆分。`,
    };
  }

  if (input.useMock) {
    const mockSummary =
      "（Mock）WF-1：占位解析摘要；审查员**直接通过**。\n" +
      `- 大纲长度 ${brief.length} 字符`;

    const mockCanonical: CanonicalWorld = {
      meta: {
        title: input.worldName,
        note: "Mock：WF-1 未调用真实扩写/审查；关闭 CW_CHAT_MOCK 后重试。",
      } as Record<string, unknown>,
      entities: [] as unknown[],
      relations: [] as unknown[],
      rules: [] as unknown[],
      timeline: [] as unknown[],
      lore_entries: [] as unknown[],
      locks: [] as unknown[],
      warnings: [] as unknown[],
    };

    if (input.mergeWithLatest && input.currentCanonicalJson?.trim()) {
      const p = parseAndValidateCanonicalWorld(input.currentCanonicalJson);
      if (p.ok) {
        mockCanonical.meta = { ...p.canonical.meta, ...mockCanonical.meta };
        mockCanonical.entities = p.canonical.entities;
        mockCanonical.relations = p.canonical.relations;
        mockCanonical.rules = p.canonical.rules;
        mockCanonical.timeline = p.canonical.timeline;
        mockCanonical.lore_entries = p.canonical.lore_entries;
        mockCanonical.locks = p.canonical.locks;
        mockCanonical.warnings = p.canonical.warnings;
        if (p.canonical.world_book !== undefined) {
          mockCanonical.world_book = p.canonical.world_book;
        }
        if (p.canonical.character_books !== undefined) {
          mockCanonical.character_books = p.canonical.character_books;
        }
      }
    }

    const v = parseAndValidateCanonicalWorld(JSON.stringify(mockCanonical));
    if (!v.ok) {
      return {
        ok: false,
        mock: true,
        profile: "wf1",
        steps: [
          { id: "parse_summary", ok: true, summary: mockSummary },
          {
            id: "expand_canonical",
            ok: false,
            attempt: 1,
            error: "Mock 校验失败。",
            errors: v.errors,
          },
        ],
        error: "Mock 校验失败。",
        errors: v.errors,
      };
    }

    steps.push({ id: "parse_summary", ok: true, summary: mockSummary });
    steps.push({
      id: "expand_canonical",
      ok: true,
      attempt: 1,
      note: "Mock：占位扩写。",
    });
    steps.push({
      id: "review",
      ok: true,
      attempt: 1,
      passed: true,
    });

    return {
      ok: true,
      mock: true,
      profile: "wf1",
      steps,
      validated: v,
      normalizedJson: v.normalizedJson,
      reviewRoundsUsed: 1,
    };
  }

  try {
    getLanguageModelForProvider(input.provider, input.modelId);
  } catch (e) {
    return {
      ok: false,
      profile: "wf1",
      steps,
      error: e instanceof Error ? e.message : "模型不可用。",
    };
  }

  const latestBlock = wfBuildLatestCanonicalBlock(
    input.currentCanonicalJson,
    input.mergeWithLatest
  );

  return invokeWorldForgeUnifiedLangGraph({
    profile: "wf1",
    worldName: input.worldName,
    brief,
    latestBlock,
    maxReviewRounds: maxRounds,
    withLastDraftOnFail: Boolean(input.withLastDraftOnFail),
    mergeWithLatest: input.mergeWithLatest,
    provider: input.provider,
    modelId: input.modelId,
  });
}
