import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { countThreadsForUser, listThreadsForUser } from "@/lib/db";

function parseArchivedMode(
  raw: string | null
): "active" | "archived" | "all" {
  const v = raw?.trim().toLowerCase();
  if (v === "archived" || v === "only") return "archived";
  if (v === "all") return "all";
  return "active";
}

export async function GET(request: Request) {
  const cookieStore = await cookies();
  const userId = cookieStore.get("cw_user_id")?.value;
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  const url = new URL(request.url);
  const provider = url.searchParams.get("provider")?.trim() || undefined;
  const modelId = url.searchParams.get("modelId")?.trim() || undefined;
  const q = url.searchParams.get("q")?.trim() || undefined;
  const archived = parseArchivedMode(url.searchParams.get("archived"));

  const limitParam = url.searchParams.get("limit");
  const limitValue = limitParam ? Number(limitParam) : NaN;
  const limit = Number.isFinite(limitValue) ? limitValue : 30;

  const offsetParam = url.searchParams.get("offset");
  const offsetValue = offsetParam ? Number(offsetParam) : 0;
  const offset = Number.isFinite(offsetValue) ? Math.max(0, offsetValue) : 0;

  const filter = { provider, modelId, q, archived };
  const total = countThreadsForUser(userId, filter);
  const threads = listThreadsForUser(userId, {
    ...filter,
    limit,
    offset,
  });

  return NextResponse.json({ threads, total, limit, offset });
}
