import { cookies } from "next/headers";
import { NextResponse } from "next/server";

export async function POST(request: Request) {
  const cookieStore = await cookies();
  cookieStore.delete("cw_session");
  return NextResponse.redirect(new URL("/sign-in", request.url));
}
