import "server-only";

import type { CanonicalWorld, ValidateResult } from "@/lib/canonical-world";
import { parseAndValidateCanonicalWorld } from "@/lib/canonical-world";
import { getLanguageModelForProvider } from "@/lib/llm";
import { invokeWorldForgeUnifiedLangGraph } from "@/lib/world-forge-langgraph-unified";
import { wfBuildLatestCanonicalBlock, WF_MAX_BRIEF_BYTES } from "@/lib/world-forge-shared";

export type Wf0StepId = "parse_summary" | "expand_canonical";

export type Wf0StepRecord =
  | {
      id: Wf0StepId;
      ok: true;
      summary?: string;
      note?: string;
      /** 统一 LangGraph 扩写节点会带上轮次 */
      attempt?: number;
    }
  | {
      id: Wf0StepId;
      ok: false;
      error: string;
      errors?: string[];
      attempt?: number;
    };

export type Wf0PipelineSuccess = {
  ok: true;
  mock?: boolean;
  steps: Wf0StepRecord[];
  validated: Extract<ValidateResult, { ok: true }>;
  normalizedJson: string;
};

export type Wf0PipelineFailure = {
  ok: false;
  mock?: boolean;
  steps: Wf0StepRecord[];
  error: string;
  errors?: string[];
};

export type Wf0PipelineResult = Wf0PipelineSuccess | Wf0PipelineFailure;

/**
 * WorldForge **WF-0 编排壳**：显式两节点流水线（无并行、无审查 Agent）。
 */
export async function runWorldForgeWf0Pipeline(input: {
  worldName: string;
  rawBrief: string;
  provider: string;
  modelId: string;
  mergeWithLatest: boolean;
  currentCanonicalJson: string | null;
  useMock: boolean;
}): Promise<Wf0PipelineResult> {
  const steps: Wf0StepRecord[] = [];
  const brief = input.rawBrief.trim();
  if (!brief) {
    return { ok: false, steps, error: "大纲/素材为空。" };
  }

  const enc = new TextEncoder();
  if (enc.encode(brief).length > WF_MAX_BRIEF_BYTES) {
    return {
      ok: false,
      steps,
      error: `大纲过长（上限 ${WF_MAX_BRIEF_BYTES} 字节），请精简或拆分。`,
    };
  }

  if (input.useMock) {
    const mockSummary =
      "（Mock / CW_CHAT_MOCK=1）占位解析摘要：请关闭 Mock 后使用真实模型运行完整 WF-0。\n\n" +
      `- 用户大纲长度：${brief.length} 字符\n` +
      "- 设定空白：未执行真实解析。";

    const mockCanonical: CanonicalWorld = {
      meta: {
        title: input.worldName,
        note: "Mock：WorldForge WF-0 未调用模型；关闭 CW_CHAT_MOCK 后重试以获得真实扩写。",
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
      const parsed = parseAndValidateCanonicalWorld(input.currentCanonicalJson);
      if (parsed.ok) {
        mockCanonical.meta = {
          ...parsed.canonical.meta,
          ...mockCanonical.meta,
        };
        mockCanonical.entities = parsed.canonical.entities;
        mockCanonical.relations = parsed.canonical.relations;
        mockCanonical.rules = parsed.canonical.rules;
        mockCanonical.timeline = parsed.canonical.timeline;
        mockCanonical.lore_entries = parsed.canonical.lore_entries;
        mockCanonical.locks = parsed.canonical.locks;
        mockCanonical.warnings = parsed.canonical.warnings;
        if (parsed.canonical.world_book !== undefined) {
          mockCanonical.world_book = parsed.canonical.world_book;
        }
        if (parsed.canonical.character_books !== undefined) {
          mockCanonical.character_books = parsed.canonical.character_books;
        }
      }
    }

    const v = parseAndValidateCanonicalWorld(JSON.stringify(mockCanonical));
    if (!v.ok) {
      return {
        ok: false,
        mock: true,
        steps: [
          { id: "parse_summary", ok: true, summary: mockSummary },
          {
            id: "expand_canonical",
            ok: false,
            error: "Mock 扩写校验失败。",
            errors: v.errors,
          },
        ],
        error: "Mock 扩写校验失败。",
        errors: v.errors,
      };
    }

    steps.push({ id: "parse_summary", ok: true, summary: mockSummary });
    steps.push({
      id: "expand_canonical",
      ok: true,
      note: "Mock：已生成占位 Canonical。",
    });

    return {
      ok: true,
      mock: true,
      steps,
      validated: v,
      normalizedJson: v.normalizedJson,
    };
  }

  try {
    getLanguageModelForProvider(input.provider, input.modelId);
  } catch (e) {
    return {
      ok: false,
      steps,
      error: e instanceof Error ? e.message : "模型不可用。",
    };
  }

  const latestBlock = wfBuildLatestCanonicalBlock(
    input.currentCanonicalJson,
    input.mergeWithLatest
  );

  const r = await invokeWorldForgeUnifiedLangGraph({
    profile: "wf0",
    worldName: input.worldName,
    brief,
    latestBlock,
    maxReviewRounds: 1,
    withLastDraftOnFail: false,
    mergeWithLatest: input.mergeWithLatest,
    provider: input.provider,
    modelId: input.modelId,
  });

  if (!r.ok) {
    return {
      ok: false,
      steps: r.steps as Wf0StepRecord[],
      error: r.error,
      errors: r.errors,
      mock: r.mock,
    };
  }

  return {
    ok: true,
    steps: r.steps as Wf0StepRecord[],
    validated: r.validated,
    normalizedJson: r.normalizedJson,
  };
}
