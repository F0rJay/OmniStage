import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import {
  deleteTavernCharacter,
  getTavernCharacterForUser,
  updateTavernCharacter,
} from "@/lib/db";

type Params = { params: Promise<{ characterId: string }> };

export async function GET(_request: Request, { params }: Params) {
  const cookieStore = await cookies();
  const userId = cookieStore.get("cw_user_id")?.value;
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  const { characterId } = await params;
  const id = characterId?.trim();
  if (!id) {
    return NextResponse.json({ error: "characterId is required." }, { status: 400 });
  }

  const character = getTavernCharacterForUser(id, userId);
  if (!character) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }
  return NextResponse.json({ character });
}

export async function PATCH(request: Request, { params }: Params) {
  const cookieStore = await cookies();
  const userId = cookieStore.get("cw_user_id")?.value;
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  const { characterId } = await params;
  const id = characterId?.trim();
  if (!id) {
    return NextResponse.json({ error: "characterId is required." }, { status: 400 });
  }

  let body: { name?: string; tags?: string; characterCardJson?: string };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  try {
    const character = updateTavernCharacter(id, userId, body);
    return NextResponse.json({ ok: true, character });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Update failed.";
    return NextResponse.json({ error: msg }, { status: 400 });
  }
}

export async function DELETE(_request: Request, { params }: Params) {
  const cookieStore = await cookies();
  const userId = cookieStore.get("cw_user_id")?.value;
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  const { characterId } = await params;
  const id = characterId?.trim();
  if (!id) {
    return NextResponse.json({ error: "characterId is required." }, { status: 400 });
  }

  try {
    deleteTavernCharacter(id, userId);
    return NextResponse.json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Delete failed.";
    return NextResponse.json({ error: msg }, { status: 400 });
  }
}
