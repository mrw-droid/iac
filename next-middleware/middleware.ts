import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

/**
 * Middleware to protect /admin routes.
 *
 * Admin routes are only accessible when the request includes the
 * X-Tailnet-Secret header with the correct value. This header is
 * added by the Tailgate nginx proxy when accessing via Tailscale.
 *
 * Usage:
 * 1. Copy this file to the root of your Next.js project
 * 2. Set TAILNET_SECRET environment variable in Vercel
 * 3. Access admin routes via your Tailgate URL (e.g., https://admin.yourtailnet.ts.net/admin)
 */

const TAILNET_SECRET = process.env.TAILNET_SECRET;

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Check if this is an admin route
  if (pathname.startsWith("/admin")) {
    // Get the secret header from the request
    const providedSecret = request.headers.get("x-tailnet-secret");

    // If no secret is configured, deny all admin access
    if (!TAILNET_SECRET) {
      console.error("TAILNET_SECRET environment variable is not set");
      return new NextResponse(null, { status: 404 });
    }

    // Verify the secret matches
    if (providedSecret !== TAILNET_SECRET) {
      // Return 404 to hide the existence of admin routes
      return new NextResponse(null, { status: 404 });
    }

    // Secret matches - allow the request to proceed
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/admin/:path*"],
};
