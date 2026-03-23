import "server-only";

import { generateText } from "ai";
import type { LanguageModel } from "ai";
import { extractJsonObjectFromModelOutput } from "@/lib/world-import-agent";
import { wfTruncateUtf8 } from "@/lib/world-forge-shared";

/** 交给审查员的 Canonical 最大字符数（控制成本） */
export const WF_REVIEW_MAX_CANONICAL_CHARS = 48_000;

export const WF_REVIEWER_SYSTEM = `你是 CanonWeave **WorldForge 审查员**（A2A 工作流下游）。你的职责是**对抗式一致性审查**（不是润色文笔），但须与**产品策略**一致：**不要为追求完美而卡死流水线**——用户可在后续版本**打补丁**。

你会收到：世界名称、用户原始大纲（可能截断）、解析摘要（可能截断）、以及当前候选 **Canonical JSON**（可能截断）。

**通过阈值（重要）**
- **优先判 \`passed: true\`**：只要不是**严重影响体验或严重逻辑不通**的问题，一律放行。轻微笔误、措辞冗余、某条目略单薄、势力关系未写全等，**不要**因此判 false。
- **时间线 / 地点 / 剧情先后**：若存在**轻度**前后矛盾（例如角色 \`scenario\` 写「去 A 地」而 \`timeline\` 写「在 B 地起步」），**不要**要求用户当场二选一卡死；**判 passed:true** 即可（若愿意可在脑内假定保留其中一条叙事线，无需写入 issues）。**仅当**时间线矛盾导致**无法理解故事从哪开始**或与世界核心 rules **根本冲突**时，才考虑 \`passed: false\`。
- **world_book 与 rules 的扩展性**：若 world_book 描述了 rules 尚未逐字覆盖的机制（如额外合法途径），视为**可补丁的扩展**，除非与 locks 或用户大纲硬性锚点**直接冲突**，否则**倾向 passed:true**。
- **仅当**以下情况才应 **\`passed: false\`**：与 \`locks\` **冲突**；核心力量体系**完全无边界/无代价**且大纲明确要求硬核；JSON **结构或字段**导致无法安全使用；**致命**自相矛盾（不是轻微不一致）。

请仍浏览以下维度，但**多数问题只作为你内心检查**，不必因此判 false：
1. **逻辑矛盾**：rules 与 lore / timeline / entities 是否**严重**冲突。
2. **力量/规则平衡**：**明显**无代价过强、破坏可玩性时才算问题。
3. **与 locks 冲突**：若 JSON 中 \`locks\` 有内容，**不得**建议删除这些锚点；若其它部分与 locks 矛盾，须 **passed:false** 或明确写进 issues。
4. **完整性**：meta.title 空泛、关键数组空壳——**轻度**则放行。
5. **世界书本体 \`world_book\`**  
   - 条目是否大致支撑世界叙事；与 rules/timeline 的**明显**矛盾才判 false。  
   - 触发字段不合理、constant 略多等**轻微**问题：放行。  
   - 分层错误（把全局设定塞进单角色私设）**严重**时才 false。  
   - 缺失 world_book 但大纲需要：若已有不少内容在其它字段，**可放行**并倾向 true。
6. **人物书 \`character_books\`**  
   - 须有 \`character_card\` 且核心字段**大致可扮演**；**完全空壳**才 false。  
   - 与 world_book 的**轻微**重复或细枝末节不一致：放行。

**审查优先级说明**：人物书与世界书仍须**都扫一眼**，但**判 false 要克制**。

**输出要求**：只输出**一个** JSON 对象，不要 Markdown 围栏，不要其它文字。格式严格为：
{"passed": true}
或
{"passed": false, "issues": ["具体问题1", "具体问题2"], "rewrite_hints": "给扩写模型的一段简短总述（可选，字符串）"}

- \`issues\` 至少 1 条当 passed 为 false；应可执行、指向明确。
- **轻微问题不要列进 issues 来逼 false**；若已整体可交付，直接 \`{"passed": true}\`。`;

export type ReviewVerdict =
  | { ok: true; passed: true }
  | { ok: true; passed: false; issues: string[]; rewriteHints?: string }
  | { ok: false; error: string };

export function formatWorldForgeReviewFeedback(
  v: Extract<ReviewVerdict, { passed: false }>
): string {
  const lines = v.issues.map((x, i) => `${i + 1}. ${x}`);
  const hints = v.rewriteHints?.trim();
  return (
    lines.join("\n") +
    (hints ? `\n\n【综合改写提示】\n${hints}` : "")
  );
}

export async function runWorldForgeReviewStep(input: {
  model: LanguageModel;
  worldName: string;
  brief: string;
  summaryText: string;
  normalizedJson: string;
  attempt: number;
}): Promise<ReviewVerdict> {
  let canon = input.normalizedJson.trim();
  if (canon.length > WF_REVIEW_MAX_CANONICAL_CHARS) {
    canon =
      canon.slice(0, WF_REVIEW_MAX_CANONICAL_CHARS) +
      "\n…[Canonical 已截断供审查；请勿因截断本身判失败]";
  }
  const briefSnippet = wfTruncateUtf8(input.brief, 12_000);
  const summarySnippet = wfTruncateUtf8(input.summaryText, 8_000);

  const userPrompt =
    `【世界名称】${input.worldName}\n` +
    `【扩写轮次】第 ${input.attempt} 轮候选\n\n` +
    `【用户原始大纲（片段）】\n${briefSnippet}\n\n` +
    `【解析摘要（片段）】\n${summarySnippet}\n\n` +
    `【候选 Canonical JSON】\n${canon}\n\n` +
    `请只输出 JSON 判决对象。`;

  try {
    const out = await generateText({
      model: input.model,
      system: WF_REVIEWER_SYSTEM,
      prompt: userPrompt,
      maxOutputTokens: 2048,
      temperature: 0.1,
    });
    const raw = out.text.trim();
    const parsed = extractJsonObjectFromModelOutput(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ok: false, error: "审查员输出无法解析为 JSON。" };
    }
    const o = parsed as Record<string, unknown>;
    const passed = o.passed === true;
    if (passed) {
      return { ok: true, passed: true };
    }
    if (o.passed === false) {
      const issuesRaw = o.issues;
      const issues: string[] = [];
      if (Array.isArray(issuesRaw)) {
        for (const x of issuesRaw) {
          if (typeof x === "string" && x.trim()) issues.push(x.trim());
        }
      }
      if (issues.length === 0) {
        return {
          ok: false,
          error: "审查判定不通过但未提供 issues 数组。",
        };
      }
      const rewriteHints =
        typeof o.rewrite_hints === "string"
          ? o.rewrite_hints.trim()
          : typeof o.rewriteHints === "string"
            ? o.rewriteHints.trim()
            : undefined;
      return { ok: true, passed: false, issues, rewriteHints };
    }
    return { ok: false, error: "审查 JSON 缺少合法 passed 字段。" };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: msg };
  }
}
