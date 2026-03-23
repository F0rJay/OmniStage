import { randomInt } from "node:crypto";
import type { ModelMessage } from "ai";

export type DiceRollResult = {
  expression: string;
  count: number;
  sides: number;
  modifier: number;
  rolls: number[];
  total: number;
};

const MAX_DICE = 20;
const MAX_SIDES = 1000;

/**
 * 从首行 `/roll 2d6`、`/r d20+3` 提取表达式 `2d6` / `d20+3`（供内联掷骰或 MCP `dice_roll`）。
 */
export function extractDiceExpressionFromMessage(message: string): string | null {
  const firstLine = (message.split(/\r?\n/)[0] ?? "").trim();
  const m = firstLine.match(/^\/(?:roll|r)\s+((\d*)d(\d+)([+-]\d+)?)$/i);
  return m ? m[1] : null;
}

/** 解析 `NdM` / `dM` 与可选修正，密码学随机掷骰（内联实现）。 */
export function rollDiceFromExpression(expression: string): DiceRollResult | null {
  const m = expression.trim().match(/^(\d*)d(\d+)([+-]\d+)?$/i);
  if (!m) return null;

  const countRaw = m[1];
  const count = countRaw ? parseInt(countRaw, 10) : 1;
  const sides = parseInt(m[2], 10);
  const mod = m[3] ? parseInt(m[3], 10) : 0;

  if (
    !Number.isFinite(count) ||
    !Number.isFinite(sides) ||
    !Number.isFinite(mod) ||
    count < 1 ||
    count > MAX_DICE ||
    sides < 2 ||
    sides > MAX_SIDES
  ) {
    return null;
  }

  const rolls: number[] = [];
  for (let i = 0; i < count; i += 1) {
    rolls.push(randomInt(1, sides + 1));
  }
  const subtotal = rolls.reduce((a, b) => a + b, 0);
  const total = subtotal + mod;

  const exprMod =
    mod === 0 ? "" : mod > 0 ? `+${mod}` : `${mod}`;
  const normalizedExpr = `${count}d${sides}${exprMod}`;

  return {
    expression: normalizedExpr,
    count,
    sides,
    modifier: mod,
    rolls,
    total,
  };
}

/**
 * 若消息首行符合 `/roll 2d6`、`/roll d20+3`、`/r 1d8-1` 则解析并掷骰（密码学随机）。
 * 仅匹配第一行整行；其余行仍作为用户原文进入对话与模型上下文。
 */
export function parseAndRollDiceFromMessage(message: string): DiceRollResult | null {
  const expr = extractDiceExpressionFromMessage(message);
  if (!expr) return null;
  return rollDiceFromExpression(expr);
}

export function formatDiceForPrompt(result: DiceRollResult): string {
  return (
    `${result.expression} → 各骰点数：${result.rolls.join("、")}；` +
    `骰子小计 ${result.rolls.reduce((a, b) => a + b, 0)}` +
    (result.modifier !== 0 ? `；修正 ${result.modifier >= 0 ? "+" : ""}${result.modifier}` : "") +
    `；**最终合计 ${result.total}**`
  );
}

export function diceToolPayload(
  result: DiceRollResult,
  opts?: {
    transport?: "inline" | "mcp_stdio";
    /** 模型通过 Agent 工具调用掷骰时为 `agent` */
    source?: "user_prefix" | "agent";
    toolCallId?: string;
  }
): Record<string, unknown> {
  return {
    tool: "dice_roller",
    transport: opts?.transport ?? "inline",
    ...(opts?.source ? { source: opts.source } : {}),
    ...(opts?.toolCallId ? { toolCallId: opts.toolCallId } : {}),
    input: {
      expression: result.expression,
      count: result.count,
      sides: result.sides,
      modifier: result.modifier,
    },
    output: {
      rolls: result.rolls,
      total: result.total,
    },
  };
}

/** 将掷骰结果注入最后一条用户消息，供模型叙事引用（不修改 DB 中的原文）。 */
export function augmentLastUserMessageWithDice(
  messages: ModelMessage[],
  diceLine: string | null
): ModelMessage[] {
  if (!diceLine || messages.length === 0) return messages;
  const last = messages[messages.length - 1];
  if (last.role !== "user") return messages;
  const prev = messages.slice(0, -1);
  const content =
    typeof last.content === "string"
      ? last.content
      : JSON.stringify(last.content);
  return [
    ...prev,
    {
      role: "user",
      content: `${content}\n\n【掷骰结果（系统确定性）】${diceLine}`,
    },
  ];
}
