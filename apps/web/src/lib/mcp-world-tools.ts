import "server-only";

import fs from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { getDatabasePath } from "@/lib/db";
import { getMcpWorldToolsServerScriptPath } from "@/lib/mcp-config";

function parseToolJson(out: unknown): unknown {
  const o = out as { isError?: boolean; content?: unknown };
  const contentItems = Array.isArray(o.content) ? o.content : [];

  const text = contentItems.find(
    (c): c is { type: "text"; text: string } =>
      typeof c === "object" && c !== null && "type" in c && c.type === "text"
  )?.text;

  if (!text) {
    throw new Error("MCP 工具未返回文本内容");
  }

  if (o.isError) {
    try {
      const j = JSON.parse(text) as { error?: string };
      throw new Error(j.error ?? text);
    } catch (e) {
      if (e instanceof Error && e.message !== text) throw e;
      throw new Error(text);
    }
  }

  return JSON.parse(text) as unknown;
}

/**
 * 以当前登录用户身份调用 world-tools MCP（注入 DB 路径与用户 ID，工具参数勿含 user_id）。
 */
export async function callWorldMcpTool(
  toolName: "world_reader" | "world_writer",
  userId: string,
  arguments_: Record<string, unknown>
): Promise<unknown> {
  const scriptPath = getMcpWorldToolsServerScriptPath();
  if (!fs.existsSync(scriptPath)) {
    throw new Error(
      `MCP world-tools 脚本不存在：${scriptPath}。请执行：npm run build:mcp-world`
    );
  }

  const dbPath = getDatabasePath();

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [scriptPath],
    env: {
      ...getDefaultEnvironment(),
      CANONWEAVE_DB_PATH: dbPath,
      CANONWEAVE_MCP_USER_ID: userId,
    },
    stderr: "inherit",
  });

  const client = new Client({ name: "canonweave-web", version: "0.1.0" });
  await client.connect(transport);

  try {
    const out = await client.callTool({
      name: toolName,
      arguments: arguments_,
    });
    return parseToolJson(out);
  } finally {
    await client.close();
  }
}
