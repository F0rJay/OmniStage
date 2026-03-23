import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import {
  deleteWorldForUser,
  getLatestWorldVersion,
  getWorldForUser,
  updateWorldForUser,
} from "@/lib/db";

type Params = { params: Promise<{ worldId: string }> };

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

  const latestVersion = getLatestWorldVersion(worldId, userId);

  return NextResponse.json({ world, latestVersion });
}

export async function DELETE(_request: Request, { params }: Params) {
  const cookieStore = await cookies();
  const userId = cookieStore.get("cw_user_id")?.value;
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  const { worldId } = await params;
  try {
    deleteWorldForUser(worldId, userId);
  } catch (e) {
    const message = e instanceof Error ? e.message : "Delete failed.";
    if (message.includes("not accessible")) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }
    return NextResponse.json({ error: message }, { status: 400 });
  }

  return NextResponse.json({ ok: true });
}

type PatchBody = {
  name?: string;
  description?: string;
};

export async function PATCH(request: Request, { params }: Params) {
  const cookieStore = await cookies();
  const userId = cookieStore.get("cw_user_id")?.value;
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  const { worldId } = await params;
  let body: PatchBody;
  try {
    body = (await request.json()) as PatchBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  if (body.name === undefined && body.description === undefined) {
    return NextResponse.json(
      { error: "Provide name and/or description." },
      { status: 400 }
    );
  }

  try {
    const world = updateWorldForUser(worldId, userId, {
      name: body.name,
      description: body.description,
    });
    return NextResponse.json({ ok: true, world });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Update failed.";
    if (message.includes("not accessible")) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
