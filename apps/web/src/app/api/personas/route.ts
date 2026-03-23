import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { createPersona, listPersonasForUser } from "@/lib/db";

export async function GET() {
  const cookieStore = await cookies();
  const userId = cookieStore.get("cw_user_id")?.value;
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }
  const personas = listPersonasForUser(userId, 80);
  return NextResponse.json({ personas });
}

export async function POST(request: Request) {
  const cookieStore = await cookies();
  const userId = cookieStore.get("cw_user_id")?.value;
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  let body: { name?: string; description?: string; title?: string | null };
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
    const persona = createPersona(userId, {
      name,
      description: body.description,
      title: body.title,
    });
    return NextResponse.json({ ok: true, persona });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Create failed.";
    return NextResponse.json({ error: msg }, { status: 400 });
  }
}
