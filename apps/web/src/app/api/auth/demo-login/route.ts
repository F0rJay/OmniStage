import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { upsertUser } from "@/lib/db";

export async function POST(request: Request) {
  const formData = await request.formData();
  const usernameInput = formData.get("username");
  const username =
    typeof usernameInput === "string" && usernameInput.trim()
      ? usernameInput.trim()
      : "旅人";

  const cookieStore = await cookies();
  const userId = cookieStore.get("cw_user_id")?.value ?? randomUUID();
  upsertUser(userId, username);

  const value = `${username}|${Date.now()}`;
  cookieStore.set("cw_user_id", userId, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 30,
  });
  cookieStore.set("cw_session", value, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 7,
  });

  return NextResponse.redirect(new URL("/tavern", request.url));
}
