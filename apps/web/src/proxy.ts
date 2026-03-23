import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

const PROTECTED_PATHS = ["/tavern", "/profile", "/worlds"];
const PUBLIC_PATHS = ["/sign-in", "/api/auth/demo-login"];

function isProtected(pathname: string): boolean {
  return PROTECTED_PATHS.some(
    (path) => pathname === path || pathname.startsWith(`${path}/`)
  );
}

function isPublic(pathname: string): boolean {
  return PUBLIC_PATHS.some(
    (path) => pathname === path || pathname.startsWith(`${path}/`)
  );
}

export function proxy(request: NextRequest) {
  const session = request.cookies.get("cw_session")?.value;
  const pathname = request.nextUrl.pathname;

  if (!session && isProtected(pathname)) {
    return NextResponse.redirect(new URL("/sign-in", request.url));
  }

  if (session && isPublic(pathname)) {
    return NextResponse.redirect(new URL("/tavern", request.url));
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
