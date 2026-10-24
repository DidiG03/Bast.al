import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";

const isPublicRoute = createRouteMatcher(["/sign-in(.*)", "/", "/.well-known/(.*)"]);
const isSignUpRoute = createRouteMatcher(["/sign-up(.*)"]);
const isApiRoute = createRouteMatcher(["/api/(.*)"]);

export default clerkMiddleware(async (auth, request) => {
  // No public self-serve registration — hierarchy users are admin-provisioned only.
  if (isSignUpRoute(request)) {
    return NextResponse.redirect(new URL("/sign-in", request.url));
  }

  if (isPublicRoute(request)) return;
  // A fetch to the API with a sign-in that ran out: say so, so the page gets a fresh token and asks again.
  // protect() answers those with a bare 404, which showed as "Request failed (404)" on a live bet.
  if (isApiRoute(request)) {
    const { userId } = await auth();
    if (!userId) return NextResponse.json({ message: "Your session needs refreshing. Try again." }, { status: 401, headers: { "cache-control": "no-store" } });
    return;
  }
  await auth.protect();
});

export const config = {
  matcher: [
    // public/casino holds the games' art and its manifest.json; a fetch for it with an expired session
    // can't do Clerk's handshake and got a 404, which left Book of Ra's picture blank.
    "/((?!_next|casino/|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    "/(api|trpc)(.*)",
  ],
};
