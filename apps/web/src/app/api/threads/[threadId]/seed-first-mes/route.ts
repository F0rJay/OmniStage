import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { tryInsertAssistantFirstMesForEmptyThread } from "@/lib/tavern-first-mes";

type Params = { params: Promise<{ threadId: string }> };

/**
 * 空会话 + 已绑定 assistant 角色 + 有 first_mes 时，插入一条助手消息（幂等：已有任意消息则跳过）。
 */
export async function POST(_request: Request, { params }: Params) {
  const cookieStore = await cookies();
  const userId = cookieStore.get("cw_user_id")?.value;
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  const { threadId } = await params;
  const id = threadId?.trim();
  if (!id) {
    return NextResponse.json({ error: "threadId is required." }, { status: 400 });
  }

  try {
    const result = tryInsertAssistantFirstMesForEmptyThread(id, userId);
    if (result.inserted && result.content) {
      return NextResponse.json({
        ok: true,
        inserted: true,
        message: { role: "assistant" as const, content: result.content },
      });
    }
    return NextResponse.json({
      ok: true,
      inserted: false,
      skipReason: result.skipReason ?? "unknown",
    });
  } catch {
    return NextResponse.json({ error: "Forbidden thread access." }, { status: 403 });
  }
}
