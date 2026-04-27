import { NextRequest, NextResponse } from 'next/server';
import { createServerClient } from '@supabase/ssr';

/**
 * Middleware — route protection and auth context injection.
 *
 * Dashboard routes (/dashboard/*) require an authenticated session.
 * Unauthenticated users are redirected to /login.
 *
 * API routes (/api/*) pass through — auth is enforced per-handler
 * using createSupabaseServerClient() and checking the session.
 * Webhook routes (/api/webhook/*) are explicitly excluded from auth.
 */
export async function middleware(req: NextRequest) {
  let response = NextResponse.next({
    request: { headers: new Headers(req.headers) },
  });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return req.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value, options }) => {
            req.cookies.set(name, value);
          });
          response = NextResponse.next({
            request: req,
          });
          cookiesToSet.forEach(({ name, value, options }) => {
            response.cookies.set(name, value, options);
          });
        },
      },
    }
  );

  // Refresh the session (keeps it alive, handles token rotation)
  const { data: { user } } = await supabase.auth.getUser();

  const { pathname } = req.nextUrl;

  // Protect authenticated routes — redirect to login if not authenticated
  const protectedPaths = ['/dashboard', '/onboarding'];
  if (protectedPaths.some((p) => pathname.startsWith(p))) {
    if (!user) {
      const loginUrl = new URL('/login', req.url);
      loginUrl.searchParams.set('next', pathname);
      return NextResponse.redirect(loginUrl);
    }

    // Inject user info into request headers for downstream components
    response.headers.set('x-user-id', user.id);
    response.headers.set('x-user-email', user.email ?? '');
  }

  // Already logged in and visiting auth pages — redirect to dashboard
  if ((pathname === '/login' || pathname === '/signup') && user) {
    return NextResponse.redirect(new URL('/dashboard', req.url));
  }

  return response;
}

export const config = {
  matcher: [
    /*
     * Match all paths except:
     * - _next/static, _next/image (Next.js internals)
     * - favicon.ico, public files
     * - /api/webhook/* (Chatwoot inbound — no user auth)
     */
    '/((?!_next/static|_next/image|favicon.ico|api/webhook).*)',
  ],
};
