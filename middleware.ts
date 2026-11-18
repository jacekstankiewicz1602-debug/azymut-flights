import { NextResponse, type NextRequest } from "next/server";
import { COOKIE, sessionToken } from "./lib/session";

export async function middleware(req: NextRequest) {
  const password = process.env.APP_PASSWORD;
  if (!password) return NextResponse.next(); // gate disabled when no password is configured
  const token = req.cookies.get(COOKIE)?.value;
  if (token && token === (await sessionToken(password))) return NextResponse.next();
  if (req.nextUrl.pathname.startsWith("/api/")) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const url = req.nextUrl.clone();
  url.pathname = "/login";
  url.search = "";
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ["/((?!login|api/login|api/cron|api/search/step|_next/static|_next/image|favicon.ico|icon.svg|manifest.webmanifest|sw.js|icon-192.png|icon-512.png|icon-maskable.png|badge.png|apple-icon.png).*)"],
};
