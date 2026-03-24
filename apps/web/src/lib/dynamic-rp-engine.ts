import "server-only";

import { generateObject, generateText, zodSchema } from "ai";
import * as z from "zod";
import {
  formatA2aTranscript,
  type DreA2aMessage,
} from "@/lib/dre-a2a-bus";
import {
  loadDreA2aThreadContext,
  mirrorAppendDreA2a,
  persistDreA2aThreadContext,
} from "@/lib/dre-a2a-redis";
import {
  getDreA2aInteractionRounds,
  getDreA2aRedisUrl,
} from "@/lib/dynamic-rp-config";
import { getLanguageModelForProvider } from "@/lib/llm";

const EnvBeatSchema = z.object({
  event_summary: z.string().max(600),
  state_delta: z.array(z.string()).max(10),
  risk_level: z.enum(["low", "medium", "high"]),
});

const NpcBeatSchema = z.object({
  intent_line: z.string().max(320),
  speaks_if_any: z.string().max(160).optional(),
});

const A2ASchema = z.object({
  coordination: z.string().max(800),
});

const NpcBusReplySchema = z.object({
  line: z.string().max(360),
});

const AutoTurnPlanSchema = z.object({
  should_advance: z.boolean(),
  reason: z.string().max(280),
  npc_names: z.array(z.string().max(64)).max(4),
});

const DirectorDicePlanSchema = z.object({
  need_roll: z.boolean(),
  expression: z.string().max(24).optional(),
  reason: z.string().max(180),
});

const RoleBlockAuditSchema = z.object({
  is_valid: z.boolean(),
  reason: z.string().max(180),
  repaired_text: z.string().max(5000).optional(),
});

export type DynamicRpEnvironmentBeat = z.infer<typeof EnvBeatSchema>;

export type DynamicRpNpcBeat = z.infer<typeof NpcBeatSchema>;

export type DynamicRpActionBundle = {
  environment: DynamicRpEnvironmentBeat;
  npcBeats: Array<{ name: string; beat: DynamicRpNpcBeat }>;
  a2a_summary: string;
  /** 多轮 A2A 全文（导演摘要已含要义，此供审计/SSE） */
  a2aTranscript?: string;
  a2aRoundsUsed?: number;
  dreBeatId?: string;
};

const StructuredSpeakerBlockSchema = z.object({
  speaker: z.string().max(24),
  action: z.string().max(260).optional(),
  speech: z.string().max(520).optional(),
});

const StructuredSpeakerTurnSchema = z.object({
  blocks: z.array(StructuredSpeakerBlockSchema).min(1).max(8),
});

export type DynamicRpAutoTurnPlan = {
  shouldAdvance: boolean;
  reason: string;
  npcNames: string[];
};

export type DynamicRpAutoTurnProfile =
  | "conservative"
  | "standard"
  | "aggressive";

export type DirectorDicePlan = {
  needRoll: boolean;
  expression: string | null;
  reason: string;
};

const DEFAULT_NPCS = ["场景 NPC·甲", "场景 NPC·乙"];

export function getActiveNpcNamesFromSessionState(
  state: Record<string, unknown>
): string[] {
  const dr = state.dynamicRp;
  if (!dr || typeof dr !== "object" || Array.isArray(dr)) {
    return [...DEFAULT_NPCS];
  }
  const raw = (dr as Record<string, unknown>).activeNpcs;
  if (!Array.isArray(raw)) return [...DEFAULT_NPCS];
  const names = raw
    .filter((x): x is string => typeof x === "string" && x.trim().length > 0)
    .map((x) => x.trim().slice(0, 64));
  if (names.length === 0) return [...DEFAULT_NPCS];
  return names.slice(0, 4);
}

/** 从 `session_state_json.lastDice` 生成环境/NPC 可用的简短提示（DRE-1）。 */
export function formatLastDiceForDynamicRp(
  state: Record<string, unknown>
): string | null {
  const ld = state.lastDice;
  if (!ld || typeof ld !== "object" || Array.isArray(ld)) return null;
  const o = ld as Record<string, unknown>;
  const expr = typeof o.expression === "string" ? o.expression : "?";
  const total = o.total;
  const rolls = o.rolls;
  let rollStr = "";
  if (Array.isArray(rolls) && rolls.every((x) => typeof x === "number")) {
    rollStr = `，各骰 ${(rolls as number[]).join("+")}`;
  }
  const t =
    typeof total === "number"
      ? String(total)
      : total != null
        ? String(total)
        : "?";
  return `【本回合前最近一次掷骰】表达式 ${expr}，合计 ${t}${rollStr}（叙事可参考此结果，勿编造新骰值）`;
}

/**
 * 自动档导演前置规划：判断本拍是否应推进，以及应调用哪些 NPC。
 * 仅做「本拍调度」，不直接生成最终叙事。
 */
export async function planDynamicAutoTurn(input: {
  userLine: string;
  lastAssistantSnippet: string | null;
  worldContext: string | null;
  activeNpcs: string[];
  profile?: DynamicRpAutoTurnProfile;
  provider: string;
  modelId: string;
}): Promise<DynamicRpAutoTurnPlan> {
  const model = getLanguageModelForProvider(input.provider, input.modelId);
  const world = input.worldContext ? truncate(input.worldContext, 9000) : "";
  const prev = input.lastAssistantSnippet
    ? truncate(input.lastAssistantSnippet, 1800)
    : "";
  const npcPool =
    input.activeNpcs.length > 0 ? input.activeNpcs.slice(0, 4) : DEFAULT_NPCS;
  const profile = input.profile ?? "standard";
  const profileRule =
    profile === "conservative"
      ? "节奏偏保守：只有在出现明确新冲突/新信息时才推进；NPC 调用建议 1~2 名。"
      : profile === "aggressive"
        ? "节奏偏激进：优先推进剧情与冲突升级；NPC 调用建议 2~4 名。"
        : "节奏标准：在推进与停顿间保持平衡；NPC 调用建议 1~3 名。";
  const maxNpc = profile === "conservative" ? 2 : profile === "aggressive" ? 4 : 3;
  try {
    const r = await generateObject({
      model,
      schema: zodSchema(AutoTurnPlanSchema),
      prompt: `你是「剧情导演调度器」：决定自动档本拍是否应推进，以及要调用哪些 NPC 参与。
当前触发：${input.userLine}
在场 NPC 池：${npcPool.join("、")}
节奏档：${profileRule}
${prev ? `最近一段叙事：${prev}` : ""}
${world ? `世界设定（节选）：${world}` : ""}

规则：
1) 若上一拍已经高潮且缺少新信息，可 should_advance=false（避免无意义刷屏）
2) 若有明显冲突、悬念、行动窗口，应 should_advance=true
3) npc_names 仅可从 NPC 池选择，数量 1~4；当 should_advance=false 可为空
4) reason 用一句中文解释（≤40字）`,
      maxOutputTokens: 260,
    });
    const picked = r.object.npc_names
      .map((x) => x.trim())
      .filter((x) => x.length > 0 && npcPool.includes(x))
      .slice(0, maxNpc);
    return {
      shouldAdvance: r.object.should_advance,
      reason:
        (r.object.reason.trim() || "导演未给出理由") +
        `（节奏:${profile === "conservative" ? "保守" : profile === "aggressive" ? "激进" : "标准"}）`,
      npcNames:
        r.object.should_advance && picked.length > 0
          ? picked
          : r.object.should_advance
            ? npcPool.slice(0, Math.min(maxNpc, 2))
            : [],
    };
  } catch {
    return {
      shouldAdvance: true,
      reason: `规划失败，按${profile === "aggressive" ? "激进" : profile === "conservative" ? "保守" : "标准"}策略推进一拍`,
      npcNames: npcPool.slice(0, profile === "aggressive" ? 3 : 2),
    };
  }
}

/**
 * 动作线导演前置判定：本拍是否应主动掷骰。
 * 返回的 expression 为 NdM 或 NdM±K（如 d20+3、2d6、1d8-1）。
 */
export async function planDirectorDiceForActionTurn(input: {
  userLine: string;
  lastAssistantSnippet: string | null;
  worldContext: string | null;
  provider: string;
  modelId: string;
}): Promise<DirectorDicePlan> {
  const model = getLanguageModelForProvider(input.provider, input.modelId);
  const world = input.worldContext ? truncate(input.worldContext, 9000) : "";
  const prev = input.lastAssistantSnippet
    ? truncate(input.lastAssistantSnippet, 1800)
    : "";
  try {
    const r = await generateObject({
      model,
      schema: zodSchema(DirectorDicePlanSchema),
      prompt: `你是 TRPG 导演判定器：判断当前动作回合是否需要掷骰推进不确定性。
玩家当前动作：${input.userLine}
${prev ? `最近叙事：${prev}` : ""}
${world ? `世界设定（节选）：${world}` : ""}

规则：
1) 只有在结果存在显著不确定性、风险或对抗时 need_roll=true
2) expression 仅可输出标准骰式：NdM 或 NdM+K / NdM-K（例如 d20、d20+3、2d6）
3) 若 need_roll=false，可不填 expression
4) reason 一句中文说明（≤30字）`,
      maxOutputTokens: 160,
    });
    const expr = (r.object.expression ?? "").trim();
    const okExpr = /^(\d*)d(\d+)([+-]\d+)?$/i.test(expr);
    return {
      needRoll: r.object.need_roll && okExpr,
      expression: r.object.need_roll && okExpr ? expr : null,
      reason: r.object.reason.trim() || "导演未给出理由",
    };
  } catch {
    return {
      needRoll: false,
      expression: null,
      reason: "判定器失败，本拍跳过主动掷骰",
    };
  }
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}…`;
}

/**
 * 动作线：环境 →（可选多轮）NPC A2A 总线 → 协调摘要。
 * 任一步失败时使用安全降级，不阻断导演流。
 */
export async function runDynamicRpActionBeat(input: {
  threadId: string;
  beatId: string;
  userLine: string;
  lastAssistantSnippet: string | null;
  worldContext: string | null;
  /** 会话状态中最近掷骰的文本提示，可空 */
  lastDiceHint?: string | null;
  /** DRE-4：世界书实体锚点短块，写入环境/NPC 上下文 */
  worldEntityHint?: string | null;
  /** 分层记忆：共享池 / 私域 / 洞察注入，写入环境/NPC 上下文 */
  layeredMemoryHint?: string | null;
  activeNpcs: string[];
  provider: string;
  modelId: string;
}): Promise<DynamicRpActionBundle> {
  const model = getLanguageModelForProvider(input.provider, input.modelId);
  const interactionRounds = getDreA2aInteractionRounds();
  const useRedis = Boolean(getDreA2aRedisUrl());

  const world = input.worldContext
    ? truncate(input.worldContext, 12_000)
    : "";
  const prev = input.lastAssistantSnippet
    ? truncate(input.lastAssistantSnippet, 2000)
    : "";

  const diceLine = input.lastDiceHint?.trim();
  const entityLine = input.worldEntityHint?.trim();
  const layeredLine = input.layeredMemoryHint?.trim();

  let priorA2aCtx: string | null = null;
  if (useRedis) {
    try {
      priorA2aCtx = await loadDreA2aThreadContext(input.threadId);
    } catch {
      priorA2aCtx = null;
    }
  }
  const priorBlock =
    priorA2aCtx && priorA2aCtx.trim().length > 0
      ? `【上一拍动作线 NPC 后台残响（可衔接，勿照搬）】\n${truncate(priorA2aCtx.trim(), 2500)}`
      : "";

  const contextBlock = [
    world ? `【世界观/设定注入（节选）】\n${world}` : "",
    prev ? `【最近一段叙事/回复（节选）】\n${prev}` : "",
    diceLine ? diceLine : "",
    entityLine ? entityLine : "",
    layeredLine ? layeredLine : "",
    priorBlock,
  ]
    .filter(Boolean)
    .join("\n\n");

  const bus: DreA2aMessage[] = [];
  const nowIso = () => new Date().toISOString();

  async function busAppend(m: DreA2aMessage) {
    bus.push(m);
    if (useRedis) {
      void mirrorAppendDreA2a(input.threadId, input.beatId, m).catch(() => {
        /* 镜像失败不影响本拍 */
      });
    }
  }

  let environment: DynamicRpEnvironmentBeat;
  try {
    const r = await generateObject({
      model,
      schema: zodSchema(EnvBeatSchema),
      prompt: `你是 TRPG「环境主持人」：只根据玩家声明的行动，判断场景即时反馈（若上下文中已有掷骰结果，可合理纳入因果，勿改骰值）。
玩家行动：${input.userLine}

${contextBlock || "（无额外设定）"}

输出结构化结果：event_summary 用 1~2 句中文；state_delta 为可观察的场面变化短句列表；risk_level 为 low/medium/high。`,
    });
    environment = r.object;
  } catch {
    environment = {
      event_summary: "环境因玩家行动骤然紧绷，具体细节留待叙事展开。",
      state_delta: ["气氛对立加剧"],
      risk_level: "medium",
    };
  }

  const npcBeatsRound0 = await Promise.all(
    input.activeNpcs.map(async (name) => {
      try {
        const r = await generateObject({
          model,
          schema: zodSchema(NpcBeatSchema),
          prompt: `你是 NPC「${name}」。玩家刚声明：${input.userLine}
环境判定摘要：${environment.event_summary}
${diceLine ? `${diceLine}\n` : ""}
${entityLine ? `${entityLine}\n` : ""}
${priorBlock ? `${priorBlock}\n` : ""}
在与其他 NPC 做极短后台协调之前，用 intent_line 一句话写清你的即时战术/情绪立场；speaks_if_any 可填半句对外咕哝（≤20 字），否则省略。`,
        });
        return { name, beat: r.object };
      } catch {
        return {
          name,
          beat: {
            intent_line: "保持戒备，评估威胁。",
            speaks_if_any: undefined,
          },
        };
      }
    })
  );

  for (const n of npcBeatsRound0) {
    const line =
      n.beat.intent_line +
      (n.beat.speaks_if_any ? ` 「${n.beat.speaks_if_any}」` : "");
    await busAppend({
      round: 0,
      from: n.name,
      text: line,
      at: nowIso(),
    });
  }

  let npcBeats: Array<{ name: string; beat: DynamicRpNpcBeat }> = npcBeatsRound0;

  for (let roundIdx = 1; roundIdx < interactionRounds; roundIdx++) {
    const transcript = formatA2aTranscript(bus);
    const replies = await Promise.all(
      input.activeNpcs.map(async (name) => {
        try {
          const r = await generateObject({
            model,
            schema: zodSchema(NpcBusReplySchema),
            prompt: `你是 NPC「${name}」。这是后台战术协调第 ${roundIdx + 1} 轮（共约 ${interactionRounds} 轮广播）。你已看到总线：
${transcript}

玩家行动（不变）：${input.userLine}
环境摘要：${environment.event_summary}
${diceLine ? `${diceLine}\n` : ""}
${entityLine ? `${entityLine}\n` : ""}

只输出一条 line：本 NPC 对其他人上一轮的**极短**回应/变阵（不要重复第一轮原话，≤80 字）。`,
            maxOutputTokens: 200,
          });
          return { name, line: r.object.line };
        } catch {
          return { name, line: "保持队形，继续观察。" };
        }
      })
    );

    for (const x of replies) {
      await busAppend({
        round: roundIdx,
        from: x.name,
        text: x.line,
        at: nowIso(),
      });
    }

    npcBeats = replies.map((x) => ({
      name: x.name,
      beat: {
        intent_line: x.line,
        speaks_if_any: undefined,
      },
    }));
  }

  const fullTranscript = formatA2aTranscript(bus);

  let a2a_summary: string;
  try {
    const r = await generateObject({
      model,
      schema: zodSchema(A2ASchema),
      prompt: `将下列 NPC 后台多轮总线整理成 3~6 句中文「协调纪要」（第三人称；涵盖最终默契与分歧；不要出现「作为 AI」）。
${fullTranscript}`,
      maxOutputTokens: 400,
    });
    a2a_summary = r.object.coordination;
  } catch {
    a2a_summary = npcBeats
      .map((n) => `${n.name}暂以观望与自保为主`)
      .join("；");
  }

  if (useRedis) {
    void persistDreA2aThreadContext(input.threadId, fullTranscript).catch(() => {});
  }

  return {
    environment,
    npcBeats,
    a2a_summary,
    a2aTranscript: fullTranscript,
    a2aRoundsUsed: interactionRounds,
    dreBeatId: input.beatId,
  };
}

export function formatDynamicRpDirectorSystemAppend(
  bundle: DynamicRpActionBundle
): string {
  const npcBlock = bundle.npcBeats
    .map((n) => {
      const s = n.beat.speaks_if_any
        ? `${n.name}：${n.beat.intent_line}（外显：「${n.beat.speaks_if_any}」）`
        : `${n.name}：${n.beat.intent_line}`;
      return s;
    })
    .join("\n");

  return `【动态扮演引擎 · 本回合为动作线】
你是导演：综合下列环境判定与 NPC 后台协调，产出「群像场景回合」。

【硬性输出协议（用于前端沉浸渲染）】
1) 第一行必须是：【场景】
2) 【场景】段后紧接 1~2 段环境/动作描写（80~220 字）。直到遇到下一条【角色名】或下一条【场景】才结束该段
3) 接着输出 2~4 个 NPC 角色段，每个角色段必须遵循：
   - 段首仅一行写：【角色名】
   - 下一段文字（可以多行）写该角色的行动与台词（可以混合）
   - 直到遇到下一条【角色名】或【场景】才结束本角色段
   - 角色名需来自在场角色（可用下文 NPC）
   - 每个角色段 40~180 字，语气有区分，互相呼应
4) 最后可追加一段【场景】收束（40~120 字），给玩家留下可接续的行动空间
5) 除上述结构外不要输出标题、JSON、Markdown 列表、解释性文字
6) 非用户行动/台词只能出现在对应的【角色名】段内；环境描写只能出现在【场景】段内，不要混入无标签段落

环境摘要：${bundle.environment.event_summary}
场面变化：${bundle.environment.state_delta.join("；")}
风险感：${bundle.environment.risk_level}
NPC 后台协调纪要：${bundle.a2a_summary}
各 NPC 意图（化入台词与动作，勿机械复述）：
${npcBlock}

约束：勿替玩家决定未声明的行动；勿打破世界观硬性规则；中文输出。`;
}

/** 对话线：轻提示，仍走原有单流模型，由模型自选接话 NPC。 */
export const DRE_DIALOGUE_MODE_APPEND = `【动态扮演引擎 · 本回合为对话线】
用户偏交流/询问。请以场景叙事者身份自然回应，但必须让至少一位在场 NPC 具名出场并说话/行动。
输出要求：
1) 至少包含一个具名角色段，格式为：
   【角色名】
   角色动作与台词（下一行开始可多行，但直到下一个【角色名】前不要再写角色段头）
2) 若正文提到了某在场 NPC 名字，优先让该 NPC 在本回合具名出场
3) 可保留少量【场景】段，但不要整回合都只有场景描写
4) 保持口语与上文连贯，无需动作线分镜。`;

/**
 * 单角色紧凑扮演句式：（动作）「台词」——整段一句，或动作行与台词行分两行。
 * 此类文本不应再经 ensureGroupSpeakerMarkers / 对话结构化 / 格式审查 LLM 重排，否则会被打成无括号纯叙述（与流式原文不一致）。
 */
export function isParentheticalCornerQuoteUtterance(text: string): boolean {
  const t = text.replace(/^\uFEFF/, "").trim();
  if (!t) return false;

  const cornerBlock =
    /^（[^）]*）\s*「[\s\S]*」\s*$/.test(t) || /^\([^)]*\)\s*「[\s\S]*」\s*$/.test(t);
  if (cornerBlock) return true;
  const asciiQuoteBlock =
    /^（[^）]*）\s*"[^"]*"\s*$/.test(t) || /^\([^)]*\)\s*"[^"]*"\s*$/.test(t);
  if (asciiQuoteBlock) return true;
  const curlyQuoteBlock =
    /^（[^）]*）\s*\u201c[^\u201d]*\u201d\s*$/.test(t) ||
    /^\([^)]*\)\s*\u201c[^\u201d]*\u201d\s*$/.test(t);
  if (curlyQuoteBlock) return true;

  const lines = t
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length !== 2) return false;
  const [a, b] = lines;
  if (
    (/^（[^）]+）$/.test(a) && /^「[\s\S]+」$/.test(b)) ||
    (/^\([^)]+\)$/.test(a) && /^「[\s\S]+」$/.test(b))
  ) {
    return true;
  }
  if (
    (/^（[^）]+）$/.test(a) && /^"[^"]*"$/.test(b)) ||
    (/^\([^)]+\)$/.test(a) && /^"[^"]*"$/.test(b))
  ) {
    return true;
  }
  return (
    (/^（[^）]+）$/.test(a) && /^\u201c[^\u201d]*\u201d$/.test(b)) ||
    (/^\([^)]+\)$/.test(a) && /^\u201c[^\u201d]*\u201d$/.test(b))
  );
}

function renderStructuredSpeakerBlocks(input: {
  blocks: Array<z.infer<typeof StructuredSpeakerBlockSchema>>;
  allowedSpeakers: string[];
  preferredSpeaker?: string | null;
}): string {
  const allow = new Set(
    input.allowedSpeakers
      .map((x) => x.trim())
      .filter((x) => x.length > 0)
      .concat("场景")
  );
  const out: string[] = [];
  let namedCount = 0;
  const pushBlock = (speakerRaw: string, actionRaw?: string, speechRaw?: string) => {
    const s = speakerRaw.trim();
    const speaker = allow.has(s) ? s : "场景";
    const action = (actionRaw ?? "").trim();
    const speech = (speechRaw ?? "").trim();
    if (!action && !speech) return;
    out.push(`【${speaker}】`);
    if (action) out.push(`（${action}）`);
    if (speech) out.push(speech);
    if (speaker !== "场景") namedCount += 1;
  };

  for (const b of input.blocks) {
    pushBlock(b.speaker, b.action, b.speech);
  }
  if (namedCount === 0) {
    const preferred = input.preferredSpeaker?.trim() ?? "";
    const fallback =
      (preferred && allow.has(preferred) ? preferred : input.allowedSpeakers[0]?.trim()) ||
      "";
    if (fallback && out.length > 0) {
      // 将第一段场景转为具名段，避免全段都被回收成【场景】。
      if (out[0] === "【场景】") out[0] = `【${fallback}】`;
    }
  }
  return out.join("\n").trim();
}

function buildStructuredSpeakerFallbackFromBundle(input: {
  bundle: DynamicRpActionBundle;
  allowedSpeakers: string[];
  preferredSpeaker?: string | null;
}): string {
  const blocks: Array<z.infer<typeof StructuredSpeakerBlockSchema>> = [
    {
      speaker: "场景",
      action: input.bundle.environment.state_delta.join("；"),
      speech: input.bundle.environment.event_summary,
    },
    ...input.bundle.npcBeats.slice(0, 3).map((n) => ({
      speaker: n.name,
      action: n.beat.intent_line,
      speech: n.beat.speaks_if_any?.trim() || undefined,
    })),
  ];
  return renderStructuredSpeakerBlocks({
    blocks,
    allowedSpeakers: input.allowedSpeakers,
    preferredSpeaker: input.preferredSpeaker,
  });
}

/**
 * 将动作线导演草稿转为结构化 speaker/action/speech，再统一渲染为角色块。
 * 目标：不依赖模型自然语言格式，避免把动作短语识别成角色名。
 */
export async function buildStructuredSpeakerTranscriptFromActionBeat(input: {
  draftText: string;
  bundle: DynamicRpActionBundle;
  speakers: string[];
  preferredSpeaker?: string | null;
  provider: string;
  modelId: string;
}): Promise<string> {
  const raw = input.draftText.trim();
  if (raw && isParentheticalCornerQuoteUtterance(raw)) {
    return input.draftText.trim();
  }
  if (!raw) {
    return buildStructuredSpeakerFallbackFromBundle({
      bundle: input.bundle,
      allowedSpeakers: input.speakers,
      preferredSpeaker: input.preferredSpeaker,
    });
  }
  const allowedSpeakers = [
    ...new Set(
      input.speakers
        .map((x) => x.trim())
        .filter((x) => x.length > 0)
        .concat(input.bundle.npcBeats.map((n) => n.name.trim()))
    ),
  ].slice(0, 10);
  const model = getLanguageModelForProvider(input.provider, input.modelId);

  try {
    const r = await generateObject({
      model,
      schema: zodSchema(StructuredSpeakerTurnSchema),
      prompt:
        `你是“动作线结构化编排器”。请把导演草稿转成结构化 blocks。` +
        `每个 block 必须是 speaker/action/speech 三元组（action/speech 可其一为空）。\n` +
        `规则：\n` +
        `1) speaker 只能是候选角色或“场景”；\n` +
        `2) 任何动作词（如“环顾四周”“眼神微凝”）必须放在 action，不能当 speaker；\n` +
        `3) 保持原意，不新增事实；\n` +
        `4) 至少一个具名角色 block（若语义允许优先 ${input.preferredSpeaker?.trim() || "候选角色"}）。\n\n` +
        `候选角色：${allowedSpeakers.join("、") || "（无）"}\n` +
        `环境摘要：${input.bundle.environment.event_summary}\n` +
        `NPC 意图：${input.bundle.npcBeats
          .map((n) => `${n.name}:${n.beat.intent_line}`)
          .join("；")}\n\n` +
        `导演草稿：\n${truncate(raw, 5000)}`,
      maxOutputTokens: 1200,
      temperature: 0,
    });
    const rendered = renderStructuredSpeakerBlocks({
      blocks: r.object.blocks,
      allowedSpeakers,
      preferredSpeaker: input.preferredSpeaker,
    });
    if (rendered) return rendered;
  } catch {
    // fallback below
  }

  return buildStructuredSpeakerFallbackFromBundle({
    bundle: input.bundle,
    allowedSpeakers,
    preferredSpeaker: input.preferredSpeaker,
  });
}

/**
 * 对话线结构化 speaker 管线：把自然语言稿转为 speaker/action/speech blocks，
 * 再统一渲染为【角色名】段，避免解析器猜测说话者。
 */
export async function buildStructuredSpeakerTranscriptFromDialogue(input: {
  draftText: string;
  speakers: string[];
  preferredSpeaker?: string | null;
  provider: string;
  modelId: string;
}): Promise<string> {
  const raw = input.draftText.trim();
  if (!raw) return input.draftText;
  if (isParentheticalCornerQuoteUtterance(raw)) return input.draftText;
  const allowedSpeakers = [
    ...new Set(input.speakers.map((x) => x.trim()).filter((x) => x.length > 0)),
  ].slice(0, 10);
  if (allowedSpeakers.length === 0) return input.draftText;
  const preferred = input.preferredSpeaker?.trim() || "";
  const model = getLanguageModelForProvider(input.provider, input.modelId);
  try {
    const r = await generateObject({
      model,
      schema: zodSchema(StructuredSpeakerTurnSchema),
      prompt:
        `你是“对话线结构化编排器”。请把输入改写为结构化 blocks。` +
        `每个 block 包含 speaker/action/speech（action/speech 可其一为空）。\n` +
        `规则：\n` +
        `1) speaker 只能从候选角色里选，或用“场景”；\n` +
        `2) 动作短语（如“环顾四周”“眼神微凝”）只能放 action，不能当 speaker；\n` +
        `3) 保留原意，不新增世界事实；\n` +
        `4) 至少保留一个具名角色段，优先 ${preferred || "候选角色"}。\n\n` +
        `候选角色：${allowedSpeakers.join("、")}\n` +
        `输入文本：\n${truncate(raw, 5000)}`,
      maxOutputTokens: 1000,
      temperature: 0,
    });
    const rendered = renderStructuredSpeakerBlocks({
      blocks: r.object.blocks,
      allowedSpeakers,
      preferredSpeaker: preferred,
    });
    if (rendered) return rendered;
  } catch {
    // fallback below
  }
  const normalized = normalizeBareSpeakerLinesToHeaders(
    normalizeRoleHeaderFormat(raw),
    allowedSpeakers
  );
  const sanitized = sanitizeSpeakerBlocks(normalized, allowedSpeakers);
  return enforceAtLeastOneNamedHeader(sanitized, allowedSpeakers, preferred);
}

function countSpeakerMarkers(text: string): number {
  const lines = text.split("\n");
  let c = 0;
  for (const line of lines) {
    if (/^\s*[【\[][^】\]\n]{1,24}[】\]]\s*$/.test(line.trim())) c += 1;
  }
  return c;
}

function hasSpeakerMarkerFor(text: string, speaker: string): boolean {
  const s = speaker.trim();
  if (!s) return false;
  const escaped = s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`^\\s*\\[[\\s]*${escaped}[\\s]*\\]\\s*$`, "m");
  const reCn = new RegExp(`^\\s*【\\s*${escaped}\\s*】\\s*$`, "m");
  return re.test(text) || reCn.test(text);
}

function countCnRoleHeaders(text: string): number {
  const lines = text.split("\n");
  let c = 0;
  for (const line of lines) {
    if (/^\s*【[^】\n]{1,24}】\s*$/.test(line.trim())) c += 1;
  }
  return c;
}

function countNamedRoleHeaders(text: string): number {
  const lines = text.split("\n");
  let c = 0;
  for (const line of lines) {
    const m = line.trim().match(/^【([^】\n]{1,24})】\s*$/);
    if (!m) continue;
    const name = m[1]?.trim() ?? "";
    if (name && name !== "场景") c += 1;
  }
  return c;
}

function normalizeRoleHeaderFormat(text: string): string {
  const lines = text.split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const mSq = line.trim().match(/^\[([^\]\n]{1,24})\]\s*$/);
    if (mSq) {
      const name = mSq[1]?.trim() ?? "";
      if (name) {
        out.push(`【${name}】`);
        continue;
      }
    }
    out.push(line);
  }
  return out.join("\n");
}

function normalizeBareSpeakerLinesToHeaders(
  text: string,
  candidates: string[]
): string {
  const allow = new Set(
    candidates
      .map((x) => x.trim())
      .filter((x) => x.length > 0)
      .concat("场景")
  );
  const lines = text.split("\n");
  const out: string[] = [];
  for (const raw of lines) {
    const t = raw.trim();
    if (!t) {
      out.push(raw);
      continue;
    }
    if (/^[【\[][^】\]\n]{1,24}[】\]]\s*$/.test(t)) {
      out.push(raw);
      continue;
    }
    if (!allow.has(t)) {
      out.push(raw);
      continue;
    }
    if (t !== "场景" && isForbiddenNonSpeakerTag(t)) {
      out.push(raw);
      continue;
    }
    out.push(`【${t}】`);
  }
  return out.join("\n");
}

function isForbiddenNonSpeakerTag(name: string): boolean {
  const n = name.trim();
  if (!n) return true;
  // 避免“【廷根时期】/【第一章】/【主线】”之类标签被当作说话人。
  if (/(时期|时代|阶段|年间|纪元|线|篇|卷|章|幕|节)$/.test(n)) return true;
  if (/(主线|支线|回忆|序章|尾声|番外)$/.test(n)) return true;
  if (/(脚步|身形|神情|语气|声音|目光|呼吸|眉头|嘴角|指尖|掌心|喉间)/.test(n))
    return true;
  if (
    /(环顾|眼神|目光|低声|沉声|抬手|抬眼|抬头|转头|转身|伸手|收手|握紧|松开|叹息|轻声|冷笑|苦笑|点头|摇头|皱眉|挑眉|看向|望向|扫视|打量|后退|上前|迈步|站起|坐下|俯身|起身)/.test(
      n
    )
  )
    return true;
  if (/(微顿|一顿|停下|停住|放缓|收紧|凝住|僵住|压低|沉声|低语|带路|观察四周|跟紧)$/.test(n))
    return true;
  // 避免动作短语（如“站起身”“抬头”）被当作说话者头。
  if (/(起身|站起|坐下|抬头|低头|转身|回头|点头|摇头|皱眉|沉默|轻笑|苦笑|叹气|看向|望向|走近|后退|举起|放下|握紧|松开)$/.test(n)) return true;
  return false;
}

function sanitizeSpeakerBlocks(text: string, candidates: string[]): string {
  const allow = new Set(
    candidates
      .map((x) => x.trim())
      .filter((x) => x.length > 0)
      .concat("场景")
  );
  const lines = text.split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? "";
    const t = raw.trim();
    const mSq = t.match(/^\[([^\]\n]{1,24})\]\s*$/);
    const mCn = t.match(/^【([^】\n]{1,24})】\s*$/);
    const pickedName = (mSq?.[1] ?? mCn?.[1] ?? "").trim();
    if (!pickedName) {
      out.push(raw);
      continue;
    }
    const name = pickedName;
    if (isForbiddenNonSpeakerTag(name)) {
      // 保留信息但移除“伪说话人”头；让其作为普通叙事行而非角色头。
      out.push(name);
      const next = (lines[i + 1] ?? "").trim();
      if (/^【[^】\n]{1,24}】$/.test(next) || /^\[[^\]\n]{1,24}\]\s*$/.test(next)) i += 1;
      continue;
    }
    if (!allow.has(name)) {
      // 未在候选名单中的“伪段头”不要强制回收成【场景】，
      // 否则会把普通句子误拆成场景段（例如【你说什么呢】）。
      out.push(name);
      continue;
    }
    out.push(`【${name}】`);
    const next = (lines[i + 1] ?? "").trim();
    if (/^【[^】\n]{1,24}】$/.test(next) || /^\[[^\]\n]{1,24}\]\s*$/.test(next)) i += 1;
  }
  return out.join("\n");
}

function enforceAtLeastOneNamedHeader(
  text: string,
  candidates: string[],
  preferred?: string | null
): string {
  if (countNamedRoleHeaders(text) >= 1) return text;
  const picked =
    (preferred?.trim() && candidates.includes(preferred.trim())
      ? preferred.trim()
      : candidates[0]?.trim()) || "";
  if (!picked) return text;
  const body = text.trim();
  if (!body) return `【${picked}】`;
  return `【${picked}】\n${body}`;
}

/**
 * 动作线兜底修复：若模型未稳定输出说话者标记，则二次改写成可拆分的群聊文本。
 * 目标格式：
 * [场景]
 * ...
 * [角色A]
 * ...
 */
export async function ensureGroupSpeakerMarkers(input: {
  text: string;
  speakers: string[];
  /** 若用户本轮点名了某 NPC，则优先确保该角色至少出现一段 */
  preferredSpeaker?: string | null;
  forceIncludePreferred?: boolean;
  /** 严格模式：要求输出中至少有 2 个「【角色名】」分段 */
  strictNameHeader?: boolean;
  provider: string;
  modelId: string;
}): Promise<string> {
  const raw = input.text.trim();
  if (!raw) return input.text;
  if (isParentheticalCornerQuoteUtterance(raw)) return input.text;
  const strictNameHeader = Boolean(input.strictNameHeader);
  const preferred = input.preferredSpeaker?.trim() || "";
  const speakerList = input.speakers
    .map((x) => x.trim())
    .filter((x) => x.length > 0)
    .slice(0, 6);
  // 如果候选为空，兜底重排只能把所有人名当成“场景”进行清洗，反而破坏已正确的格式。
  // 直接返回输入文本，交给前端解析器按协议渲染。
  if (speakerList.length === 0) {
    return input.text;
  }
  const normalizedRaw = normalizeBareSpeakerLinesToHeaders(
    normalizeRoleHeaderFormat(raw),
    speakerList
  );
  const alreadyHasPreferred =
    preferred.length > 0 ? hasSpeakerMarkerFor(normalizedRaw, preferred) : false;
  if (
    countSpeakerMarkers(normalizedRaw) >= 2 &&
    (!strictNameHeader || countNamedRoleHeaders(normalizedRaw) >= 1) &&
    (!input.forceIncludePreferred || !preferred || alreadyHasPreferred)
  ) {
    const norm = strictNameHeader
      ? normalizeBareSpeakerLinesToHeaders(
          normalizeRoleHeaderFormat(input.text),
          speakerList
        )
      : normalizeBareSpeakerLinesToHeaders(input.text, speakerList);
    const san = sanitizeSpeakerBlocks(norm, speakerList);
    return strictNameHeader
      ? enforceAtLeastOneNamedHeader(san, speakerList, preferred)
      : san;
  }
  const model = getLanguageModelForProvider(input.provider, input.modelId);
  try {
    const r = await generateText({
      model,
      system: `你是“群像台词整理器”。将输入文本重排为可拆分的群聊段落，保持原意与信息，不新增剧情事实。
输出规则（必须）：
1) 仅输出正文，不解释
2) 段落首行必须是【场景】或【角色名】
3) 角色段用【角色名】起手，紧接下一段文本即为该角色的行动与台词（可以多行），直到遇到下一条【角色名】/【场景】才结束
4) 角色名优先使用给定候选；不确定就用【场景】
5) 除用户动作外，任何角色行动/台词都不能放在无身份标记段落里
6) ${
        input.forceIncludePreferred && preferred
          ? `必须至少包含一段【${preferred}】（用户本轮明确在和该角色说话）`
          : "若用户点名了某角色，优先让该角色出现一段"
      }
7) 禁止输出“时期/时代/章节/幕/卷/线”等标签头（例如【廷根时期】、【第一章】）；这类信息应写为普通叙事句，不要方括号包裹
8) 保留原文语气与顺序，尽量少改字词`,
      prompt:
        `【候选角色】${speakerList.length ? speakerList.join("、") : "（无）"}\n` +
        (preferred ? `【优先角色】${preferred}\n` : "") +
        `\n` +
        `【待重排文本】\n${normalizedRaw}`,
      maxOutputTokens: 1200,
      temperature: 0.1,
    });
    const t = r.text.trim();
    if (!t) return input.text;
    const normalized = normalizeBareSpeakerLinesToHeaders(
      strictNameHeader ? normalizeRoleHeaderFormat(t) : t,
      speakerList
    );
    if (countSpeakerMarkers(normalized) === 0) {
      return normalizeBareSpeakerLinesToHeaders(input.text, speakerList);
    }
    const sanitized = sanitizeSpeakerBlocks(normalized, speakerList);
    if (strictNameHeader && countNamedRoleHeaders(sanitized) < 1) {
      const fb = sanitizeSpeakerBlocks(
        normalizeBareSpeakerLinesToHeaders(
          normalizeRoleHeaderFormat(input.text),
          speakerList
        ),
        speakerList
      );
      return enforceAtLeastOneNamedHeader(fb, speakerList, preferred);
    }
    return strictNameHeader
      ? enforceAtLeastOneNamedHeader(sanitized, speakerList, preferred)
      : sanitized;
  } catch {
    const fallback = strictNameHeader
      ? normalizeBareSpeakerLinesToHeaders(
          normalizeRoleHeaderFormat(input.text),
          speakerList
        )
      : normalizeBareSpeakerLinesToHeaders(input.text, speakerList);
    const sanitized = sanitizeSpeakerBlocks(fallback, speakerList);
    return strictNameHeader
      ? enforceAtLeastOneNamedHeader(sanitized, speakerList, preferred)
      : sanitized;
  }
}

export async function auditAndRepairRoleBlockFormat(input: {
  text: string;
  speakers: string[];
  preferredSpeaker?: string | null;
  /** 对话回合可开启：禁止【场景】段，全部归入角色段 */
  disallowScene?: boolean;
  provider: string;
  modelId: string;
}): Promise<string> {
  const raw = input.text.trim();
  if (!raw) return input.text;
  if (isParentheticalCornerQuoteUtterance(raw)) return input.text;
  const model = getLanguageModelForProvider(input.provider, input.modelId);
  const baseSpeakers = input.speakers
    .map((x) => x.trim())
    .filter((x) => x.length > 0)
    .slice(0, 8);
  // 仅使用上游明确提供的候选角色，避免把“【你说什么呢】/【求身】”之类误当成新角色名。
  const speakerList = [...new Set(baseSpeakers)].slice(0, 10);
  const rawNormalized = normalizeBareSpeakerLinesToHeaders(
    normalizeRoleHeaderFormat(raw),
    speakerList
  );
  const preferred = input.preferredSpeaker?.trim() || "";
  const disallowScene = Boolean(input.disallowScene);

  const convertSceneBlocksToSpeaker = (text: string): string => {
    if (!disallowScene) return text;
    const fallback = preferred || speakerList[0] || "";
    if (!fallback) return text;
    const lines = text.split("\n");
    const out: string[] = [];
    let currentSpeaker = fallback;
    for (const line of lines) {
      const t = line.trim();
      const m = t.match(/^【([^】\n]{1,24})】\s*$/);
      if (!m) {
        out.push(line);
        continue;
      }
      const header = (m[1] ?? "").trim();
      if (!header) {
        out.push(line);
        continue;
      }
      if (header === "场景") {
        out.push(`【${currentSpeaker}】`);
      } else {
        currentSpeaker = header;
        out.push(line);
      }
    }
    return out.join("\n");
  };

  const promoteSceneLinesToSpeakerBlocks = (text: string): string => {
    if (speakerList.length === 0) return text;
    const sorted = [...speakerList].sort((a, b) => b.length - a.length);
    const lines = text.split("\n");
    const out: string[] = [];
    let currentHeader = "";
    const headerRe = /^【([^】\n]{1,24})】\s*$/;

    const detectLeadingSpeaker = (line: string): string | null => {
      const t = line.trim();
      if (!t) return null;
      for (const s of sorted) {
        if (!t.startsWith(s)) continue;
        const next = t.slice(s.length, s.length + 1);
        if (!next) return s;
        if (/[，,。！？!?:：、\s（(“"「『]/.test(next)) return s;
        if (/^[\u4e00-\u9fa5]$/.test(next)) return s;
      }
      return null;
    };

    for (const line of lines) {
      const m = line.trim().match(headerRe);
      if (m) {
        currentHeader = m[1]?.trim() ?? "";
        out.push(line);
        continue;
      }
      if (currentHeader === "场景") {
        const lead = detectLeadingSpeaker(line);
        if (lead) {
          out.push(`【${lead}】`);
          currentHeader = lead;
          out.push(line);
          continue;
        }
      }
      out.push(line);
    }
    return out.join("\n");
  };

  const hasSpeakerPrefixProtocol =
    /^\s*【\s*说话者\s*[:：]\s*[^】\n]+】/m.test(rawNormalized) ||
    /^\s*\[CW_SPEAKER:[^\]\n]+\]/m.test(rawNormalized);

  // 保守策略：若原文已包含角色块，优先保留原始角色结构，避免审查重写“吞角色/改名”。
  // 仅做轻量规范化，不进入 LLM 重写。
  if (countNamedRoleHeaders(rawNormalized) >= 1 && !hasSpeakerPrefixProtocol) {
    return convertSceneBlocksToSpeaker(
      promoteSceneLinesToSpeakerBlocks(rawNormalized)
    );
  }

  try {
    const r = await generateObject({
      model,
      schema: zodSchema(RoleBlockAuditSchema),
      prompt: `你是“角色块格式审查器”。请严格审查并必要时修复下列文本格式。

目标格式（必须）：
1) 文本由若干段组成；每段首行必须是【角色名】或【场景】
2) 段首下一行起为该段正文（可多行），直到遇到下一条【角色名】/【场景】才结束
3) 不允许使用【说话者：...】或 [CW_SPEAKER:...] 前缀行
4) 不允许把动作短语（如“停下脚步”“微微点头”）当作角色名
5) 除【场景】外，角色名优先来自候选列表
6) 若提供了优先角色，且语义允许，至少保留一段该角色块
7) ${disallowScene ? "本次严格要求：禁止输出【场景】段，所有内容必须归入具体角色段。" : "可保留少量【场景】段。"}
8) 禁止输出“时期/时代/章节/幕/卷/线”等标签头（例如【廷根时期】、【第一章】）；若出现请改为普通叙事句（无方括号）

请返回：
- is_valid: 是否已符合格式
- reason: 简短原因
- repaired_text: 若不符合，给出修复后完整文本；若已符合可省略

候选角色：${speakerList.length > 0 ? speakerList.join("、") : "（无）"}
优先角色：${preferred || "（无）"}

待审查文本：
${rawNormalized}`,
      maxOutputTokens: 1400,
      temperature: 0,
    });
    if (r.object.is_valid) {
      return convertSceneBlocksToSpeaker(
        promoteSceneLinesToSpeakerBlocks(
          normalizeBareSpeakerLinesToHeaders(
            normalizeRoleHeaderFormat(input.text),
            speakerList
          )
        )
      );
    }
    const repaired = (r.object.repaired_text ?? "").trim();
    if (repaired) {
      return convertSceneBlocksToSpeaker(
        promoteSceneLinesToSpeakerBlocks(repaired)
      );
    }
    return convertSceneBlocksToSpeaker(
      promoteSceneLinesToSpeakerBlocks(
        normalizeBareSpeakerLinesToHeaders(
          normalizeRoleHeaderFormat(input.text),
          speakerList
        )
      )
    );
  } catch {
    return convertSceneBlocksToSpeaker(
      promoteSceneLinesToSpeakerBlocks(
        normalizeBareSpeakerLinesToHeaders(
          normalizeRoleHeaderFormat(input.text),
          speakerList
        )
      )
    );
  }
}
