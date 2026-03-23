import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { deletePersona, updatePersona } from "@/lib/db";

type Params = { params: Promise<{ personaId: string }> };

export async function PATCH(request: Request, { params }: Params) {
  const cookieStore = await cookies();
  const userId = cookieStore.get("cw_user_id")?.value;
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  const { personaId } = await params;
  const id = personaId?.trim();
  if (!id) {
    return NextResponse.json({ error: "personaId is required." }, { status: 400 });
  }

  let body: { name?: string; description?: string; title?: string | null };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  try {
    const persona = updatePersona(id, userId, body);
    return NextResponse.json({ ok: true, persona });
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

  const { personaId } = await params;
  const id = personaId?.trim();
  if (!id) {
    return NextResponse.json({ error: "personaId is required." }, { status: 400 });
  }

  try {
    deletePersona(id, userId);
    return NextResponse.json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Delete failed.";
    return NextResponse.json({ error: msg }, { status: 400 });
  }
}
