/**
 * WorldForge 审查–修订循环配置（纯常量，客户端与 API 均可 import）。
 * 复杂设定若多轮仍无法通过，应优先按审查意见改大纲/rules，再提高轮次或手动修 JSON。
 */

export const WORLD_FORGE_DEFAULT_MAX_REVIEW_ROUNDS = 3;
export const WORLD_FORGE_MIN_REVIEW_ROUNDS = 1;
/** 硬上限：防止单次请求时间与费用失控；需要更多时请分次运行或人工合并 */
export const WORLD_FORGE_MAX_REVIEW_ROUNDS_CAP = 10;

export function clampWorldForgeReviewRounds(n: number | undefined): number {
  const v =
    n === undefined || !Number.isFinite(n)
      ? WORLD_FORGE_DEFAULT_MAX_REVIEW_ROUNDS
      : Math.floor(n);
  return Math.min(
    WORLD_FORGE_MAX_REVIEW_ROUNDS_CAP,
    Math.max(WORLD_FORGE_MIN_REVIEW_ROUNDS, v)
  );
}
