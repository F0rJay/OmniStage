import "server-only";

import fs from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  extractDiceExpressionFromMessage,
  rollDiceFromExpression,
  type DiceRollResult,
} from "@/lib/dice";
import { getMcpDiceServerScriptPath, isMcpDiceEnabled } from "@/lib/mcp-config";

export { isMcpDiceEnabled } from "@/lib/mcp-config";

/**
 * 通过 stdio 启动 `mcp-dice-roller`，调用工具 `dice_roll`。
 */
export async function rollDiceViaMcp(expression: string): Promise<DiceRollResult> {
  const scriptPath = getMcpDiceServerScriptPath();
  if (!fs.existsSync(scriptPath)) {
    throw new Error(
      `MCP 骰子脚本不存在：${scriptPath}。请在仓库根目录执行：npm run build:mcp-dice`
    );
  }

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [scriptPath],
    stderr: "inherit",
  });

  const client = new Client({ name: "canonweave-web", version: "0.1.0" });

  await client.connect(transport);

  try {
    const out = await client.callTool({
      name: "dice_roll",
      arguments: { expression },
    });

    const contentItems = Array.isArray(out.content) ? out.content : [];

    if (out.isError) {
      const text =
        contentItems.find((c): c is { type: "text"; text: string } => c.type === "text")
          ?.text ?? "unknown error";
      let errMsg = text;
      try {
        const j = JSON.parse(text) as { error?: string };
        if (typeof j.error === "string") errMsg = j.error;
      } catch {
        /* use raw */
      }
      throw new Error(errMsg);
    }

    const text = contentItems.find(
      (c): c is { type: "text"; text: string } => c.type === "text"
    )?.text;
    if (!text) {
      throw new Error("MCP dice_roll 未返回文本内容");
    }

    const parsed = JSON.parse(text) as Partial<DiceRollResult>;
    if (
      typeof parsed.expression !== "string" ||
      !Array.isArray(parsed.rolls) ||
      typeof parsed.total !== "number" ||
      typeof parsed.count !== "number" ||
      typeof parsed.sides !== "number" ||
      typeof parsed.modifier !== "number"
    ) {
      throw new Error("MCP dice_roll 返回的 JSON 格式无效");
    }

    return parsed as DiceRollResult;
  } finally {
    await client.close();
  }
}

/** 解析首行掷骰指令，按需走 MCP 或内联实现。 */
export async function resolveDiceForChatMessage(
  text: string
): Promise<{ result: DiceRollResult; viaMcp: boolean } | null> {
  const expr = extractDiceExpressionFromMessage(text);
  if (!expr) return null;

  if (isMcpDiceEnabled()) {
    const result = await rollDiceViaMcp(expr);
    return { result, viaMcp: true };
  }

  const result = rollDiceFromExpression(expr);
  if (!result) return null;
  return { result, viaMcp: false };
}
