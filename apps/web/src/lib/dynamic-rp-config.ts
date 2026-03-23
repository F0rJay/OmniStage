import "server-only";

/** 为 true 时酒馆 `/api/chat` 走动态扮演引擎（意图分流 + 动作线多 Agent）。 */
export function isDynamicRpEngineEnabled(): boolean {
  const v = process.env.CW_DYNAMIC_RP_ENGINE?.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

/** LLM 意图分类模式（DRE-1）。需同时开启 {@link isDynamicRpEngineEnabled}。 */
export type DreIntentLlmMode = "off" | "hybrid" | "full";

/**
 * `CW_DRE_INTENT_LLM`：
 * - 未设 / 0 / false / off → off（仅规则）
 * - 1 / true / yes / hybrid → hybrid（规则优先，仅 `default_dialogue` 时再问模型）
 * - full / always / all → 每轮都走模型分类
 */
export function getDreIntentLlmMode(): DreIntentLlmMode {
  const raw = process.env.CW_DRE_INTENT_LLM?.trim().toLowerCase();
  if (!raw || raw === "0" || raw === "false" || raw === "off" || raw === "no") {
    return "off";
  }
  if (raw === "full" || raw === "always" || raw === "all") {
    return "full";
  }
  return "hybrid";
}

/**
 * NPC 后台「同时广播」轮数（DRE-2）。1 = 与 DRE-0/1 相同（一轮并行 + 协调摘要）；2~4 = 多轮 A2A 总线后再摘要。
 */
export function getDreA2aInteractionRounds(): number {
  const raw = process.env.CW_DRE_A2A_ROUNDS?.trim();
  const n = raw ? parseInt(raw, 10) : 1;
  if (!Number.isFinite(n) || n < 1) return 1;
  if (n > 4) return 4;
  return n;
}

/** 若设置，则将本拍 A2A 消息镜像到 Redis，并读写跨回合上下文（多实例可共享）。 */
export function getDreA2aRedisUrl(): string | null {
  const u = process.env.CW_DRE_A2A_REDIS_URL?.trim();
  return u || null;
}

/** DRE-3：动作线后抽取会话工作记忆并检测与既有事实的冲突。 */
export function isDreMemoryEnabled(): boolean {
  const v = process.env.CW_DRE_MEMORY?.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

export function getDreMemoryMaxEntries(): number {
  const raw = process.env.CW_DRE_MEMORY_MAX_ENTRIES?.trim();
  const n = raw ? parseInt(raw, 10) : 28;
  if (!Number.isFinite(n) || n < 4) return 28;
  if (n > 80) return 80;
  return n;
}

export function getDreMemoryMaxConflicts(): number {
  const raw = process.env.CW_DRE_MEMORY_MAX_CONFLICTS?.trim();
  const n = raw ? parseInt(raw, 10) : 20;
  if (!Number.isFinite(n) || n < 2) return 20;
  if (n > 60) return 60;
  return n;
}

/** DRE-4：从绑定世界 Canonical 抽取实体目录并注入本回合锚点（需会话已绑定 world_version）。 */
export function isDreWorldEntityAnchorsEnabled(): boolean {
  const v = process.env.CW_DRE_WORLD_ENTITIES?.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

/** 解析实体目录时最多扫描条数（防止极大 JSON）。 */
export function getDreWorldEntityCatalogMax(): number {
  const raw = process.env.CW_DRE_WORLD_ENTITY_CATALOG_MAX?.trim();
  const n = raw ? parseInt(raw, 10) : 150;
  if (!Number.isFinite(n) || n < 10) return 150;
  if (n > 400) return 400;
  return n;
}

/** 本回合写入提示的实体锚点数量上限。 */
export function getDreWorldEntityPickMax(): number {
  const raw = process.env.CW_DRE_WORLD_ENTITY_PICK_MAX?.trim();
  const n = raw ? parseInt(raw, 10) : 10;
  if (!Number.isFinite(n) || n < 1) return 10;
  if (n > 24) return 24;
  return n;
}

/**
 * 在启发式候选之上，再用模型从编号列表里挑选相关实体（仅可选用表中 ID）。
 */
export function isDreWorldEntityLlmPickEnabled(): boolean {
  const v = process.env.CW_DRE_ENTITY_LLM?.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

/**
 * 严格群像格式开关：
 * - 默认开启（true），确保角色段尽量落为「[角色名] + 【角色名】 + 正文」。
 * - 仅在显式设置为 0/false/no/off 时关闭。
 */
export function isDreStrictGroupFormatEnabled(): boolean {
  const v = process.env.CW_DRE_STRICT_GROUP_FORMAT?.trim().toLowerCase();
  if (!v) return true;
  return !(v === "0" || v === "false" || v === "no" || v === "off");
}
