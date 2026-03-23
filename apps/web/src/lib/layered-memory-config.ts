import "server-only";

/** 分层记忆：共享池 + 私域 + 洞察层（见 docs/layered-memory.md） */
export function isLayeredMemoryEnabled(): boolean {
  const v = process.env.CW_LAYERED_MEMORY?.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

/** 对话线也跑监督者抽取（多一次模型调用，默认关） */
export function isLayeredMemoryDialogueExtractEnabled(): boolean {
  const v = process.env.CW_LAYERED_MEMORY_DIALOGUE_EXTRACT?.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

export function getLayeredMemoryMaxGoals(): number {
  const raw = process.env.CW_LAYERED_MEMORY_MAX_GOALS?.trim();
  const n = raw ? parseInt(raw, 10) : 8;
  if (!Number.isFinite(n) || n < 2) return 8;
  if (n > 16) return 16;
  return n;
}

export function getLayeredMemoryMaxPrivatePerNpc(): number {
  const raw = process.env.CW_LAYERED_MEMORY_MAX_PRIVATE?.trim();
  const n = raw ? parseInt(raw, 10) : 14;
  if (!Number.isFinite(n) || n < 4) return 14;
  if (n > 40) return 40;
  return n;
}

export function getLayeredMemoryInsightInjectLimit(): number {
  const raw = process.env.CW_LAYERED_MEMORY_INSIGHT_LIMIT?.trim();
  const n = raw ? parseInt(raw, 10) : 10;
  if (!Number.isFinite(n) || n < 1) return 10;
  if (n > 24) return 24;
  return n;
}
