import "server-only";

import {
  Annotation,
  END,
  Send,
  START,
  StateGraph,
} from "@langchain/langgraph";
import { generateObject, generateText, zodSchema } from "ai";
import * as z from "zod";
import {
  parseAndValidateCanonicalWorld,
  type CanonicalWorld,
  type ValidateResult,
} from "@/lib/canonical-world";
import {
  formatGraphBlueprintForPrompt,
  runWorldForgeGraphBlueprintStep,
  type WorldForgeGraphBlueprint,
} from "@/lib/world-forge-graph-blueprint";
import {
  formatWorldForgeReviewFeedback,
  runWorldForgeReviewStep,
} from "@/lib/world-forge-review";
import type {
  WorldForgeIncrementTarget,
  WorldForgePipelineFailure,
  WorldForgePipelineResult,
  WorldForgePipelineSuccess,
  WorldForgeProfile,
  WorldForgeStepRecord,
} from "@/lib/world-forge-pipeline-types";
import {
  wfBuildExpandUserPrompt,
  wfBuildLatestCanonicalBlock,
  wfRunExpandStep,
  wfRunParseStep,
  wfTruncateUtf8,
} from "@/lib/world-forge-shared";
import { extractJsonObjectFromModelOutput } from "@/lib/world-import-agent";
import { getLanguageModelForProvider } from "@/lib/llm";

const ARCHITECT_SYSTEM = `你是 CanonWeave **WorldForge·架构师 Agent**（并行轨之一）。
你只负责**叙事与宏观设定侧**：地理与时代、主要势力与人物关系梗概、历史背景与时间线要点、整体基调与禁忌氛围。
输出 **Markdown** 分小节即可。**不要**输出完整 Canonical JSON；**不要**独自敲定数值化规则或详细升级表（由机制设计师轨并行处理）。
若用户大纲几乎为空，仍基于摘要做最小可落地的骨架，并明确标注「待机制侧补全」。
若提供了「图谱蓝图」，请与之对齐实体/关系，避免凭空新增与蓝图冲突的名称。
若运行环境提供联网 MCP（如 web_search / web_fetch_extract），可检索同题材公开资料补充表达，但必须避免抄袭并与用户设定对齐。`;

const MECHANIST_SYSTEM_PARALLEL = `你是 CanonWeave **WorldForge·机制设计师 Agent**（并行轨之一，与架构师/人物卡设计师**并行**）。
你**看不到**架构师的实时成稿；请基于用户大纲与解析摘要（及若有「图谱蓝图」）独立设计：
1. 可执行的**规则、力量/社会机制、升级路径、代价与反噬**；
2. 在文中用简短列表标注「可能与叙事侧冲突/待合成消解」的假设点（因未读架构师稿）。

若运行环境提供联网 MCP（如 web_search / web_fetch_extract），可检索同题材公开资料补充表达，但必须避免抄袭并与用户设定对齐。
**不要**输出完整 Canonical JSON；**不要**重写整部世界观。语气专业、可协作。`;

const CHARACTER_DESIGNER_SYSTEM_PARALLEL = `你是 CanonWeave **WorldForge·人物卡设计师 Agent**（并行轨之一，与架构师/机制设计师**并行**）。
你**看不到**其它并行轨的实时成稿；请基于用户大纲与解析摘要（及若有「图谱蓝图」）独立输出素材。产出须与 **SillyTavern「角色管理 / 导入角色」** 语义对齐：**每写一个可扮演角色，就等于写满一张可独立使用的角色卡**（通常为 1 人；若大纲是多人组合卡，在同一角色块内写清结构与分工）。

对每个**重要可扮演角色**（主角、关键 NPC），用 Markdown 分块输出，块内必须包含下列小节（合成节点会据此写入 Canonical 的 character_books[].character_card + entries）：

### 角色：<中文名>（bound_entity_id 建议：英文 slug）
- **绑定**：bound_entity_id / bound_entity_name（与图谱实体名尽量一致）
- **character_card（完整内容，勿留标题无正文）**
  - description：角色描述（让读者快速理解这张卡）
  - personality：性格
  - scenario：默认场景与处境
  - appearance：外貌与着装
  - backstory：经历与背景
  - relationships：人际关系
  - speech_patterns：口癖、称呼、对事物的态度
  - first_mes：开场白（一条完整首消息，可用 *动作* 包裹）
  - mes_example：示例对话（用 <START> 分隔多轮，可含 {{user}} / {{char}}）
  - post_history_instructions：（可选）长期扮演约束
  - alternate_greetings：（可选）列表形式备选开场
  - tags：（可选）标签列表
- **人物书 entries 草案**：3～8 条，每条含 建议 id、title、content 要点、keys[]、strategy（keyword/constant）
- **扮演风险**：易 OOC / 超游点与必须遵守的边界句

若运行环境提供联网 MCP（如 web_search / web_fetch_extract），可检索同题材公开资料补充表达，但必须避免抄袭并与用户设定对齐。
**不要**输出完整 Canonical JSON；语气专业、可协作。`;

const CharacterIncrementPatchSchema = z.object({
  entities: z.array(z.any()).default([]),
  relations: z.array(z.any()).default([]),
  lore_entries: z.array(z.any()).default([]),
  warnings: z.array(z.any()).default([]),
  character_books: z.array(z.record(z.string(), z.any())).default([]),
});

type CharacterIncrementPatch = z.infer<typeof CharacterIncrementPatchSchema>;

function uniqueConcatByJson(base: unknown[], extra: unknown[]): unknown[] {
  const seen = new Set<string>();
  const out: unknown[] = [];
  for (const item of [...base, ...extra]) {
    const key = JSON.stringify(item);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function entityKeyOf(item: unknown): string | null {
  if (!item || typeof item !== "object" || Array.isArray(item)) return null;
  const obj = item as Record<string, unknown>;
  const id = typeof obj.id === "string" ? obj.id.trim() : "";
  if (id) return `id:${id}`;
  const name = typeof obj.name === "string" ? obj.name.trim() : "";
  if (name) return `name:${name}`;
  return null;
}

function characterBookKeyOf(item: unknown): string | null {
  if (!item || typeof item !== "object" || Array.isArray(item)) return null;
  const obj = item as Record<string, unknown>;
  const boundId =
    typeof obj.bound_entity_id === "string" ? obj.bound_entity_id.trim() : "";
  if (boundId) return `bound:${boundId}`;
  const name = typeof obj.name === "string" ? obj.name.trim() : "";
  if (name) return `name:${name}`;
  return null;
}

function upsertByKey(
  base: unknown[],
  extra: unknown[],
  keyOf: (item: unknown) => string | null
): unknown[] {
  const out = [...base];
  const indexByKey = new Map<string, number>();
  for (let i = 0; i < out.length; i++) {
    const k = keyOf(out[i]);
    if (k) indexByKey.set(k, i);
  }
  for (const item of extra) {
    const k = keyOf(item);
    if (!k) {
      out.push(item);
      continue;
    }
    const idx = indexByKey.get(k);
    if (idx == null) {
      indexByKey.set(k, out.length);
      out.push(item);
    } else {
      out[idx] = item;
    }
  }
  return out;
}

async function generateCharacterIncrementPatch(input: {
  model: ReturnType<typeof getLanguageModelForProvider>;
  worldName: string;
  brief: string;
  currentCanonicalJson: string;
  characterDesignerOutput: string;
}): Promise<
  | { ok: true; patch: CharacterIncrementPatch }
  | { ok: false; error: string; errors?: string[] }
> {
  const system =
    "你是 CanonWeave 角色增量合并器。只输出一个 JSON 对象，表示“新增/更新角色片段”，不要输出完整 Canonical。";
  const prompt =
    `【世界名称】${input.worldName}\n\n` +
    `【用户增量需求】\n${wfTruncateUtf8(input.brief, 8_000)}\n\n` +
    `【当前 Canonical（参考）】\n${wfTruncateUtf8(input.currentCanonicalJson, 20_000)}\n\n` +
    `【人物设计师草稿】\n${wfTruncateUtf8(input.characterDesignerOutput, 12_000)}\n\n` +
    "请提取并输出角色增量片段 JSON，只允许键：entities, relations, lore_entries, warnings, character_books。";

  try {
    const objectResult = await generateObject({
      model: input.model,
      schema: zodSchema(CharacterIncrementPatchSchema),
      schemaName: "world_forge_character_increment_patch",
      schemaDescription: "Canonical character increment patch object",
      system,
      prompt,
      maxOutputTokens: 4096,
      temperature: 0.2,
    });
    return { ok: true, patch: objectResult.object };
  } catch (e) {
    const firstErr = e instanceof Error ? e.message : String(e);
    try {
      const text = await generateText({
        model: input.model,
        system:
          system +
          "\n文本回退时也必须只输出一个 JSON 对象，不要任何解释，不要 Markdown。",
        prompt,
        maxOutputTokens: 4096,
        temperature: 0.2,
      });
      let parsed = extractJsonObjectFromModelOutput(text.text);
      if (!parsed) {
        const repaired = await generateText({
          model: input.model,
          system: "你是 JSON 修复器。只输出合法 JSON 对象。",
          prompt:
            "目标仅允许键：entities, relations, lore_entries, warnings, character_books。\n\n待修复文本：\n" +
            text.text,
          maxOutputTokens: 4096,
          temperature: 0,
        });
        parsed = extractJsonObjectFromModelOutput(repaired.text);
      }
      const safe = CharacterIncrementPatchSchema.safeParse(parsed);
      if (!safe.success) {
        return {
          ok: false,
          error: "角色增量片段解析失败。",
          errors: [firstErr, safe.error.message],
        };
      }
      return { ok: true, patch: safe.data };
    } catch (e2) {
      const secondErr = e2 instanceof Error ? e2.message : String(e2);
      return { ok: false, error: "角色增量片段生成失败。", errors: [firstErr, secondErr] };
    }
  }
}

function mergeCharacterPatchIntoCanonical(
  base: CanonicalWorld,
  patch: CharacterIncrementPatch
): CanonicalWorld {
  return {
    ...base,
    entities: upsertByKey(base.entities ?? [], patch.entities ?? [], entityKeyOf),
    relations: uniqueConcatByJson(base.relations ?? [], patch.relations ?? []),
    lore_entries: uniqueConcatByJson(
      base.lore_entries ?? [],
      patch.lore_entries ?? []
    ),
    warnings: uniqueConcatByJson(base.warnings ?? [], patch.warnings ?? []),
    character_books: upsertByKey(
      base.character_books ?? [],
      patch.character_books ?? [],
      characterBookKeyOf
    ) as CanonicalWorld["character_books"],
  };
}

function buildSynthesizeUserPrompt(input: {
  worldName: string;
  brief: string;
  summaryText: string;
  latestBlock: string;
  architectOutput: string;
  mechanistOutput: string;
  characterDesignerOutput: string;
}): string {
  const arch = wfTruncateUtf8(input.architectOutput, 24_000);
  const mech = wfTruncateUtf8(input.mechanistOutput, 24_000);
  const char = wfTruncateUtf8(input.characterDesignerOutput, 24_000);
  return (
    `【世界名称】${input.worldName}\n\n` +
    `【用户原始大纲】\n${input.brief}\n\n` +
    `【解析员结构化摘要】\n${input.summaryText}\n` +
    input.latestBlock +
    `【架构师 Agent 输出（并行轨 A）】\n${arch}\n\n` +
    `【机制设计师 Agent 输出（并行轨 B）】\n${mech}\n\n` +
    `【人物卡设计师 Agent 输出（并行轨 C）】\n${char}\n\n` +
    `请将上述**三轨并行**成果在**合成节点**中**合并为一份完整**的 Canonical JSON 对象（顶层键须齐全）。` +
    `优先消解各轨标出的矛盾与「待合成消解」项；保留三方合理内容；若提供了当前 Canonical 快照须融合而非丢弃。` +
    `其中人物卡设计师轨应沉淀到 character_books：**每个 character_books 元素必须包含完整的 character_card 对象**（对齐 SillyTavern 角色卡：description/personality/scenario/first_mes/mes_example 等，见项目 docs/world-lorebook-spec.md §3），并与 entities 建立 bound_entity_* 绑定；entries 为 Lorebook 触发条目，与 character_card 勿自相矛盾。`
  );
}

function buildSynthesizeCompactUserPrompt(input: {
  worldName: string;
  brief: string;
  summaryText: string;
  latestBlock: string;
  architectOutput: string;
  mechanistOutput: string;
  characterDesignerOutput: string;
}): string {
  const brief = wfTruncateUtf8(input.brief, 10_000);
  const summary = wfTruncateUtf8(input.summaryText, 6_000);
  const latest = wfTruncateUtf8(input.latestBlock, 8_000);
  const arch = wfTruncateUtf8(input.architectOutput, 8_000);
  const mech = wfTruncateUtf8(input.mechanistOutput, 8_000);
  const char = wfTruncateUtf8(input.characterDesignerOutput, 8_000);
  return (
    `【世界名称】${input.worldName}\n\n` +
    `【用户原始大纲（压缩）】\n${brief}\n\n` +
    `【解析员结构化摘要（压缩）】\n${summary}\n` +
    latest +
    `【架构师轨（压缩）】\n${arch}\n\n` +
    `【机制师轨（压缩）】\n${mech}\n\n` +
    `【人物卡轨（压缩）】\n${char}\n\n` +
    `请将三轨结果合并为一个完整 Canonical JSON（顶层键齐全）。` +
    `若信息冲突，以“与用户大纲和摘要更一致、可落地”为准。` +
    `请优先输出结构完整、字段齐全、可通过 schema 校验的对象，不要额外解释文字。`
  );
}

function isCharacterIncrementBrief(brief: string): boolean {
  const t = brief.toLowerCase();
  const zhHit =
    /增量|新增|增加|补充|角色|人物|character_books|人物卡|角色卡/.test(brief);
  const enHit =
    t.includes("character_books") ||
    t.includes("character card") ||
    t.includes("add character") ||
    t.includes("add npc");
  return zhHit || enHit;
}

function isLocationIncrementBrief(brief: string): boolean {
  const t = brief.toLowerCase();
  const zhHit = /新增|增加|补充|增量|地点|地名|区域|城镇|城市|国家|地理/.test(
    brief
  );
  const enHit =
    t.includes("add location") ||
    t.includes("new location") ||
    t.includes("place") ||
    t.includes("region");
  return zhHit || enHit;
}

function isOrganizationIncrementBrief(brief: string): boolean {
  const t = brief.toLowerCase();
  const zhHit = /新增|增加|补充|增量|组织|势力|教会|公会|阵营/.test(brief);
  const enHit =
    t.includes("add organization") ||
    t.includes("new faction") ||
    t.includes("faction") ||
    t.includes("organization");
  return zhHit || enHit;
}

/** LangGraph `Send` 会复制/序列化 state，LanguageModel 实例会丢方法 → generateText 报 doGenerate is not a function；只存可序列化 id，在节点内再解析。 */
const WorldForgeGraphState = Annotation.Root({
  workflowProfile: Annotation<WorldForgeProfile>(),
  worldName: Annotation<string>(),
  brief: Annotation<string>(),
  currentCanonicalJson: Annotation<string | null>(),
  latestBlock: Annotation<string>(),
  maxReviewRounds: Annotation<number>(),
  withLastDraftOnFail: Annotation<boolean>(),
  mergeWithLatest: Annotation<boolean>(),
  provider: Annotation<string>(),
  modelId: Annotation<string>(),
  incrementTarget: Annotation<WorldForgeIncrementTarget>(),
  characterOnlyMode: Annotation<boolean>(),
  expandAttempt: Annotation<number>({
    reducer: (_prev, next) => next,
  }),
  summaryText: Annotation<string | undefined>(),
  graphBlueprint: Annotation<WorldForgeGraphBlueprint | undefined>(),
  architectOutput: Annotation<string | undefined>(),
  mechanistOutput: Annotation<string | undefined>(),
  characterDesignerOutput: Annotation<string | undefined>(),
  reviewFeedbackBlock: Annotation<string | undefined>(),
  normalizedJson: Annotation<string | undefined>(),
  validated: Annotation<Extract<ValidateResult, { ok: true }> | undefined>(),
  steps: Annotation<WorldForgeStepRecord[]>({
    reducer: (left, right) => [...left, ...right],
    default: () => [],
  }),
  pipelineError: Annotation<string | undefined>(),
  pipelineErrors: Annotation<string[] | undefined>(),
  lastIssues: Annotation<string[] | undefined>(),
  finished: Annotation<boolean>(),
  success: Annotation<boolean>(),
});

type UState = typeof WorldForgeGraphState.State;

function wfModel(state: UState) {
  return getLanguageModelForProvider(state.provider, state.modelId);
}

/** 并行轨节点禁止写 pipelineError/finished/success（LastValue 同一 super-step 只能写一次） */
function formatParallelTrackFailures(steps: WorldForgeStepRecord[]): string {
  const lines: string[] = [];
  for (const s of steps) {
    if (s.id === "architect_a2a" && !s.ok) {
      lines.push(`架构师：${s.error}`);
    }
    if (s.id === "mechanist_a2a" && !s.ok) {
      lines.push(`机制设计师：${s.error}`);
    }
    if (s.id === "character_designer_a2a" && !s.ok) {
      lines.push(`人物卡设计师：${s.error}`);
    }
  }
  return lines.join("；");
}

export const WORLD_FORGE_STEP_LABEL: Record<WorldForgeStepRecord["id"], string> =
  {
    parse_summary: "解析员 · 摘要",
    graph_blueprint: "图谱 · 实体/关系/缺口",
    expand_canonical: "扩写 · Canonical",
    architect_a2a: "架构师（并行轨）",
    mechanist_a2a: "机制设计师（并行轨）",
    character_designer_a2a: "人物卡设计师（并行轨）",
    synthesize_merge: "合成 · 合并并行轨",
    review: "审查员",
  };

export type WorldForgeProgressEvent = {
  type: "step";
  id: WorldForgeStepRecord["id"];
  ok: boolean;
  index: number;
  label: string;
};

async function nodeParse(state: UState): Promise<Partial<UState>> {
  if (state.incrementTarget !== "none") {
    return {
      summaryText:
        `增量模式：${state.incrementTarget}。\n` +
        `按增量策略处理，不走图谱与并行三轨。`,
      steps: [
        {
          id: "parse_summary",
          ok: true as const,
          summary: `增量模式：${state.incrementTarget}（跳过模型解析）`,
        },
      ],
    };
  }
  const r = await wfRunParseStep({
    model: wfModel(state),
    worldName: state.worldName,
    brief: state.brief,
  });
  if (!r.ok) {
    return {
      steps: [{ id: "parse_summary", ok: false as const, error: r.error }],
      pipelineError: `解析步骤失败：${r.error}`,
      finished: true,
      success: false,
    };
  }
  return {
    summaryText: r.summary,
    steps: [{ id: "parse_summary", ok: true as const, summary: r.summary }],
  };
}

async function nodeGraphBlueprint(state: UState): Promise<Partial<UState>> {
  const summary = state.summaryText;
  if (!summary) {
    return {
      steps: [
        {
          id: "graph_blueprint",
          ok: false as const,
          error: "缺少解析摘要。",
        },
      ],
      pipelineError: "图谱节点输入不完整。",
      finished: true,
      success: false,
    };
  }
  const r = await runWorldForgeGraphBlueprintStep({
    model: wfModel(state),
    worldName: state.worldName,
    brief: state.brief,
    summaryText: summary,
  });
  if (!r.ok) {
    return {
      steps: [{ id: "graph_blueprint", ok: false as const, error: r.error }],
      pipelineError: `图谱步骤失败：${r.error}`,
      finished: true,
      success: false,
    };
  }
  const bp = r.blueprint;
  return {
    graphBlueprint: bp,
    steps: [
      {
        id: "graph_blueprint",
        ok: true as const,
        entityCount: bp.entities.length,
        relationCount: bp.relations.length,
        gapCount: bp.gaps.length,
      },
    ],
  };
}

async function nodeArchitect(state: UState): Promise<Partial<UState>> {
  const summary = state.summaryText;
  if (!summary) {
    return {
      steps: [
        {
          id: "architect_a2a",
          ok: false as const,
          error: "缺少解析摘要。",
        },
      ],
    };
  }
  const graphBlock = formatGraphBlueprintForPrompt(state.graphBlueprint);
  try {
    const out = await generateText({
      model: wfModel(state),
      system: ARCHITECT_SYSTEM,
      prompt:
        `【世界名称】${state.worldName}\n\n` +
        `【用户大纲】\n${wfTruncateUtf8(state.brief, 16_000)}\n\n` +
        `【解析摘要】\n${wfTruncateUtf8(summary, 8_000)}\n` +
        state.latestBlock +
        graphBlock,
      maxOutputTokens: 3072,
      temperature: 0.4,
    });
    const text = out.text.trim();
    if (!text) {
      return {
        steps: [
          { id: "architect_a2a", ok: false as const, error: "架构师输出为空。" },
        ],
      };
    }
    return {
      architectOutput: text,
      steps: [
        {
          id: "architect_a2a",
          ok: true as const,
          excerpt: text.slice(0, 280),
        },
      ],
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      steps: [{ id: "architect_a2a", ok: false as const, error: msg }],
    };
  }
}

async function nodeMechanist(state: UState): Promise<Partial<UState>> {
  const summary = state.summaryText;
  if (!summary) {
    return {
      steps: [
        {
          id: "mechanist_a2a",
          ok: false as const,
          error: "缺少解析摘要。",
        },
      ],
    };
  }
  const graphBlock = formatGraphBlueprintForPrompt(state.graphBlueprint);
  try {
    const out = await generateText({
      model: wfModel(state),
      system: MECHANIST_SYSTEM_PARALLEL,
      prompt:
        `【世界名称】${state.worldName}\n\n` +
        `【用户大纲（片段）】\n${wfTruncateUtf8(state.brief, 12_000)}\n\n` +
        `【解析摘要（片段）】\n${wfTruncateUtf8(summary, 6_000)}\n` +
        state.latestBlock +
        graphBlock +
        `\n（提醒：你与架构师**并行**成稿，请勿假设已读对方正文。）\n`,
      maxOutputTokens: 3072,
      temperature: 0.35,
    });
    const text = out.text.trim();
    if (!text) {
      return {
        steps: [
          {
            id: "mechanist_a2a",
            ok: false as const,
            error: "机制设计师输出为空。",
          },
        ],
      };
    }
    return {
      mechanistOutput: text,
      steps: [
        {
          id: "mechanist_a2a",
          ok: true as const,
          excerpt: text.slice(0, 280),
          note: "并行轨，未读架构师成稿。",
        },
      ],
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      steps: [{ id: "mechanist_a2a", ok: false as const, error: msg }],
    };
  }
}

async function nodeCharacterDesigner(state: UState): Promise<Partial<UState>> {
  const summary = state.summaryText;
  if (!summary) {
    return {
      steps: [
        {
          id: "character_designer_a2a",
          ok: false as const,
          error: "缺少解析摘要。",
        },
      ],
    };
  }
  const graphBlock = formatGraphBlueprintForPrompt(state.graphBlueprint);
  try {
    const out = await generateText({
      model: wfModel(state),
      system: CHARACTER_DESIGNER_SYSTEM_PARALLEL,
      prompt:
        `【世界名称】${state.worldName}\n\n` +
        `【用户大纲（片段）】\n${wfTruncateUtf8(state.brief, 12_000)}\n\n` +
        `【解析摘要（片段）】\n${wfTruncateUtf8(summary, 6_000)}\n` +
        state.latestBlock +
        graphBlock +
        `\n（提醒：你与架构师/机制设计师**并行**成稿，请勿假设已读对方正文。）\n`,
      maxOutputTokens: 3072,
      temperature: 0.35,
    });
    const text = out.text.trim();
    if (!text) {
      return {
        steps: [
          {
            id: "character_designer_a2a",
            ok: false as const,
            error: "人物卡设计师输出为空。",
          },
        ],
      };
    }
    return {
      characterDesignerOutput: text,
      steps: [
        {
          id: "character_designer_a2a",
          ok: true as const,
          excerpt: text.slice(0, 280),
          note: "并行轨，未读架构师/机制师成稿。",
        },
      ],
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      steps: [{ id: "character_designer_a2a", ok: false as const, error: msg }],
    };
  }
}

async function nodeSynthesize(state: UState): Promise<Partial<UState>> {
  const summary = state.summaryText;
  const char = state.characterDesignerOutput;
  if (!summary || !char) {
    const detail = formatParallelTrackFailures(state.steps ?? []);
    return {
      steps: [
        {
          id: "synthesize_merge",
          ok: false as const,
          error: "缺少并行轨草稿（架构师/机制师/人物卡设计师）。",
        },
      ],
      pipelineError:
        detail || "合成节点输入不完整（并行轨未全部成功）。",
      finished: true,
      success: false,
    };
  }
  if (state.characterOnlyMode) {
    if (!state.currentCanonicalJson?.trim()) {
      return {
        steps: [
          {
            id: "synthesize_merge",
            ok: false as const,
            error: "角色增量模式需要当前已保存 Canonical。",
          },
        ],
        pipelineError: "角色增量合成失败：缺少当前 Canonical 快照。",
        finished: true,
        success: false,
      };
    }
    const base = parseAndValidateCanonicalWorld(state.currentCanonicalJson);
    if (!base.ok) {
      return {
        steps: [
          {
            id: "synthesize_merge",
            ok: false as const,
            error: "当前 Canonical 校验失败，无法执行角色增量合并。",
            errors: base.errors,
          },
        ],
        pipelineError: "角色增量合成失败：当前 Canonical 非法。",
        pipelineErrors: base.errors,
        finished: true,
        success: false,
      };
    }
    const patchResult = await generateCharacterIncrementPatch({
      model: wfModel(state),
      worldName: state.worldName,
      brief: state.brief,
      currentCanonicalJson: base.normalizedJson,
      characterDesignerOutput: char,
    });
    if (!patchResult.ok) {
      return {
        steps: [
          {
            id: "synthesize_merge",
            ok: false as const,
            error: patchResult.error,
            errors: patchResult.errors,
          },
        ],
        pipelineError: `角色增量合成失败：${patchResult.error}`,
        pipelineErrors: patchResult.errors,
        finished: true,
        success: false,
      };
    }
    const merged = mergeCharacterPatchIntoCanonical(base.canonical, patchResult.patch);
    const validatedMerged = parseAndValidateCanonicalWorld(JSON.stringify(merged));
    if (!validatedMerged.ok) {
      return {
        steps: [
          {
            id: "synthesize_merge",
            ok: false as const,
            error: "角色增量本地合并后校验失败。",
            errors: validatedMerged.errors,
          },
        ],
        pipelineError: "角色增量合成失败：本地合并校验未通过。",
        pipelineErrors: validatedMerged.errors,
        finished: true,
        success: false,
      };
    }
    return {
      normalizedJson: validatedMerged.normalizedJson,
      validated: validatedMerged,
      expandAttempt: 1,
      steps: [
        {
          id: "synthesize_merge",
          ok: true as const,
          note: "已走角色增量轻量路径（仅生成人物片段，由服务端本地合并）。",
        },
      ],
    };
  }
  const arch = state.architectOutput;
  const mech = state.mechanistOutput;
  if (!arch || !mech) {
    const detail = formatParallelTrackFailures(state.steps ?? []);
    return {
      steps: [
        {
          id: "synthesize_merge",
          ok: false as const,
          error: "缺少并行轨草稿（架构师/机制师/人物卡设计师）。",
        },
      ],
      pipelineError:
        detail || "合成节点输入不完整（并行轨未全部成功）。",
      finished: true,
      success: false,
    };
  }
  const userPrompt = buildSynthesizeUserPrompt({
    worldName: state.worldName,
    brief: state.brief,
    summaryText: summary,
    latestBlock: state.latestBlock,
    architectOutput: arch,
    mechanistOutput: mech,
    characterDesignerOutput: char,
  });
  const expanded = await wfRunExpandStep({
    model: wfModel(state),
    mergeWithLatest: state.mergeWithLatest,
    wfLabel:
      state.workflowProfile === "wf3" ? "WF-3·并行合成" : "WF-2·并行合成",
    userPrompt,
    objectSchemaName: "canonical_world_forge_wf2_synthesize",
    objectDescription:
      "Merged Canonical from parallel architect + mechanist + character_designer drafts for WorldForge",
  });
  if (!expanded.ok) {
    const shouldRetryWithCompactPrompt =
      expanded.error.includes("文本回退：未能从模型输出中解析出 JSON 对象") ||
      expanded.error.includes("JSON");
    if (shouldRetryWithCompactPrompt) {
      const retryPrompt = buildSynthesizeCompactUserPrompt({
        worldName: state.worldName,
        brief: state.brief,
        summaryText: summary,
        latestBlock: state.latestBlock,
        architectOutput: arch,
        mechanistOutput: mech,
        characterDesignerOutput: char,
      });
      const retried = await wfRunExpandStep({
        model: wfModel(state),
        mergeWithLatest: state.mergeWithLatest,
        wfLabel:
          state.workflowProfile === "wf3"
            ? "WF-3·并行合成·重试(压缩)"
            : "WF-2·并行合成·重试(压缩)",
        userPrompt: retryPrompt,
        objectSchemaName: "canonical_world_forge_wf2_synthesize_retry_compact",
        objectDescription:
          "Merged Canonical retry with compact prompt from parallel tracks",
      });
      if (retried.ok) {
        return {
          normalizedJson: retried.validated.normalizedJson,
          validated: retried.validated,
          expandAttempt: 1,
          steps: [
            {
              id: "synthesize_merge",
              ok: true as const,
              note: "并行合成首轮失败，已用压缩提示重试并通过。",
            },
          ],
        };
      }
    }
    return {
      steps: [
        {
          id: "synthesize_merge",
          ok: false as const,
          error: expanded.error,
          errors: expanded.errors,
        },
      ],
      pipelineError: `并行合成/校验失败：${expanded.error}`,
      pipelineErrors: expanded.errors,
      finished: true,
      success: false,
    };
  }
  return {
    normalizedJson: expanded.validated.normalizedJson,
    validated: expanded.validated,
    expandAttempt: 1,
    steps: [
      {
        id: "synthesize_merge",
        ok: true as const,
        note: "并行多轨草稿已扇入合并为 Canonical，进入审查。",
      },
    ],
  };
}

async function nodeExpand(state: UState): Promise<Partial<UState>> {
  const summary = state.summaryText;
  if (!summary) {
    return {
      pipelineError: "内部错误：缺少解析摘要。",
      finished: true,
      success: false,
    };
  }
  if (
    state.incrementTarget === "none" &&
    (state.workflowProfile === "wf2" || state.workflowProfile === "wf3") &&
    !state.normalizedJson &&
    !state.reviewFeedbackBlock
  ) {
    return {
      pipelineError: "内部错误：WF-2/WF-3 不应在无合成结果时进入扩写修订。",
      finished: true,
      success: false,
    };
  }
  const userPrompt = wfBuildExpandUserPrompt({
    worldName: state.worldName,
    brief: state.brief,
    summaryText: summary,
    latestBlock: state.latestBlock,
    reviewFeedbackBlock: state.reviewFeedbackBlock,
  });
  const attempt = state.expandAttempt;
  const label =
    state.workflowProfile === "wf0"
      ? "WF-0"
      : state.workflowProfile === "wf1"
        ? "WF-1"
        : state.workflowProfile === "wf3"
          ? "WF-3·修订"
          : "WF-2·修订";
  const expanded = await wfRunExpandStep({
    model: wfModel(state),
    mergeWithLatest: state.mergeWithLatest,
    wfLabel: label,
    userPrompt,
    objectSchemaName: "canonical_world_forge_unified_expand",
    objectDescription: "WorldForge unified expand or revise step",
  });
  if (!expanded.ok) {
    return {
      steps: [
        {
          id: "expand_canonical",
          ok: false as const,
          attempt,
          error: expanded.error,
          errors: expanded.errors,
        },
      ],
      pipelineError: `第 ${attempt} 轮扩写/校验失败：${expanded.error}`,
      pipelineErrors: expanded.errors,
      finished: true,
      success: false,
    };
  }
  const base: Partial<UState> = {
    normalizedJson: expanded.validated.normalizedJson,
    validated: expanded.validated,
    steps: [
      {
        id: "expand_canonical",
        ok: true as const,
        attempt,
        note:
          state.workflowProfile === "wf0"
            ? "WF-0：单次扩写完成。"
            : attempt === 1 && !state.reviewFeedbackBlock
              ? "已通过 Canonical 校验，进入审查。"
              : "已根据审查意见修订并通过校验。",
      },
    ],
  };
  if (state.workflowProfile === "wf0") {
    return {
      ...base,
      finished: true,
      success: true,
    };
  }
  return base;
}

async function nodeReview(state: UState): Promise<Partial<UState>> {
  const summary = state.summaryText;
  const json = state.normalizedJson;
  if (!summary || !json) {
    return {
      steps: [
        {
          id: "review",
          ok: false as const,
          attempt: state.expandAttempt,
          error: "内部错误：缺少摘要或 Canonical。",
        },
      ],
      pipelineError: "审查步骤输入不完整。",
      finished: true,
      success: false,
    };
  }
  const attempt = state.expandAttempt;
  const verdict = await runWorldForgeReviewStep({
    model: wfModel(state),
    worldName: state.worldName,
    brief: state.brief,
    summaryText: summary,
    normalizedJson: json,
    attempt,
  });

  if (!verdict.ok) {
    return {
      steps: [
        {
          id: "review",
          ok: false as const,
          attempt,
          error: verdict.error,
        },
      ],
      pipelineError: `第 ${attempt} 轮审查失败：${verdict.error}`,
      finished: true,
      success: false,
    };
  }

  if (verdict.passed) {
    return {
      steps: [
        {
          id: "review",
          ok: true as const,
          attempt,
          passed: true,
        },
      ],
      lastIssues: [],
      finished: true,
      success: true,
    };
  }

  if (attempt >= state.maxReviewRounds) {
    return {
      steps: [
        {
          id: "review",
          ok: true as const,
          attempt,
          passed: false,
          issues: verdict.issues,
          rewriteHints: verdict.rewriteHints,
          note:
            "已达最大审查轮次：已按最佳努力采纳当前 Canonical（含 world_book / character_books）；残余问题可后续版本打补丁。",
        },
      ],
      lastIssues: verdict.issues,
      finished: true,
      success: true,
    };
  }

  return {
    steps: [
      {
        id: "review",
        ok: true as const,
        attempt,
        passed: false,
        issues: verdict.issues,
        rewriteHints: verdict.rewriteHints,
      },
    ],
    reviewFeedbackBlock: formatWorldForgeReviewFeedback(verdict),
    expandAttempt: attempt + 1,
    lastIssues: verdict.issues,
  };
}

function parallelFanOut(s: UState): [
  Send<"architect", UState>,
  Send<"mechanist", UState>,
  Send<"character_designer", UState>,
] {
  return [
    new Send("architect", s),
    new Send("mechanist", s),
    new Send("character_designer", s),
  ];
}

function characterOnlyFanOut(s: UState): [Send<"character_designer", UState>] {
  return [new Send("character_designer", s)];
}

function routeAfterParse(
  s: UState
):
  | typeof END
  | "expand"
  | "graph"
  | [Send<"character_designer", UState>]
  | [
      Send<"architect", UState>,
      Send<"mechanist", UState>,
      Send<"character_designer", UState>,
    ] {
  if (s.finished) return END;
  if (s.incrementTarget === "character") return characterOnlyFanOut(s);
  if (s.incrementTarget === "location" || s.incrementTarget === "organization") {
    return "expand";
  }
  if (s.characterOnlyMode) return characterOnlyFanOut(s);
  if (s.workflowProfile === "wf3") return "graph";
  if (s.workflowProfile === "wf2") return parallelFanOut(s);
  return "expand";
}

function routeAfterGraph(
  s: UState
):
  | typeof END
  | [
      Send<"architect", UState>,
      Send<"mechanist", UState>,
      Send<"character_designer", UState>,
    ] {
  if (s.finished) return END;
  return parallelFanOut(s);
}

function routeAfterExpand(s: UState): typeof END | "review" {
  if (s.finished) return END;
  if (s.workflowProfile === "wf0") return END;
  return "review";
}

function routeAfterSynthesize(s: UState): typeof END | "review" {
  return s.finished ? END : "review";
}

function routeAfterReview(s: UState): typeof END | "expand" {
  return s.finished ? END : "expand";
}

function buildUnifiedWorldForgeGraph() {
  /** `Send` 扇出不会生成静态边，须在源节点声明 `ends`，否则 compile 报 UNREACHABLE_NODE */
  const fanOutEnds = [
    "architect",
    "mechanist",
    "character_designer",
    "expand",
    "graph",
    END,
  ] as const;

  return new StateGraph(WorldForgeGraphState)
    .addNode("parse", nodeParse, { ends: [...fanOutEnds] })
    .addNode("graph", nodeGraphBlueprint, {
      ends: ["architect", "mechanist", "character_designer", END],
    })
    .addNode("architect", nodeArchitect)
    .addNode("mechanist", nodeMechanist)
    .addNode("character_designer", nodeCharacterDesigner)
    .addNode("synthesize", nodeSynthesize)
    .addNode("expand", nodeExpand)
    .addNode("review", nodeReview)
    .addEdge(START, "parse")
    .addConditionalEdges("parse", routeAfterParse, {
      [END]: END,
      expand: "expand",
      graph: "graph",
    })
    .addConditionalEdges("graph", routeAfterGraph, {
      [END]: END,
    })
    .addEdge("architect", "synthesize")
    .addEdge("mechanist", "synthesize")
    .addEdge("character_designer", "synthesize")
    .addConditionalEdges("expand", routeAfterExpand, {
      [END]: END,
      review: "review",
    })
    .addConditionalEdges("synthesize", routeAfterSynthesize, {
      [END]: END,
      review: "review",
    })
    .addConditionalEdges("review", routeAfterReview, {
      [END]: END,
      expand: "expand",
    });
}

let compiledUnified: ReturnType<
  ReturnType<typeof buildUnifiedWorldForgeGraph>["compile"]
> | null = null;

/** state 结构或节点变更时递增，避免 dev 热更新仍持有旧 CompiledGraph */
const UNIFIED_GRAPH_REVISION = 8;

function getCompiledUnifiedGraph() {
  const g = globalThis as unknown as {
    __cwWorldForgeGraphRev?: number;
    __cwWorldForgeCompiled?: typeof compiledUnified;
  };
  if (
    !g.__cwWorldForgeCompiled ||
    g.__cwWorldForgeGraphRev !== UNIFIED_GRAPH_REVISION
  ) {
    g.__cwWorldForgeCompiled = buildUnifiedWorldForgeGraph().compile();
    g.__cwWorldForgeGraphRev = UNIFIED_GRAPH_REVISION;
  }
  compiledUnified = g.__cwWorldForgeCompiled;
  return compiledUnified;
}

export type InvokeWorldForgeUnifiedInput = {
  profile: WorldForgeProfile;
  incrementTarget?: WorldForgeIncrementTarget;
  worldName: string;
  brief: string;
  currentCanonicalJson?: string | null;
  mergeWithLatest: boolean;
  latestBlock: string;
  maxReviewRounds: number;
  withLastDraftOnFail: boolean;
  provider: string;
  modelId: string;
};

function buildInitialState(input: InvokeWorldForgeUnifiedInput): UState {
  const incrementTarget = input.incrementTarget ?? "none";
  const hasLatestContext =
    input.mergeWithLatest && input.latestBlock.trim().length > 0;
  const autoCharacterOnly = hasLatestContext && isCharacterIncrementBrief(input.brief);
  const characterOnlyMode = incrementTarget === "character" || autoCharacterOnly;
  const normalizedIncrementTarget: WorldForgeIncrementTarget =
    incrementTarget !== "none"
      ? incrementTarget
      : autoCharacterOnly
        ? "character"
        : hasLatestContext && isLocationIncrementBrief(input.brief)
          ? "location"
          : hasLatestContext && isOrganizationIncrementBrief(input.brief)
            ? "organization"
            : "none";
  return {
    workflowProfile: input.profile,
    worldName: input.worldName,
    brief: input.brief,
    currentCanonicalJson: input.currentCanonicalJson ?? null,
    latestBlock: input.latestBlock,
    maxReviewRounds: input.maxReviewRounds,
    withLastDraftOnFail: input.withLastDraftOnFail,
    mergeWithLatest: input.mergeWithLatest,
    provider: input.provider,
    modelId: input.modelId,
    incrementTarget: normalizedIncrementTarget,
    characterOnlyMode,
    expandAttempt: 1,
    summaryText: undefined,
    graphBlueprint: undefined,
    architectOutput: undefined,
    mechanistOutput: undefined,
    characterDesignerOutput: undefined,
    reviewFeedbackBlock: undefined,
    normalizedJson: undefined,
    validated: undefined,
    steps: [],
    pipelineError: undefined,
    pipelineErrors: undefined,
    lastIssues: undefined,
    finished: false,
    success: false,
  };
}

function finalizeWorldForgeResult(
  finalState: UState,
  input: InvokeWorldForgeUnifiedInput
): WorldForgePipelineResult {
  const steps = finalState.steps ?? [];
  const profile = input.profile;

  if (
    finalState.success &&
    finalState.validated &&
    finalState.normalizedJson
  ) {
    const warnings =
      finalState.lastIssues && finalState.lastIssues.length > 0
        ? finalState.lastIssues
        : undefined;
    const out: WorldForgePipelineSuccess = {
      ok: true,
      profile,
      steps,
      validated: finalState.validated,
      normalizedJson: finalState.normalizedJson,
      reviewRoundsUsed: finalState.expandAttempt,
      ...(profile === "wf3" && finalState.graphBlueprint
        ? { graphBlueprint: finalState.graphBlueprint }
        : {}),
      ...(warnings ? { reviewWarnings: warnings } : {}),
    };
    return out;
  }

  const fail: WorldForgePipelineFailure = {
    ok: false,
    profile,
    steps,
    error: finalState.pipelineError ?? "WorldForge 工作流未完成。",
    errors: finalState.pipelineErrors,
    lastReviewIssues: finalState.lastIssues,
    ...(input.withLastDraftOnFail && finalState.normalizedJson
      ? { lastNormalizedJson: finalState.normalizedJson }
      : {}),
  };
  return fail;
}

export async function invokeWorldForgeUnifiedLangGraph(
  input: InvokeWorldForgeUnifiedInput
): Promise<WorldForgePipelineResult> {
  const finalState = (await getCompiledUnifiedGraph().invoke(
    buildInitialState(input)
  )) as UState;
  return finalizeWorldForgeResult(finalState, input);
}

/**
 * 与 invoke 相同执行路径，但用 streamMode values 推送「新出现的步骤」便于 UI 实时展示。
 */
export async function invokeWorldForgeUnifiedLangGraphWithProgress(
  input: InvokeWorldForgeUnifiedInput,
  onProgress: (e: WorldForgeProgressEvent) => void
): Promise<WorldForgePipelineResult> {
  const graph = getCompiledUnifiedGraph();
  const initial = buildInitialState(input);
  let lastState: UState | null = null;
  let prevStepLen = 0;
  const stream = await graph.stream(initial, { streamMode: "values" });
  for await (const snapshot of stream) {
    lastState = snapshot as UState;
    const steps = lastState.steps ?? [];
    for (let i = prevStepLen; i < steps.length; i++) {
      const rec = steps[i]!;
      onProgress({
        type: "step",
        id: rec.id,
        ok: rec.ok,
        index: i,
        label: WORLD_FORGE_STEP_LABEL[rec.id] ?? rec.id,
      });
    }
    prevStepLen = steps.length;
  }
  if (!lastState) {
    return {
      ok: false,
      profile: input.profile,
      steps: [],
      error: "流水线未产生任何状态（stream 为空）。",
    };
  }
  return finalizeWorldForgeResult(lastState, input);
}
