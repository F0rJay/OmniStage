import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import {
  countWorldsForUser,
  createWorld,
  listWorldsForUser,
  listWorldsWithVersionSummariesForUser,
} from "@/lib/db";

export async function GET(request: Request) {
  const cookieStore = await cookies();
  const userId = cookieStore.get("cw_user_id")?.value;
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  const url = new URL(request.url);
  const q = url.searchParams.get("q")?.trim() || undefined;
  const limitParam = url.searchParams.get("limit");
  const limitValue = limitParam ? Number(limitParam) : NaN;
  const limit = Number.isFinite(limitValue) ? limitValue : 30;
  const offsetParam = url.searchParams.get("offset");
  const offsetValue = offsetParam ? Number(offsetParam) : 0;
  const offset = Number.isFinite(offsetValue) ? Math.max(0, offsetValue) : 0;

  const filter = { q };
  const total = countWorldsForUser(userId, filter);
  const includeVersions =
    url.searchParams.get("include_versions") === "1" ||
    url.searchParams.get("include_versions") === "true";

  if (includeVersions) {
    if (offset !== 0 || q) {
      return NextResponse.json(
        {
          error:
            "include_versions=1 时暂不支持 offset>0 与 q 过滤，请缩小范围或分步请求。",
        },
        { status: 400 }
      );
    }
    const cap = Math.max(1, Math.min(limit, 50));
    const worlds = listWorldsWithVersionSummariesForUser(userId, cap);
    return NextResponse.json({
      worlds,
      total,
      limit: cap,
      offset: 0,
      include_versions: true,
    });
  }

  const worlds = listWorldsForUser(userId, { ...filter, limit, offset });

  return NextResponse.json({ worlds, total, limit, offset });
}

type PostBody = {
  name?: string;
  description?: string;
};

export async function POST(request: Request) {
  const cookieStore = await cookies();
  const userId = cookieStore.get("cw_user_id")?.value;
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  let body: PostBody;
  try {
    body = (await request.json()) as PostBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  try {
    const name = (body.name ?? "").trim() || "未命名世界";
    const world = createWorld(userId, {
      name,
      description: body.description,
    });
    return NextResponse.json({ ok: true, world }, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Create failed.";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
