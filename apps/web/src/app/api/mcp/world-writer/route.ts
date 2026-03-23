import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { callWorldMcpTool } from "@/lib/mcp-world-tools";

export const runtime = "nodejs";

/**
 * 代理调用 MCP `world_writer`（stdio 子进程 + 注入当前用户与 DB）。
 * Body：与 MCP 工具参数一致（append_version | create_world）。
 */
export async function POST(request: Request) {
  const cookieStore = await cookies();
  const userId = cookieStore.get("cw_user_id")?.value;
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  try {
    const result = await callWorldMcpTool("world_writer", userId, body);
    return NextResponse.json({ ok: true, result });
  } catch (e) {
    const message = e instanceof Error ? e.message : "MCP world_writer failed.";
    return NextResponse.json({ error: message }, { status: 503 });
  }
}
