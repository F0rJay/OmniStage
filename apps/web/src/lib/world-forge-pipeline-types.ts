import type { ValidateResult } from "@/lib/canonical-world";
import type { WorldForgeGraphBlueprint } from "@/lib/world-forge-graph-blueprint";

/** 单一 LangGraph 工作流档位：协作深度递增 */
export type WorldForgeProfile = "wf0" | "wf1" | "wf2" | "wf3";
export type WorldForgeIncrementTarget =
  | "none"
  | "character"
  | "location"
  | "organization";

/** 全流水线步骤（WF-0～WF-3 共用，按 profile 实际出现的节点不同） */
export type WorldForgeStepRecord =
  | {
      id: "parse_summary";
      ok: true;
      summary?: string;
    }
  | {
      id: "parse_summary";
      ok: false;
      error: string;
    }
  | {
      id: "graph_blueprint";
      ok: true;
      entityCount?: number;
      relationCount?: number;
      gapCount?: number;
    }
  | {
      id: "graph_blueprint";
      ok: false;
      error: string;
    }
  | {
      id: "expand_canonical";
      ok: true;
      attempt: number;
      note?: string;
    }
  | {
      id: "expand_canonical";
      ok: false;
      attempt: number;
      error: string;
      errors?: string[];
    }
  | {
      id: "architect_a2a";
      ok: true;
      excerpt?: string;
    }
  | {
      id: "architect_a2a";
      ok: false;
      error: string;
    }
  | {
      id: "mechanist_a2a";
      ok: true;
      excerpt?: string;
      /** 并行轨时提示与架构师无先后读稿 */
      note?: string;
    }
  | {
      id: "mechanist_a2a";
      ok: false;
      error: string;
    }
  | {
      id: "character_designer_a2a";
      ok: true;
      excerpt?: string;
      note?: string;
    }
  | {
      id: "character_designer_a2a";
      ok: false;
      error: string;
    }
  | {
      id: "synthesize_merge";
      ok: true;
      note?: string;
    }
  | {
      id: "synthesize_merge";
      ok: false;
      error: string;
      errors?: string[];
    }
  | {
      id: "review";
      ok: true;
      attempt: number;
      passed: boolean;
      issues?: string[];
      rewriteHints?: string;
      /** 如：已达最大轮次仍采纳当前稿 */
      note?: string;
    }
  | {
      id: "review";
      ok: false;
      attempt: number;
      error: string;
    };

export type WorldForgeStepId = WorldForgeStepRecord["id"];
/** @deprecated 使用 WorldForgeStepId */
export type Wf1StepId = WorldForgeStepId;

export type WorldForgePipelineSuccess = {
  ok: true;
  mock?: boolean;
  profile: WorldForgeProfile;
  steps: WorldForgeStepRecord[];
  validated: Extract<ValidateResult, { ok: true }>;
  normalizedJson: string;
  /** wf0 无审查循环时视为 1（仅一次扩写/合成） */
  reviewRoundsUsed: number;
  /** WF-3：解析员输出的实体/关系/缺口蓝图（供 UI 与审计） */
  graphBlueprint?: WorldForgeGraphBlueprint;
  /**
   * 审查在达到最大轮次时仍「最佳努力」采纳当前稿时，列出残余问题（不影响 ok:true，建议用户后续打补丁）。
   */
  reviewWarnings?: string[];
};

export type WorldForgePipelineFailure = {
  ok: false;
  mock?: boolean;
  profile: WorldForgeProfile;
  steps: WorldForgeStepRecord[];
  error: string;
  errors?: string[];
  lastNormalizedJson?: string;
  lastReviewIssues?: string[];
};

export type WorldForgePipelineResult =
  | WorldForgePipelineSuccess
  | WorldForgePipelineFailure;

/** @deprecated 使用 WorldForgeStepRecord */
export type Wf1StepRecord = WorldForgeStepRecord;
/** @deprecated 使用 WorldForgePipelineSuccess */
export type Wf1PipelineSuccess = WorldForgePipelineSuccess;
/** @deprecated 使用 WorldForgePipelineFailure */
export type Wf1PipelineFailure = WorldForgePipelineFailure;
/** @deprecated 使用 WorldForgePipelineResult */
export type Wf1PipelineResult = WorldForgePipelineResult;
