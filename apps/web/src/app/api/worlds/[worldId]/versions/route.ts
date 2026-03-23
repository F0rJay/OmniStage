import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { createWorldVersion, listWorldVersionsForWorld } from "@/lib/db";

type Params = { params: Promise<{ worldId: string }> };

export async function GET(_request: Request, { params }: Params) {
  const cookieStore = await cookies();
  const userId = cookieStore.get("cw_user_id")?.value;
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  const { worldId } = await params;
  try {
    const versions = listWorldVersionsForWorld(worldId, userId);
    return NextResponse.json({ versions });
  } catch {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }
}

type PostBody = {
  canonicalJson?: string;
  version?: number;
};

export async function POST(request: Request, { params }: Params) {
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

  const { worldId } = await params;
  try {
    const version = createWorldVersion(worldId, userId, {
      canonicalJson: body.canonicalJson ?? "{}",
      version: body.version,
    });
    return NextResponse.json({ ok: true, version }, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Create failed.";
    const status = message.includes("not accessible") ? 403 : 400;
    return NextResponse.json({ error: message }, { status });
  }
}
