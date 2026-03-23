import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import {
  getOrCreateScreenwriterSession,
  getWorldForUser,
  listScreenwriterMessages,
} from "@/lib/db";

type Params = { params: Promise<{ worldId: string }> };

/** 编剧工坊：获取/创建会话与历史消息（每用户每世界一条长期会话） */
export async function GET(_request: Request, { params }: Params) {
  const cookieStore = await cookies();
  const userId = cookieStore.get("cw_user_id")?.value;
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  const { worldId } = await params;
  const world = getWorldForUser(worldId, userId);
  if (!world) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }

  const sessionId = getOrCreateScreenwriterSession(worldId, userId);
  const messages = listScreenwriterMessages(sessionId, userId);

  return NextResponse.json({
    sessionId,
    world: { id: world.id, name: world.name, description: world.description },
    messages,
  });
}
