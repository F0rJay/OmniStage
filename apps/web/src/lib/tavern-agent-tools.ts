import "server-only";

import { tool, zodSchema } from "ai";
import * as z from "zod";
import { rollDiceFromExpression, type DiceRollResult } from "@/lib/dice";
import { rollDiceViaMcp } from "@/lib/mcp-dice";
import { isMcpDiceEnabled } from "@/lib/mcp-config";
import { callWorldMcpTool } from "@/lib/mcp-world-tools";
import { buildReactCognitiveSystemAppend } from "@/lib/react-cognitive";

/** 与 `mcp-servers/world-tools` 中 ReaderInputSchema 对齐 */
const WorldReaderInputSchema = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("list_worlds") }),
  z.object({
    operation: z.literal("get_summary"),
    world_id: z.string().uuid(),
  }),
  z.object({
    operation: z.literal("list_versions"),
    world_id: z.string().uuid(),
  }),
  z.object({
    operation: z.literal("get_canonical"),
    world_id: z.string().uuid(),
    version: z.coerce.number().int().positive().optional(),
  }),
  z.object({
    operation: z.literal("get_canonical_by_version_id"),
    version_id: z.string().uuid(),
  }),
]);

/** 与 WriterInputSchema 对齐 */
const WorldWriterInputSchema = z.discriminatedUnion("operation", [
  z.object({
    operation: z.literal("append_version"),
    world_id: z.string().uuid(),
    canonical_json: z.string().min(1).max(600_000),
    source_note: z.string().max(2000).optional(),
    citations_json: z.string().max(200_000).optional(),
  }),
  z.object({
    operation: z.literal("create_world"),
    name: z.string().min(1).max(120),
    description: z.string().max(2000).optional(),
  }),
]);

export function buildAgentToolsSystemAppend(options: {
  allowWorldWrite: boolean;
  /** ReAct 认知框架（Thought / Action / Observation） */
  reactCognitive?: boolean;
}): string {
  const writeLine = options.allowWorldWrite
    ? "- `world_writer`：创建世界或追加 Canonical 版本（会写入数据库，须合法 JSON）。"
    : "（当前未开启写库：`world_writer` 不可用。）";
  let base =
    "【工具】你可按需调用以下工具；参数中不要包含 user_id（由服务端注入）。\n" +
    "- `dice_roll`：掷骰，参数 `expression` 如 `2d6`、`d20+3`；不要编造点数。\n" +
    "- `world_reader`：查询当前用户的世界列表、摘要、版本列表或某版 Canonical。\n" +
    `${writeLine}\n` +
    "需要掷骰或查世界书时再调用；普通对话可直接回复。";
  if (options.reactCognitive) {
    base += `\n\n---\n\n${buildReactCognitiveSystemAppend()}`;
  }
  return base;
}

export function truncateJsonForSse(value: unknown, maxChars: number): string {
  try {
    const s = JSON.stringify(value);
    if (s.length <= maxChars) return s;
    return `${s.slice(0, maxChars)}…[truncated]`;
  } catch {
    return "[unserializable]";
  }
}

export function buildTavernAgentTools(options: {
  userId: string;
  allowWorldWrite: boolean;
  onAgentDiceSuccess?: (toolCallId: string, result: DiceRollResult) => void;
}) {
  const dice_roll = tool({
    description:
      "Roll dice with NdM notation (e.g. 2d6, d20+3). Use for RPG; never invent totals.",
    inputSchema: zodSchema(
      z.object({
        expression: z
          .string()
          .min(1)
          .describe("Dice expression, e.g. 2d6 or d20+5"),
      })
    ),
    execute: async (
      { expression },
      { toolCallId }
    ): Promise<DiceRollResult> => {
      const expr = expression.trim();
      if (isMcpDiceEnabled()) {
        const result = await rollDiceViaMcp(expr);
        options.onAgentDiceSuccess?.(toolCallId, result);
        return result;
      }
      const result = rollDiceFromExpression(expr);
      if (!result) {
        throw new Error("Invalid dice expression");
      }
      options.onAgentDiceSuccess?.(toolCallId, result);
      return result;
    },
  });

  const world_reader = tool({
    description:
      "Read CanonWeave worlds for the current user: list_worlds | get_summary | list_versions | get_canonical | get_canonical_by_version_id.",
    inputSchema: zodSchema(WorldReaderInputSchema),
    execute: async (input) => {
      return await callWorldMcpTool(
        "world_reader",
        options.userId,
        input as unknown as Record<string, unknown>
      );
    },
  });

  const base = {
    dice_roll,
    world_reader,
  } as const;

  if (!options.allowWorldWrite) {
    return { ...base };
  }

  const world_writer = tool({
    description:
      "Write worlds: create_world (shell) or append_version (validated canonical JSON). Prefer world_reader first.",
    inputSchema: zodSchema(WorldWriterInputSchema),
    execute: async (input) => {
      return await callWorldMcpTool(
        "world_writer",
        options.userId,
        input as unknown as Record<string, unknown>
      );
    },
  });

  return { ...base, world_writer };
}
