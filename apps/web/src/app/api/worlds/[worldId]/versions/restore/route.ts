import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { restoreWorldVersionAsNew } from "@/lib/db";

type Params = { params: Promise<{ worldId: string }> };

type Body = {
  fromVersionId?: string;
};

export async function POST(request: Request, { params }: Params) {
  const cookieStore = await cookies();
  const userId = cookieStore.get("cw_user_id")?.value;
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const fromVersionId = body.fromVersionId?.trim();
  if (!fromVersionId) {
    return NextResponse.json(
      { error: "fromVersionId is required." },
      { status: 400 }
    );
  }

  const { worldId } = await params;

  try {
    const version = restoreWorldVersionAsNew(worldId, userId, fromVersionId);
    return NextResponse.json(
      {
        ok: true,
        version,
        message:
          "已基于所选版本追加新版本（历史未删除）。可将会话绑定到最新版本以使用恢复线。",
      },
      { status: 201 }
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Restore failed.";
    const status =
      message.includes("not belong") || message.includes("not found")
        ? 400
        : message.includes("not accessible")
          ? 403
          : 400;
    return NextResponse.json({ error: message }, { status });
  }
}
