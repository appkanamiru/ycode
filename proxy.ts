import { createServerClient } from '@supabase/ssr';
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { applySecurityHeaders } from '@/lib/security-headers-server';
import { prefetchYcodePublishedAt } from '@/lib/ycode-html-comment';
import { isMultiTenant } from '@/lib/database/tenancy';
import { isPlatformAuth, TENANT_HEADER } from '@/lib/platform/config';
import { resolveMcpTenant, resolvePlatformRequest } from '@/lib/platform/proxy';

/**
 * Public API routes that skip authentication.
 */
const PUBLIC_API_PREFIXES = [
  '/ycode/api/setup/',    // Setup wizard — needed before any user exists
  '/ycode/api/supabase/', // Supabase config — needed for browser client init
  '/ycode/api/auth/',     // Auth callbacks and session checks
  '/ycode/api/v1/',       // Public API — has own API key auth
  '/ycode/api/platform/auth/', // Platform auth (sign in/up) — handles its own sessions
];

/**
 * Patterns for collection item endpoints that must be accessible on published pages
 * (load-more pagination, filter). Matched via regex since the collection ID is dynamic.
 */
const PUBLIC_COLLECTION_ITEM_SUFFIXES = ['/items/filter', '/items/load-more'];

const PUBLIC_API_EXACT = [
  '/ycode/api/revalidate', // Cache revalidation — has own secret token auth
  '/ycode/api/oauth/register', // RFC 7591 Dynamic Client Registration — anonymous
  '/ycode/api/oauth/token',    // OAuth token exchange — auth is via PKCE/refresh
];

/**
 * Derive the Supabase project URL and anon key from environment variables.
 * Returns null if env vars are not set (pre-setup or local dev without .env.local).
 *
 * Uses SUPABASE_URL when set (self-hosted instances), otherwise derives from
 * the project ref in the connection string (hosted Supabase).
 */
function getSupabaseEnvConfig(): { url: string; anonKey: string } | null {
  const anonKey = process.env.SUPABASE_PUBLISHABLE_KEY
    || process.env.SUPABASE_ANON_KEY;
  const connectionUrl = process.env.SUPABASE_CONNECTION_URL;

  if (!anonKey || !connectionUrl) return null;

  if (process.env.SUPABASE_URL) {
    return {
      url: process.env.SUPABASE_URL.replace(/\/+$/, ''),
      anonKey,
    };
  }

  // Hosted Supabase: extract project ID from connection URL
  const match = connectionUrl.match(/\/\/postgres\.([a-z0-9]+):/);
  if (!match) return null;

  return {
    url: `https://${match[1]}.supabase.co`,
    anonKey,
  };
}

/**
 * Request headers for the app: never trust a tenant header from the client,
 * only the one resolved here.
 */
function withTenantHeader(headers: Headers, tenantId: string | null): Headers {
  const requestHeaders = new Headers(headers);
  requestHeaders.delete(TENANT_HEADER);
  if (tenantId) requestHeaders.set(TENANT_HEADER, tenantId);
  return requestHeaders;
}

/** Attach x-pathname on the request (readable via headers()) and the response. */
function withPathname(response: NextResponse, request: NextRequest, pathname: string, tenantId: string | null = null): NextResponse {
  const requestHeaders = withTenantHeader(request.headers, tenantId);
  requestHeaders.set('x-pathname', pathname);
  const next = NextResponse.next({
    request: { headers: requestHeaders },
  });
  response.cookies.getAll().forEach((cookie) => {
    next.cookies.set(cookie.name, cookie.value);
  });
  response.headers.forEach((value, key) => {
    next.headers.set(key, value);
  });
  next.headers.set('x-pathname', pathname);
  return next;
}

function isPublicApiRoute(pathname: string, method: string, searchParams: URLSearchParams): boolean {
  // POST to form-submissions is public (website visitors submitting forms)
  if (pathname === '/ycode/api/form-submissions' && method === 'POST') {
    return true;
  }

  // Published error pages are rendered for visitors by the error boundary, so the
  // published variant must be readable anonymously. Drafts stay behind auth.
  if (method === 'GET' && pathname === '/ycode/api/error-page'
      && searchParams.get('published') === 'true') {
    return true;
  }

  if (PUBLIC_API_EXACT.includes(pathname)) return true;

  if (PUBLIC_API_PREFIXES.some((prefix) => pathname.startsWith(prefix))) return true;

  // Collection item endpoints for published pages (POST only — filter, load-more)
  if (method === 'POST' && pathname.startsWith('/ycode/api/collections/') &&
      PUBLIC_COLLECTION_ITEM_SUFFIXES.some(suffix => pathname.endsWith(suffix))) {
    return true;
  }

  return false;
}

/**
 * Verify Supabase session for protected API routes.
 * Returns a 401 response if not authenticated, or null to continue.
 */
async function verifyApiAuth(request: NextRequest): Promise<NextResponse | null> {
  if (isPublicApiRoute(request.nextUrl.pathname, request.method, request.nextUrl.searchParams)) {
    return null;
  }

  const config = getSupabaseEnvConfig();

  // If env vars aren't set (pre-setup or local dev without .env.local), let through
  if (!config) return null;

  let response = NextResponse.next({ request });

  const supabase = createServerClient(config.url, config.anonKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        cookiesToSet.forEach(({ name, value }) => {
          request.cookies.set(name, value);
        });
        response = NextResponse.next({ request });
        cookiesToSet.forEach(({ name, value, options }) => {
          response.cookies.set(name, value, options);
        });
      },
    },
  });

  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json(
      { error: 'Not authenticated' },
      { status: 401 }
    );
  }

  // Authenticated — pass through with any refreshed cookies
  const authResponse = NextResponse.next({ request });
  response.cookies.getAll().forEach((cookie) => {
    authResponse.cookies.set(cookie.name, cookie.value);
  });

  return authResponse;
}

/** The published-at stamp is cached process-wide, which only fits a single site. */
async function prefetchSiteStamp(): Promise<void> {
  if (!isMultiTenant()) await prefetchYcodePublishedAt();
}

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // MCP endpoints use their own token-based authentication — skip session auth.
  // Cloud overlay proxies MUST also exempt these paths to avoid login redirects.
  //   - `/ycode/mcp/<token>`: legacy URL-token endpoint (Cursor, Windsurf, etc.)
  //   - `/ycode/mcp`: OAuth Bearer-token endpoint (Claude.ai web, ChatGPT)
  if (pathname === '/ycode/mcp' || pathname.startsWith('/ycode/mcp/')) {
    const tenantId = isPlatformAuth() ? await resolveMcpTenant(request) : null;
    return withPathname(NextResponse.next(), request, pathname, tenantId);
  }

  // Debug escape hatch: skip auth on preview routes when explicitly enabled.
  const skipPreviewAuth = process.env.DISABLE_PREVIEW_AUTH === 'true'
    && pathname.startsWith('/ycode/preview');

  // Protect API and preview routes with auth. `/api/templates` lives outside the
  // `/ycode` tree (public site route group) but exposes destructive builder-only
  // operations (apply/export), so it must be gated here too.
  const isAuthRoute = !skipPreviewAuth && (pathname.startsWith('/ycode/api') || pathname.startsWith('/ycode/preview') || pathname.startsWith('/api/templates'));

  const isPublicPage = !pathname.startsWith('/ycode')
    && !pathname.startsWith('/_next')
    && !pathname.startsWith('/api')
    && !pathname.startsWith('/dynamic');

  // Route handlers served on site domains that are not pages (assets, SEO
  // files, well-known endpoints such as the OAuth discovery for MCP clients)
  const isSiteFileRoute = pathname.startsWith('/a/')
    || pathname.startsWith('/.well-known/')
    || ['/robots.txt', '/sitemap.xml', '/llms.txt'].includes(pathname);

  // Plain Postgres: platform sessions instead of Supabase Auth, plus tenant resolution
  let tenantId: string | null = null;
  if (isPlatformAuth()) {
    const routing = await resolvePlatformRequest(request, {
      protectedRoute: isAuthRoute && !isPublicApiRoute(pathname, request.method, request.nextUrl.searchParams),
      // Stored files are public and carry their tenant in the path
      builderPage: pathname.startsWith('/ycode') && !isAuthRoute && !pathname.startsWith('/ycode/storage/'),
      publicPage: (isPublicPage && !isSiteFileRoute) || pathname.startsWith('/dynamic'),
    });
    if (routing.response) return routing.response;
    tenantId = routing.tenantId;
  } else if (isAuthRoute) {
    const authResponse = await verifyApiAuth(request);
    if (authResponse) {
      if (authResponse.status === 401) {
        if (pathname.startsWith('/ycode/preview')) {
          return NextResponse.redirect(new URL('/ycode', request.url));
        }
        return authResponse;
      }
      // Authenticated — pass through
      return withPathname(authResponse, request, pathname);
    }
  }

  const hasPaginationParams = Array.from(request.nextUrl.searchParams.keys())
    .some((key) => key.startsWith('p_'));

  // Multi-tenant: the static route cache is keyed by path only, which would mix
  // sites, so every page renders through the dynamic route (data caches stay
  // keyed per tenant)
  if (isPublicPage && !isSiteFileRoute && (hasPaginationParams || tenantId)) {
    const rewriteUrl = request.nextUrl.clone();
    rewriteUrl.pathname = pathname === '/' ? '/dynamic' : `/dynamic${pathname}`;

    const requestHeaders = withTenantHeader(request.headers, tenantId);
    requestHeaders.set('x-pathname', pathname);
    const rewriteResponse = NextResponse.rewrite(rewriteUrl, {
      request: { headers: requestHeaders },
    });
    rewriteResponse.headers.set('x-pathname', pathname);
    await applySecurityHeaders(rewriteResponse, tenantId ?? undefined);
    await prefetchSiteStamp();
    return rewriteResponse;
  }

  // Create response
  const response = withPathname(NextResponse.next(), request, pathname, tenantId);

  // Cache-Control for public pages is configured centrally via next.config.ts headers().

  // Apply configurable security headers to public pages only (not builder/API).
  if (isPublicPage) {
    await applySecurityHeaders(response, tenantId ?? undefined);
    await prefetchSiteStamp();
  }

  return response;
}

export const config = {
  matcher: [
    /*
     * Match all request paths except:
     * - _next/static (static files)
     * - _next/image (image optimization files)
     * - favicon.ico (favicon file)
     */
    '/((?!_next/static|_next/image|favicon.ico).*)',
  ],
};
