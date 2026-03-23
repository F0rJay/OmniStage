import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { permanentlyDeleteThreadForUser } from "@/lib/db";

type Params = { params: Promise<{ threadId: string }> };

/** 永久删除会话（不可恢复）；与 DELETE /threads/[id] 仅归档不同。 */
export async function DELETE(_request: Request, { params }: Params) {
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
    permanentlyDeleteThreadForUser(id, userId);
    return NextResponse.json({ ok: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "";
    if (msg.includes("not accessible")) {
      return NextResponse.json({ error: msg }, { status: 403 });
    }
    return NextResponse.json({ error: "删除失败。" }, { status: 500 });
  }
}
