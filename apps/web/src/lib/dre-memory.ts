import "server-only";

import { randomUUID } from "node:crypto";
import { generateObject, zodSchema } from "ai";
import * as z from "zod";
import { getDreMemoryMaxConflicts, getDreMemoryMaxEntries } from "@/lib/dynamic-rp-config";
import type { DynamicRpActionBundle } from "@/lib/dynamic-rp-engine";
import { getLanguageModelForProvider } from "@/lib/llm";

export type DreMemoryEntry = {
  id: string;
  summary: string;
  at: string;
  /** 可选：来自哪一拍动作线 */
  beatId?: string;
};

export type DreMemoryConflict = {
  id: string;
  at: string;
  /** 与既有条目矛盾说明 */
  note: string;
  severity: "low" | "high";
  existingSummary: string;
  newSummary: string;
};

export type DreMemoryState = {
  entries: DreMemoryEntry[];
  conflicts: DreMemoryConflict[];
};

function isDreMemoryEntry(x: unknown): x is DreMemoryEntry {
  if (!x || typeof x !== "object" || Array.isArray(x)) return false;
  const o = x as Record<string, unknown>;
  return (
    typeof o.id === "string" &&
    typeof o.summary === "string" &&
    typeof o.at === "string"
  );
}

function isDreMemoryConflict(x: unknown): x is DreMemoryConflict {
  if (!x || typeof x !== "object" || Array.isArray(x)) return false;
  const o = x as Record<string, unknown>;
  return (
    typeof o.id === "string" &&
    typeof o.note === "string" &&
    (o.severity === "low" || o.severity === "high") &&
    typeof o.existingSummary === "string" &&
    typeof o.newSummary === "string"
  );
}

/** 从 `threads.session_state_json.dreMemory` 解析。 */
export function parseDreMemoryFromSessionState(
  state: Record<string, unknown>
): DreMemoryState {
  const raw = state.dreMemory;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { entries: [], conflicts: [] };
  }
  const o = raw as Record<string, unknown>;
  const entries = Array.isArray(o.entries)
    ? o.entries.filter(isDreMemoryEntry)
    : [];
  const conflicts = Array.isArray(o.conflicts)
    ? o.conflicts.filter(isDreMemoryConflict)
    : [];
  return { entries, conflicts };
}

const ExtractSchema = z.object({
  new_facts: z
    .array(
      z.object({
        summary: z.string().max(220),
      })
    )
    .max(5),
  conflicts: z
    .array(
      z.object({
        existing_line_1based: z.number().int().min(1).max(60),
        new_fact_summary: z.string().max(220),
        note: z.string().max(200),
        severity: z.enum(["low", "high"]),
      })
    )
    .max(5),
});

function formatExistingForPrompt(entries: DreMemoryEntry[]): string {
  if (entries.length === 0) return "（尚无）";
  return entries
    .map((e, i) => `${i + 1}. ${e.summary}`)
    .join("\n");
}

/**
 * 动作线之后：从本拍推演中抽取可延续事实，并与既有列表比对矛盾（不静默覆盖，只记账）。
 */
export async function runDreMemoryExtraction(input: {
  userLine: string;
  bundle: DynamicRpActionBundle;
  prior: DreMemoryState;
  provider: string;
  modelId: string;
}): Promise<{
  next: DreMemoryState;
  directorAppend: string;
  stats: { addedFacts: number; newConflicts: number };
}> {
  const maxE = getDreMemoryMaxEntries();
  const maxC = getDreMemoryMaxConflicts();
  const model = getLanguageModelForProvider(input.provider, input.modelId);
  const beatId = input.bundle.dreBeatId;
  const nEntriesBefore = input.prior.entries.length;
  const nConflictsBefore = input.prior.conflicts.length;

  const existingBlock = formatExistingForPrompt(input.prior.entries);
  const npcLine = input.bundle.npcBeats
    .map((n) => `${n.name}：${n.beat.intent_line}`)
    .join("\n");

  let extracted: z.infer<typeof ExtractSchema>;
  try {
    const r = await generateObject({
      model,
      schema: zodSchema(ExtractSchema),
      prompt: `你是 TRPG 会话「工作记忆」管理员。根据本拍动作推演，更新事实清单。

【既有工作记忆（行号 1 起，勿重复语义）】
${existingBlock}

【本拍】
玩家行动：${input.userLine.trim().slice(0, 1200)}
环境摘要：${input.bundle.environment.event_summary}
场面变化：${input.bundle.environment.state_delta.join("；")}
NPC 协调纪要：${input.bundle.a2a_summary}
各 NPC 意图：${npcLine.slice(0, 2000)}

规则：
- new_facts：仅追加**尚未出现在既有列表中**的硬事实（地点/人物关系/已发生事件）；若无则空数组。
- conflicts：仅当**新事实与既有某一行在逻辑上互斥**时填写（例如「店主已死」vs 后文「店主招呼客人」）；existing_line_1based 指向矛盾的那一行号；note 简短说明；severity：high=直接互斥，low=可能误解。
- 不要编造玩家未触发的结果。`,
      maxOutputTokens: 500,
    });
    extracted = r.object;
  } catch {
    return {
      next: input.prior,
      directorAppend: formatDreMemoryDirectorAppend(input.prior),
      stats: { addedFacts: 0, newConflicts: 0 },
    };
  }

  const now = new Date().toISOString();
  let entries = [...input.prior.entries];
  let conflicts = [...input.prior.conflicts];

  for (const f of extracted.new_facts) {
    const s = f.summary.trim();
    if (!s) continue;
    entries.push({
      id: randomUUID(),
      summary: s.slice(0, 280),
      at: now,
      beatId,
    });
  }

  for (const c of extracted.conflicts) {
    const idx = Math.floor(c.existing_line_1based) - 1;
    if (idx < 0 || idx >= input.prior.entries.length) continue;
    const existing = input.prior.entries[idx];
    if (!existing) continue;
    conflicts.push({
      id: randomUUID(),
      at: now,
      note: c.note.trim().slice(0, 240),
      severity: c.severity,
      existingSummary: existing.summary,
      newSummary: c.new_fact_summary.trim().slice(0, 280),
    });
  }

  if (entries.length > maxE) {
    entries = entries.slice(-maxE);
  }
  if (conflicts.length > maxC) {
    conflicts = conflicts.slice(-maxC);
  }

  const next: DreMemoryState = { entries, conflicts };
  return {
    next,
    directorAppend: formatDreMemoryDirectorAppend(next),
    stats: {
      addedFacts: Math.max(0, entries.length - nEntriesBefore),
      newConflicts: Math.max(0, conflicts.length - nConflictsBefore),
    },
  };
}

/** 供导演 / 对话线 system 追加；无内容时返回空串。 */
export function formatDreMemoryDirectorAppend(state: DreMemoryState): string {
  const parts: string[] = [];
  if (state.entries.length > 0) {
    const lines = state.entries
      .slice(-16)
      .map((e) => `· ${e.summary}`)
      .join("\n");
    parts.push(`【工作记忆 · 已记录事实（最近若干条）】\n${lines}`);
  }
  const open = state.conflicts.filter((c) => c.severity === "high");
  const soft = state.conflicts.filter((c) => c.severity === "low");
  if (open.length > 0) {
    parts.push(
      `【工作记忆 · 未调和冲突（高）】\n${open
        .slice(-6)
        .map(
          (c) =>
            `· 既有「${c.existingSummary.slice(0, 80)}${c.existingSummary.length > 80 ? "…" : ""}」 vs 新主张「${c.newSummary.slice(0, 80)}${c.newSummary.length > 80 ? "…" : ""}」：${c.note}`
        )
        .join("\n")}\n叙事可体现张力、歧义或 NPC 分歧，勿擅自删改玩家既定事实。`
    );
  }
  if (soft.length > 0 && open.length === 0) {
    parts.push(
      `【工作记忆 · 轻度张力】\n${soft
        .slice(-4)
        .map((c) => `· ${c.note}`)
        .join("\n")}`
    );
  }
  if (parts.length === 0) return "";
  return parts.join("\n\n");
}

export function dreMemoryToPatchObject(state: DreMemoryState): Record<string, unknown> {
  return {
    entries: state.entries,
    conflicts: state.conflicts,
  };
}
