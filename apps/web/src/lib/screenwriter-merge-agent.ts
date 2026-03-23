import "server-only";

import {
  generateCanonicalDraftWithModel,
  type WorldImportAgentFailure,
  type WorldImportAgentSuccess,
} from "@/lib/world-import-agent";
import { getLanguageModelForProvider } from "@/lib/llm";

const MAX_TRANSCRIPT_BYTES = 96 * 1024;
const MAX_CANONICAL_SNIPPET_BYTES = 28 * 1024;

const MERGE_SYSTEM = `你是 CanonWeave 世界书**合并编排器**。你会收到：
1) 世界名称；
2)（可选）当前 Canonical JSON 快照（可能被截断）；
3) 用户与「编剧顾问」的多轮对话全文。

任务：根据对话里用户**明确提出的修改、新增、删除或重写**要求，输出**一份完整**的 Canonical 世界对象（顶层键：meta, entities, relations, rules, timeline, lore_entries, locks, warnings），结构与导入世界书时一致。

规则：
- **以当前快照为基底**做增量合并：未在对话中提及的部分尽量保留；若当前快照缺失某键，用合理默认（空数组或空 meta）。
- 若尚无快照（空白世界），则仅依据对话构建第一版设定。
- 落实用户要的剧情/设定变更：增删改实体、关系、规则、时间线、lore 等。
- **locks** 数组若已存在，一般保留；仅当用户对话明确要求解除或改写某条锁定时再调整。
- meta.title 若对话要求改名则更新；否则可保留原名与世界名一致。
- 不要输出 JSON 外的说明文字；键名英文小写+下划线风格；数组元素多为对象。`;

export async function mergeCanonicalFromScreenwriterDialogue(input: {
  worldName: string;
  /** 最新版本全文，若无版本则为 null */
  currentCanonicalJson: string | null;
  /** 格式化后的对话文本 */
  dialogueTranscript: string;
  provider: string;
  modelId: string;
}): Promise<WorldImportAgentSuccess | WorldImportAgentFailure> {
  const enc = new TextEncoder();
  let transcript = input.dialogueTranscript.trim();
  if (!transcript) {
    return { ok: false, error: "没有可用的对话记录；请先与编剧沟通修改需求。" };
  }
  if (enc.encode(transcript).length > MAX_TRANSCRIPT_BYTES) {
    transcript = truncateUtf8(transcript, MAX_TRANSCRIPT_BYTES);
    transcript += "\n\n…[对话已截断，仅保留靠前部分；若需大范围改写请分步进行]";
  }

  let canonicalBlock = "（当前尚无已保存的 Canonical 版本，请仅根据对话构建。）";
  if (input.currentCanonicalJson?.trim()) {
    let raw = input.currentCanonicalJson.trim();
    if (enc.encode(raw).length > MAX_CANONICAL_SNIPPET_BYTES) {
      raw = truncateUtf8(raw, MAX_CANONICAL_SNIPPET_BYTES);
      raw += "\n…[当前版本 JSON 已截断；合并时请优先落实对话中的明确指令，未展示部分在输出中尽量保持合理延续]";
    }
    canonicalBlock = `【当前 Canonical 快照】\n${raw}`;
  }

  let model;
  try {
    model = getLanguageModelForProvider(input.provider, input.modelId);
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : "模型不可用。",
    };
  }

  const merged = await generateCanonicalDraftWithModel({
    model,
    system: MERGE_SYSTEM,
    userPrompt:
      `【世界名称】${input.worldName}\n\n` +
      `${canonicalBlock}\n\n` +
      `【用户 ⟷ 编剧 对话】\n${transcript}\n\n` +
      `请输出合并后的完整 canonical 对象。`,
    maxOutputTokens: 8192,
    temperature: 0.15,
    objectGenMeta: {
      schemaName: "canonical_world_merge",
      schemaDescription:
        "Merged CanonWeave world after screenwriter dialogue; full meta + array fields",
    },
  });

  if (!merged.ok) {
    return {
      ok: false,
      error: `合并生成失败：${merged.error}`,
      errors: merged.errors,
    };
  }
  return merged;
}

function truncateUtf8(s: string, maxBytes: number): string {
  const enc = new TextEncoder();
  if (enc.encode(s).length <= maxBytes) return s;
  let lo = 0;
  let hi = s.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    const slice = s.slice(0, mid);
    if (enc.encode(slice).length <= maxBytes) lo = mid;
    else hi = mid - 1;
  }
  return s.slice(0, lo);
}
