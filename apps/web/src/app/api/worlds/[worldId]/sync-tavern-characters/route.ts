import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import {
  getLatestWorldVersion,
  getWorldForUser,
  replayTavernSyncFromWorldVersion,
} from "@/lib/db";

type Params = { params: Promise<{ worldId: string }> };

/**
 * POST：按指定版本（或最新版本）将 character_books 同步到 tavern_characters。
 * Body: `{ "versionId"?: string }` — 省略则使用当前世界最新版本。
 */
export async function POST(request: Request, { params }: Params) {
  const cookieStore = await cookies();
  const userId = cookieStore.get("cw_user_id")?.value;
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  const { worldId } = await params;
  if (!getWorldForUser(worldId, userId)) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }

  let versionId: string | undefined;
  try {
    const j = (await request.json()) as { versionId?: string };
    versionId = j.versionId?.trim();
  } catch {
    versionId = undefined;
  }

  const vid =
    versionId || getLatestWorldVersion(worldId, userId)?.id || null;
  if (!vid) {
    return NextResponse.json({ error: "没有可用世界版本。" }, { status: 400 });
  }

  try {
    replayTavernSyncFromWorldVersion(worldId, userId, vid);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "同步失败。";
    return NextResponse.json({ error: msg }, { status: 400 });
  }

  return NextResponse.json({ ok: true, worldVersionId: vid });
}
