/**
 * CanonWeave MCP 服务器：确定性掷骰（stdio）。
 * 工具名 dice_roll，与 Web BFF 通过 StdioClientTransport 对接。
 */
import { randomInt } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod";

const MAX_DICE = 20;
const MAX_SIDES = 1000;

export type RollOk = {
  expression: string;
  count: number;
  sides: number;
  modifier: number;
  rolls: number[];
  total: number;
};

function rollDiceFromExpression(expression: string): { ok: true; value: RollOk } | { ok: false; error: string } {
  const m = expression.trim().match(/^(\d*)d(\d+)([+-]\d+)?$/i);
  if (!m) {
    return { ok: false, error: "Invalid expression. Use NdM or dM, optional +N/-N (e.g. 2d6, d20+3)." };
  }

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
    return {
      ok: false,
      error: `Out of range: 1–${MAX_DICE} dice, 2–${MAX_SIDES} sides.`,
    };
  }

  const rolls: number[] = [];
  for (let i = 0; i < count; i += 1) {
    rolls.push(randomInt(1, sides + 1));
  }
  const subtotal = rolls.reduce((a, b) => a + b, 0);
  const total = subtotal + mod;
  const exprMod = mod === 0 ? "" : mod > 0 ? `+${mod}` : `${mod}`;
  const normalizedExpr = `${count}d${sides}${exprMod}`;

  return {
    ok: true,
    value: {
      expression: normalizedExpr,
      count,
      sides,
      modifier: mod,
      rolls,
      total,
    },
  };
}

const server = new McpServer(
  { name: "canonweave-dice-roller", version: "0.1.0" },
  {
    instructions:
      "CanonWeave dice roller. Call dice_roll with expression like 2d6, d20+3, 1d8-1.",
  }
);

server.registerTool(
  "dice_roll",
  {
    description:
      "Roll dice using NdM notation with optional modifier (e.g. 2d6, d20+3, 1d8-1). Uses cryptographic randomness.",
    inputSchema: {
      expression: z
        .string()
        .min(1)
        .max(48)
        .describe('Dice expression without leading slash, e.g. "2d6" or "d20+5"'),
    },
  },
  async ({ expression }) => {
    const result = rollDiceFromExpression(expression);
    if (!result.ok) {
      return {
        isError: true,
        content: [{ type: "text" as const, text: JSON.stringify({ error: result.error }) }],
      };
    }
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(result.value),
        },
      ],
    };
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
