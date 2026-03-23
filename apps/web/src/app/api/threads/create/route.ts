import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { createThreadForUser } from "@/lib/db";

export async function POST(request: Request) {
  const cookieStore = await cookies();
  const userId = cookieStore.get("cw_user_id")?.value;

  if (!userId) {
    return NextResponse.redirect(new URL("/sign-in", request.url));
  }

  const thread = createThreadForUser(userId);
  return NextResponse.redirect(new URL(`/tavern/sessions/${thread.id}`, request.url));
}
