import "server-only";

import { randomUUID } from "node:crypto";
import type { InsightRow } from "@/lib/db";
import {
  getLayeredMemoryInsightInjectLimit,
  getLayeredMemoryMaxGoals,
  getLayeredMemoryMaxPrivatePerNpc,
} from "@/lib/layered-memory-config";

export type SharedGoal = {
  id: string;
  text: string;
  status: "active" | "done" | "dropped";
};

export type SharedMemoryState = {
  version: number;
  updatedAt: string;
  goals: SharedGoal[];
  worldStateSummary: string;
  userPreferences: string;
  supervisorNotes: string;
};

export type PrivateMemoryEntry = {
  id: string;
  summary: string;
  at: string;
  beatId?: string;
};

export type PrivateMemoryBucket = {
  entries: PrivateMemoryEntry[];
};

export type LayeredPrivateMemoryMap = Record<string, PrivateMemoryBucket>;

const EMPTY_SHARED: SharedMemoryState = {
  version: 1,
  updatedAt: new Date().toISOString(),
  goals: [],
  worldStateSummary: "",
  userPreferences: "",
  supervisorNotes: "",
};

function isSharedGoal(x: unknown): x is SharedGoal {
  if (!x || typeof x !== "object" || Array.isArray(x)) return false;
  const o = x as Record<string, unknown>;
  return (
    typeof o.id === "string" &&
    typeof o.text === "string" &&
    (o.status === "active" || o.status === "done" || o.status === "dropped")
  );
}

function isPrivateEntry(x: unknown): x is PrivateMemoryEntry {
  if (!x || typeof x !== "object" || Array.isArray(x)) return false;
  const o = x as Record<string, unknown>;
  return (
    typeof o.id === "string" &&
    typeof o.summary === "string" &&
    typeof o.at === "string"
  );
}

export function privateMemoryKeyForNpc(npcName: string): string {
  const n = npcName.trim().slice(0, 64);
  return `npc:${n.length > 0 ? n : "unknown"}`;
}

export function parseSharedMemoryFromSessionState(
  state: Record<string, unknown>
): SharedMemoryState {
  const raw = state.sharedMemory;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ...EMPTY_SHARED, updatedAt: new Date().toISOString() };
  }
  const o = raw as Record<string, unknown>;
  const goals = Array.isArray(o.goals)
    ? o.goals.filter(isSharedGoal).slice(0, getLayeredMemoryMaxGoals())
    : [];
  return {
    version: typeof o.version === "number" ? o.version : 1,
    updatedAt: typeof o.updatedAt === "string" ? o.updatedAt : new Date().toISOString(),
    goals,
    worldStateSummary:
      typeof o.worldStateSummary === "string" ? o.worldStateSummary : "",
    userPreferences:
      typeof o.userPreferences === "string" ? o.userPreferences : "",
    supervisorNotes:
      typeof o.supervisorNotes === "string" ? o.supervisorNotes : "",
  };
}

export function parsePrivateMemoryFromSessionState(
  state: Record<string, unknown>
): LayeredPrivateMemoryMap {
  const raw = state.privateMemory;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: LayeredPrivateMemoryMap = {};
  const maxE = getLayeredMemoryMaxPrivatePerNpc();
  for (const [k, v] of Object.entries(raw)) {
    if (k.length > 96 || k === "__proto__" || k === "constructor") continue;
    if (!v || typeof v !== "object" || Array.isArray(v)) continue;
    const ent = (v as Record<string, unknown>).entries;
    const entries = Array.isArray(ent)
      ? ent.filter(isPrivateEntry).slice(-maxE)
      : [];
    if (entries.length > 0) out[k] = { entries };
  }
  return out;
}

export function sharedMemoryToPatchObject(s: SharedMemoryState): Record<string, unknown> {
  return { ...s };
}

export function privateMemoryToPatchObject(m: LayeredPrivateMemoryMap): Record<string, unknown> {
  return { ...m };
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}…`;
}

/** 注入动作线（环境/NPC）与导演附录的纯文本块 */
export function formatLayeredMemoryContextBlock(input: {
  shared: SharedMemoryState;
  privateMap: LayeredPrivateMemoryMap;
  insightRows: InsightRow[];
  activeNpcNames: string[];
}): string | null {
  const parts: string[] = [];
  const lim = getLayeredMemoryInsightInjectLimit();

  if (input.insightRows.length > 0) {
    const lines = input.insightRows.slice(0, lim).map((r, i) => {
      const sc =
        r.scope === "world"
          ? "世界"
          : r.scope === "session"
            ? "本会话"
            : "用户";
      return `${i + 1}. [${sc}] ${truncate(r.summary, 280)}`;
    });
    parts.push(
      "【全局洞察层 · 已沉淀条目（规律/协作经验；与当前世界书冲突时以世界书为准）】\n" +
        lines.join("\n")
    );
  }

  const sh = input.shared;
  const goalLines = sh.goals
    .filter((g) => g.status === "active")
    .map((g) => `- (${g.id}) ${truncate(g.text, 180)}`);
  const sharedBits: string[] = [];
  if (goalLines.length > 0) {
    sharedBits.push("任务/目标：\n" + goalLines.join("\n"));
  }
  if (sh.worldStateSummary.trim()) {
    sharedBits.push("世界状态摘要（监督者维护）：\n" + truncate(sh.worldStateSummary.trim(), 500));
  }
  if (sh.userPreferences.trim()) {
    sharedBits.push("用户偏好（共享）：\n" + truncate(sh.userPreferences.trim(), 400));
  }
  if (sh.supervisorNotes.trim()) {
    sharedBits.push("监督者备注：\n" + truncate(sh.supervisorNotes.trim(), 450));
  }
  if (sharedBits.length > 0) {
    parts.push(
      "【共享记忆池 · 全体 Agent 可读；仅监督者/导演可写】\n" + sharedBits.join("\n\n")
    );
  }

  const privParts: string[] = [];
  for (const name of input.activeNpcNames) {
    const key = privateMemoryKeyForNpc(name);
    const bucket = input.privateMap[key];
    if (!bucket || !bucket.entries.length) continue;
    const lines = bucket.entries
      .slice(-8)
      .map((e) => `- ${truncate(e.summary, 200)}`);
    privParts.push(`「${truncate(name, 40)}」私域：\n${lines.join("\n")}`);
  }
  if (privParts.length > 0) {
    parts.push(
      "【私有记忆库 · 仅对应 NPC 后台可用；勿向玩家泄露其他角色私域】\n" +
        privParts.join("\n\n")
    );
  }

  if (parts.length === 0) return null;
  return parts.join("\n\n---\n\n");
}

export type GoalOp = {
  op: "add" | "update" | "remove";
  id: string;
  text?: string;
  status?: "active" | "done" | "dropped";
};

export function applyGoalOps(
  prior: SharedGoal[],
  ops: GoalOp[],
  maxGoals: number
): SharedGoal[] {
  let next = [...prior];
  for (const op of ops) {
    if (op.op === "remove") {
      next = next.filter((g) => g.id !== op.id);
      continue;
    }
    if (op.op === "update") {
      const idx = next.findIndex((g) => g.id === op.id);
      if (idx >= 0) {
        const cur = next[idx]!;
        next[idx] = {
          id: op.id,
          text: op.text !== undefined ? op.text : cur.text,
          status: op.status ?? cur.status,
        };
      } else if (op.text) {
        next.push({
          id: op.id,
          text: op.text,
          status: op.status ?? "active",
        });
      }
      continue;
    }
    if (op.op === "add" && op.text) {
      if (next.some((g) => g.id === op.id)) continue;
      next.push({
        id: op.id,
        text: op.text,
        status: op.status ?? "active",
      });
    }
  }
  return next.slice(-maxGoals);
}

export function mergeSupervisorPatchIntoShared(
  prior: SharedMemoryState,
  input: {
    goal_ops: GoalOp[];
    world_state_summary?: string | null;
    user_preferences_notes?: string | null;
    supervisor_notes_append?: string | null;
  }
): SharedMemoryState {
  const maxG = getLayeredMemoryMaxGoals();
  const goals = applyGoalOps(prior.goals, input.goal_ops, maxG);
  const worldStateSummary =
    input.world_state_summary != null && input.world_state_summary.trim() !== ""
      ? input.world_state_summary.trim()
      : prior.worldStateSummary;
  let userPreferences = prior.userPreferences;
  if (input.user_preferences_notes && input.user_preferences_notes.trim()) {
    const add = input.user_preferences_notes.trim();
    userPreferences = prior.userPreferences.trim()
      ? `${prior.userPreferences.trim()}\n• ${add}`
      : `• ${add}`;
    userPreferences = truncate(userPreferences, 2400);
  }
  let supervisorNotes = prior.supervisorNotes;
  if (input.supervisor_notes_append && input.supervisor_notes_append.trim()) {
    const line = `[${new Date().toISOString()}] ${input.supervisor_notes_append.trim()}`;
    supervisorNotes = prior.supervisorNotes.trim()
      ? `${prior.supervisorNotes.trim()}\n${line}`
      : line;
    supervisorNotes = truncate(supervisorNotes, 3200);
  }
  return {
    version: 1,
    updatedAt: new Date().toISOString(),
    goals,
    worldStateSummary,
    userPreferences,
    supervisorNotes,
  };
}

export function mergePrivateEntries(
  prior: LayeredPrivateMemoryMap,
  npcName: string,
  newSummaries: string[],
  beatId: string | undefined,
  maxPerNpc: number
): LayeredPrivateMemoryMap {
  const key = privateMemoryKeyForNpc(npcName);
  const existing = prior[key]?.entries ?? [];
  const additions: PrivateMemoryEntry[] = newSummaries
    .map((s) => s.trim())
    .filter(Boolean)
    .map((summary) => ({
      id: randomUUID(),
      summary: truncate(summary, 400),
      at: new Date().toISOString(),
      ...(beatId ? { beatId } : {}),
    }));
  const merged = [...existing, ...additions].slice(-maxPerNpc);
  return { ...prior, [key]: { entries: merged } };
}
