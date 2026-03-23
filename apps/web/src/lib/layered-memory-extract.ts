import "server-only";

import { generateObject, zodSchema } from "ai";
import * as z from "zod";
import type { DynamicRpActionBundle } from "@/lib/dynamic-rp-engine";
import { getLanguageModelForProvider } from "@/lib/llm";
import {
  getLayeredMemoryMaxPrivatePerNpc,
} from "@/lib/layered-memory-config";
import {
  mergePrivateEntries,
  mergeSupervisorPatchIntoShared,
  privateMemoryKeyForNpc,
  type LayeredPrivateMemoryMap,
  type SharedMemoryState,
} from "@/lib/layered-memory";

const SupervisorSchema = z.object({
  goal_ops: z
    .array(
      z.object({
        op: z.enum(["add", "update", "remove"]),
        id: z.string().max(36),
        text: z.string().max(200).optional(),
        status: z.enum(["active", "done", "dropped"]).optional(),
      })
    )
    .max(8),
  world_state_summary: z.string().max(450).nullable(),
  user_preferences_notes: z.string().max(350).nullable(),
  supervisor_notes_append: z.string().max(400).nullable(),
  private_memory: z
    .array(
      z.object({
        npc_name: z.string().max(64),
        entries: z
          .array(z.object({ summary: z.string().max(220) }))
          .max(4),
      })
    )
    .max(6),
  insight_candidates: z
    .array(
      z.object({
        summary: z.string().max(340),
        scope: z.enum(["world", "user", "session"]),
      })
    )
    .max(3),
});

function formatBundleForPrompt(bundle: DynamicRpActionBundle): string {
  const npc = bundle.npcBeats
    .map((n) => `${n.name}：${n.beat.intent_line}`)
    .join("\n");
  return (
    `环境：${bundle.environment.event_summary}\n` +
    `场面变化：${bundle.environment.state_delta.join("；")}\n` +
    `风险：${bundle.environment.risk_level}\n` +
    `A2A 纪要：${bundle.a2a_summary}\n` +
    `NPC 意图：\n${npc}`
  );
}

/**
 * 监督者（导演侧结构化抽取）：更新共享池、各 NPC 私域候选、洞察候选。
 * 实际写入洞察表由路由在落库后调用 insertInsight。
 */
export async function runLayeredMemorySupervisorExtract(input: {
  userLine: string;
  /** 动作线 bundle；对话线可传 null（仅用用户句 + 上文摘要） */
  bundle: DynamicRpActionBundle | null;
  lastAssistantSnippet: string | null;
  priorShared: SharedMemoryState;
  priorPrivate: LayeredPrivateMemoryMap;
  activeNpcs: string[];
  beatId?: string;
  provider: string;
  modelId: string;
}): Promise<{
  nextShared: SharedMemoryState;
  nextPrivate: LayeredPrivateMemoryMap;
  insightCandidates: Array<{
    summary: string;
    scope: "world" | "user" | "session";
  }>;
}> {
  const model = getLanguageModelForProvider(input.provider, input.modelId);
  const npcList = input.activeNpcs.map((n) => n.trim()).filter(Boolean).slice(0, 6);
  const npcCsv = npcList.join("、");

  const beatBlock = input.bundle
    ? formatBundleForPrompt(input.bundle)
    : "（本回合为对话线：无动作线环境/NPC 分拍，仅根据用户句与上文更新记忆。）";

  const priorSharedJson = JSON.stringify(
    {
      goals: input.priorShared.goals,
      worldStateSummary: input.priorShared.worldStateSummary,
      userPreferences: input.priorShared.userPreferences,
    },
    null,
    0
  );

  const priorPrivateBrief: Record<string, string[]> = {};
  const maxP = getLayeredMemoryMaxPrivatePerNpc();
  for (const name of npcList) {
    const key = privateMemoryKeyForNpc(name);
    const ent = input.priorPrivate[key]?.entries ?? [];
    priorPrivateBrief[key] = ent.slice(-4).map((e) => e.summary);
  }

  const prevTail = input.lastAssistantSnippet
    ? input.lastAssistantSnippet.slice(-1200)
    : "（无）";

  try {
    const r = await generateObject({
      model,
      schema: zodSchema(SupervisorSchema),
      prompt: `你是 CanonWeave「监督者 Agent」：维护**共享记忆池**（全员一致可见）与各 NPC **私有记忆**（仅该角色后台），并产出可写入**全局洞察层**的候选条。
规则：
1) goal_ops：只调整任务/阶段目标 id 要稳定简短（如 g1、g2）；add 需带 text；remove 删除；update 可改 text/status。
2) world_state_summary：若需更新共享「世界状态摘要」则给完整新文本，否则 null（表示保持原摘要不变）。
3) user_preferences_notes：仅当本拍发现**新的**用户偏好/禁忌时，给一句短笔记（会追加到共享池）；否则 null。
4) supervisor_notes_append：监督者协调说明一句，可 null。
5) private_memory：**仅**为下列 NPC 名称之一写私域条目，npc_name 必须与列表完全一致：${npcCsv || "（无）"}
   私域只收「该角色内心所知、秘密、个人史碎片」，勿写公共事实（公共事实进共享池或 insight）。
6) insight_candidates：可推广的**规律/协作经验**（最多 3 条）；scope: world=绑定世界时写入世界洞察；user=用户跨会话；session=仅本会话。不要重复显而易见的世界书原文。

【当前共享池摘要 JSON】
${priorSharedJson}

【各 NPC 私域近期摘要（键为 npc:名称）】
${JSON.stringify(priorPrivateBrief)}

【本拍上下文】
玩家：${input.userLine}

${beatBlock}

【最近叙事尾部】
${prevTail}

输出严格符合 schema。若无变更，goal_ops 可为空数组、各 nullable 填 null、insight_candidates 可为空。`,
      maxOutputTokens: 1200,
    });

    const o = r.object;
    let nextShared = mergeSupervisorPatchIntoShared(input.priorShared, {
      goal_ops: o.goal_ops,
      world_state_summary: o.world_state_summary,
      user_preferences_notes: o.user_preferences_notes,
      supervisor_notes_append: o.supervisor_notes_append,
    });

    let nextPrivate: LayeredPrivateMemoryMap = { ...input.priorPrivate };
    const allowed = new Set(npcList);
    for (const row of o.private_memory) {
      const name = row.npc_name.trim();
      if (!allowed.has(name)) continue;
      const sums = row.entries.map((e) => e.summary);
      if (sums.length === 0) continue;
      nextPrivate = mergePrivateEntries(
        nextPrivate,
        name,
        sums,
        input.beatId,
        maxP
      );
    }

    const insightCandidates = o.insight_candidates
      .filter((x) => x.summary.trim().length > 0)
      .map((x) => ({
        summary: x.summary.trim(),
        scope: x.scope,
      }));

    return { nextShared, nextPrivate, insightCandidates };
  } catch {
    return {
      nextShared: input.priorShared,
      nextPrivate: input.priorPrivate,
      insightCandidates: [],
    };
  }
}
