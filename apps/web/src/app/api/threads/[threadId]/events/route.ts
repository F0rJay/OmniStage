import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { ensureThread, listSessionEventsForThread } from "@/lib/db";

export const runtime = "nodejs";

type Params = { params: Promise<{ threadId: string }> };

export async function GET(_request: Request, { params }: Params) {
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
    ensureThread(id, userId);
  } catch {
    return NextResponse.json({ error: "Forbidden thread access." }, { status: 403 });
  }

  const rows = listSessionEventsForThread(id, userId, 300);
  const events = rows.map((row) => ({
    id: row.id,
    eventType: row.event_type,
    payload: JSON.parse(row.payload || "{}") as Record<string, unknown>,
    createdAt: row.created_at,
  }));

  return NextResponse.json({ events });
}
