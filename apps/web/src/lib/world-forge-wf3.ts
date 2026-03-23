import "server-only";

import {
  parseAndValidateCanonicalWorld,
  type CanonicalWorld,
} from "@/lib/canonical-world";
import { invokeWorldForgeUnifiedLangGraph } from "@/lib/world-forge-langgraph-unified";
import type { WorldForgePipelineResult } from "@/lib/world-forge-pipeline-types";
import type { WorldForgeGraphBlueprint } from "@/lib/world-forge-graph-blueprint";
import { clampWorldForgeReviewRounds } from "@/lib/world-forge-review-config";
import { wfBuildLatestCanonicalBlock, WF_MAX_BRIEF_BYTES } from "@/lib/world-forge-shared";
import { getLanguageModelForProvider } from "@/lib/llm";

/**
 * WorldForge **WF-3**：**解析 → 图谱 JSON（实体/关系/缺口）→ 三轨并行（架构师 ∥ 机制师 ∥ 人物卡设计师）→ 扇入合成 → 审查闭环**。
 */
export async function runWorldForgeWf3Pipeline(input: {
  worldName: string;
  rawBrief: string;
  provider: string;
  modelId: string;
  mergeWithLatest: boolean;
  currentCanonicalJson: string | null;
  useMock: boolean;
  maxReviewRounds?: number;
  withLastDraftOnFail?: boolean;
}): Promise<WorldForgePipelineResult> {
  const brief = input.rawBrief.trim();
  const maxRounds = clampWorldForgeReviewRounds(input.maxReviewRounds);

  if (!brief) {
    return { ok: false, profile: "wf3", steps: [], error: "大纲/素材为空。" };
  }

  const enc = new TextEncoder();
  if (enc.encode(brief).length > WF_MAX_BRIEF_BYTES) {
    return {
      ok: false,
      profile: "wf3",
      steps: [],
      error: `大纲过长（上限 ${WF_MAX_BRIEF_BYTES} 字节），请精简或拆分。`,
    };
  }

  if (input.useMock) {
    const mockSummary = `（Mock）WF-3：占位解析摘要。大纲 ${brief.length} 字符。`;
    const mockGraph: WorldForgeGraphBlueprint = {
      entities: [{ name: "占位实体", kind: "mock" }],
      relations: [],
      gaps: [{ question: "（Mock）待澄清项", priority: "low" }],
    };
    const mockArch = "（Mock）架构师：并行轨 A。";
    const mockMech = "（Mock）机制师：并行轨 B。";
    const mockChar = "（Mock）人物卡设计师：并行轨 C。";

    const mockCanonical: CanonicalWorld = {
      meta: {
        title: input.worldName,
        note: "Mock：WF-3 未跑真实 LangGraph；关闭 CW_CHAT_MOCK 后重试。",
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
        profile: "wf3",
        steps: [
          { id: "parse_summary", ok: true, summary: mockSummary },
          {
            id: "graph_blueprint",
            ok: true,
            entityCount: 1,
            relationCount: 0,
            gapCount: 1,
          },
          { id: "architect_a2a", ok: true, excerpt: mockArch },
          {
            id: "mechanist_a2a",
            ok: true,
            excerpt: mockMech,
            note: "Mock 并行",
          },
          {
            id: "character_designer_a2a",
            ok: true,
            excerpt: mockChar,
            note: "Mock 并行",
          },
          {
            id: "synthesize_merge",
            ok: false,
            error: "Mock 校验失败。",
            errors: v.errors,
          },
        ],
        error: "Mock 校验失败。",
        errors: v.errors,
      };
    }

    return {
      ok: true,
      mock: true,
      profile: "wf3",
      steps: [
        { id: "parse_summary", ok: true, summary: mockSummary },
        {
          id: "graph_blueprint",
          ok: true,
          entityCount: 1,
          relationCount: 0,
          gapCount: 1,
        },
        { id: "architect_a2a", ok: true, excerpt: mockArch },
        {
          id: "mechanist_a2a",
          ok: true,
          excerpt: mockMech,
          note: "Mock 并行",
        },
        {
          id: "character_designer_a2a",
          ok: true,
          excerpt: mockChar,
          note: "Mock 并行",
        },
        {
          id: "synthesize_merge",
          ok: true,
          note: "Mock：占位合成。",
        },
        { id: "review", ok: true, attempt: 1, passed: true },
      ],
      validated: v,
      normalizedJson: v.normalizedJson,
      reviewRoundsUsed: 1,
      graphBlueprint: mockGraph,
    };
  }

  try {
    getLanguageModelForProvider(input.provider, input.modelId);
  } catch (e) {
    return {
      ok: false,
      profile: "wf3",
      steps: [],
      error: e instanceof Error ? e.message : "模型不可用。",
    };
  }

  const latestBlock = wfBuildLatestCanonicalBlock(
    input.currentCanonicalJson,
    input.mergeWithLatest
  );

  return invokeWorldForgeUnifiedLangGraph({
    profile: "wf3",
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
