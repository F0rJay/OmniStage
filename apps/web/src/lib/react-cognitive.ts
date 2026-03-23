import "server-only";

/**
 * 酒馆 Agent（MCP 工具路径）的 ReAct 认知约束：Thought → Action → Observation → Thought。
 * 依赖模型在**每次工具调用前**输出以 `Thought:` 开头的可见正文；Observation 由工具结果注入对话，由模型在后续 `Thought:` 中承接。
 */
export function buildReactCognitiveSystemAppend(): string {
  return (
    "【ReAct 认知框架（强制 · 中文）】\n" +
    "你在调用任何工具（掷骰、读/写世界书）时，必须形成可追溯链条：\n\n" +
    "1) **Thought（推理）**：在**每一次**发起工具调用之前，先在正文中写出以 **`Thought:`** 开头的段落，说明：为何要调用工具、期望得到什么信息、与玩家上一句如何相关。\n" +
    "2) **Action（行动）**：随后由系统执行对应工具调用（你通过 function calling 发起即可）。\n" +
    "3) **Observation（观察）**：工具返回的结果会自动出现在上下文中；那就是本轮的 Observation，**禁止编造**未出现的数值或 JSON。\n" +
    "4) **Thought（再推理）**：在看到 Observation 之后、继续纯文本回复或**再次**调用工具之前，应再写一段以 **`Thought:`** 开头的内容，说明如何根据 Observation 推进叙事或是否还需要下一步工具。\n\n" +
    "**硬性规则**\n" +
    "- 禁止在**没有任何** `Thought:` 段落的情况下直接发起工具调用。\n" +
    "- 若本回合不需要任何工具，可直接叙事，不必写 Thought。\n" +
    "- `Thought:` 后接**完整一句或多句**，勿只写无意义占位词。\n\n" +
    "**示例（结构示意）**\n" +
    "Thought: 玩家要求进行敏捷检定，需先掷 d20 得出随机结果。\n" +
    "（随后调用 dice_roll）\n" +
    "……工具返回后……\n" +
    "Thought: 掷骰合计为 14，属中等偏上成功，据此描写动作结果而不改骰值。\n"
  );
}

export type ThoughtExtraction = {
  thought: string | null;
  compliant: boolean;
  /** 未命中 Thought: 时用于排障的尾部原文预览 */
  precedingTail: string;
};

/**
 * 从本步累计的正文里取出最后一次 `Thought:` 之后的内容（工具调用前一刻的缓冲区）。
 */
export function extractThoughtBeforeToolCall(buffer: string): ThoughtExtraction {
  const trimmed = buffer.trimEnd();
  const tail = trimmed.length > 280 ? trimmed.slice(-280) : trimmed;
  const lower = trimmed.toLowerCase();
  const idx = lower.lastIndexOf("thought:");
  if (idx === -1) {
    return { thought: null, compliant: false, precedingTail: tail };
  }
  const after = trimmed.slice(idx + "thought:".length).trim();
  if (!after) {
    return { thought: null, compliant: false, precedingTail: tail };
  }
  return { thought: after, compliant: true, precedingTail: tail };
}
