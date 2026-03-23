import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { createTavernCharacter, listTavernCharactersForUser } from "@/lib/db";

export async function GET() {
  const cookieStore = await cookies();
  const userId = cookieStore.get("cw_user_id")?.value;
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }
  const characters = listTavernCharactersForUser(userId, 100);
  return NextResponse.json({ characters });
}

export async function POST(request: Request) {
  const cookieStore = await cookies();
  const userId = cookieStore.get("cw_user_id")?.value;
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  let body: { name?: string; tags?: string; characterCardJson?: string };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const name = body.name?.trim();
  if (!name) {
    return NextResponse.json({ error: "name is required." }, { status: 400 });
  }

  try {
    const character = createTavernCharacter(userId, {
      name,
      tags: body.tags,
      characterCardJson: body.characterCardJson,
    });
    return NextResponse.json({ ok: true, character });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Create failed.";
    return NextResponse.json({ error: msg }, { status: 400 });
  }
}
