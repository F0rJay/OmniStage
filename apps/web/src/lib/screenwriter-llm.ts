import type { ModelMessage } from "ai";
import { formatWorldContextForPrompt, streamRawCompletion } from "@/lib/llm";

export const SCREENWRITER_BASE_SYSTEM = `你是 CanonWeave 的**世界书编剧顾问**，通过多轮对话帮用户做**深度定制**：梳理势力与人物、补全矛盾与规则、推敲时间线与伏笔、统一称谓与禁忌。

原则：
- 用清晰小节或列表回复，便于用户复制到正式设定里；语气专业、友好。
- **不要**假装已经改写了数据库。用户可在界面点击「将对话合并为新版本」把当前对话与已有设定合并写入新版本；也可使用「导入世界书」或版本页管理。
- 若当前已有 Canonical 快照，请在此基础上扩展或质疑矛盾，避免无依据吃书。
- 回复使用简体中文，除非用户明确要求其他语言。`;

const SCRATCH_CREATION_HINT = `

【新建模式】用户刚通过「新建世界」进入，**还没有任何已保存版本**。请主动、分步引导共创：题材与基调、地理/时代感、主要矛盾、2～3 个关键势力或人物雏形、至少一条核心规则或禁忌。每轮不要一次问太多问题。提醒用户对话满意后点击「将对话合并为新版本」生成首版 Canonical JSON。`;

export function buildScreenwriterSystemPrompt(input: {
  worldName: string;
  latestVersion: { version: number; canonical_json: string } | null;
  /** 与 URL ?new=1 对应：从零共创世界书 */
  scratchCreation?: boolean;
}): string {
  const block = input.latestVersion
    ? formatWorldContextForPrompt(
        input.worldName,
        input.latestVersion.version,
        input.latestVersion.canonical_json
      )
    : `【当前世界】${input.worldName}\n当前**尚无已保存的 Canonical 版本**。你可协助用户从零搭建结构（如 meta、entities、rules、timeline 等），并提醒其使用「将对话合并为新版本」写入首版。`;

  let tail = "";
  if (input.scratchCreation && !input.latestVersion) {
    tail = SCRATCH_CREATION_HINT;
  }

  return `${SCREENWRITER_BASE_SYSTEM}\n\n---\n${block}${tail}`;
}

export function streamScreenwriterCompletion(input: {
  provider: string;
  modelId: string;
  messages: ModelMessage[];
  worldName: string;
  latestVersion: { version: number; canonical_json: string } | null;
  scratchCreation?: boolean;
}) {
  const system = buildScreenwriterSystemPrompt({
    worldName: input.worldName,
    latestVersion: input.latestVersion,
    scratchCreation: input.scratchCreation,
  });
  return streamRawCompletion({
    provider: input.provider,
    modelId: input.modelId,
    system,
    messages: input.messages,
    maxOutputTokens: 4096,
  });
}
