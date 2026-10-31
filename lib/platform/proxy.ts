/**
 * Platform Request Routing (used by proxy.ts)
 *
 * Authenticates builder requests with the platform session and, in
 * multi-tenant mode, resolves the tenant each request belongs to.
 */

import { NextResponse, type NextRequest } from 'next/server';

import { isMultiTenant } from '@/lib/database/tenancy';
import { isSitesApexHost } from './config';
import { findTenantByMcpToken } from './mcp';
import { getSiteSlug } from './sites';
import { normalizeHostname, resolveBuilderAccess, resolvePrimaryHost, resolveTenantByHost } from './tenants';

export interface PlatformRouting {
  /** Respond directly (unauthenticated, unknown site, ...) */
  response?: NextResponse;
  tenantId: string | null;
}

function isBuilderHost(host: string | null): boolean {
  const builderUrl = process.env.BETTER_AUTH_URL;
  if (!builderUrl) return false;
  return normalizeHostname(host) === normalizeHostname(new URL(builderUrl).host);
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Origin of the editor: BETTER_AUTH_URL (the request's own origin is internal behind a proxy) */
function getBuilderOrigin(request: NextRequest): string {
  return process.env.BETTER_AUTH_URL ? new URL(process.env.BETTER_AUTH_URL).origin : request.nextUrl.origin;
}

/**
 * Writes to the builder API must come from the editor itself. Sites on
 * sibling subdomains count as the same site for browsers, so SameSite
 * cookies alone don't stop their scripts from sending a visitor's session.
 */
function isCrossOriginWrite(request: NextRequest): boolean {
  if (SAFE_METHODS.has(request.method)) return false;

  const fetchSite = request.headers.get('sec-fetch-site');
  if (fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'none') return true;

  const origin = request.headers.get('origin');
  return Boolean(origin) && origin !== getBuilderOrigin(request);
}

/**
 * A site with a primary domain is served there only: its other hostnames
 * redirect permanently. Browsers keep the redirect for an hour, so a later
 * change of the primary domain reaches returning visitors.
 */
async function redirectToPrimaryHost(request: NextRequest, tenantId: string, host: string | null): Promise<NextResponse | null> {
  const primary = await resolvePrimaryHost(tenantId);
  if (!primary || normalizeHostname(host) === primary) return null;

  const protocol = request.headers.get('x-forwarded-proto') === 'http' ? 'http' : 'https';
  const target = `${protocol}://${primary}${request.nextUrl.pathname}${request.nextUrl.search}`;
  const response = NextResponse.redirect(target, 301);
  response.headers.set('Cache-Control', 'public, max-age=3600');
  return response;
}

export async function resolvePlatformRequest(
  request: NextRequest,
  route: { protectedRoute: boolean; builderPage: boolean; publicPage: boolean; publicApi: boolean; siteContent?: boolean; siteFile?: boolean },
): Promise<PlatformRouting> {
  const multiTenant = isMultiTenant();
  const { pathname } = request.nextUrl;
  const host = request.headers.get('host');

  // Multi-tenant: the editor is served on the builder host only. On a site's
  // domain, /ycode opens the editor for that site, and the builder API is not
  // served (except the public endpoints its published pages call).
  if (multiTenant && pathname.startsWith('/ycode') && !isBuilderHost(host) && !route.publicApi && !pathname.startsWith('/ycode/storage/')) {
    const tenantId = await resolveTenantByHost(host);
    const slug = tenantId ? await getSiteSlug(tenantId) : null;
    if (slug && route.builderPage && process.env.BETTER_AUTH_URL) {
      const editor = new URL('/ycode', process.env.BETTER_AUTH_URL);
      editor.searchParams.set('site', slug);
      return { response: NextResponse.redirect(editor), tenantId: null };
    }
    return { response: new NextResponse('Not found', { status: 404 }), tenantId: null };
  }

  // Every endpoint authorized by the session cookie needs the origin check,
  // including the ones that verify the session themselves (team, account)
  const cookieAuthorized = route.protectedRoute
    || pathname.startsWith('/ycode/api/auth/')
    || pathname.startsWith('/ycode/api/platform/');
  if (cookieAuthorized && isCrossOriginWrite(request)) {
    return { response: NextResponse.json({ error: 'Cross-origin request rejected' }, { status: 403 }), tenantId: null };
  }

  if (route.protectedRoute) {
    const access = await resolveBuilderAccess(request.headers);
    if (!access) {
      return pathname.startsWith('/ycode/preview')
        ? { response: NextResponse.redirect(new URL('/ycode', request.url)), tenantId: null }
        : { response: NextResponse.json({ error: 'Not authenticated' }, { status: 401 }), tenantId: null };
    }
    // Account-level endpoints (platform, profile) work without an active site
    const accountLevel = pathname.startsWith('/ycode/api/platform/')
      || pathname.startsWith('/ycode/api/profile')
      // The MCP consent names its site explicitly
      || pathname === '/ycode/api/oauth/authorize';
    if (multiTenant && !access.tenantId && !accountLevel) {
      return { response: NextResponse.json({ error: 'No active site' }, { status: 403 }), tenantId: null };
    }
    return { tenantId: access.tenantId };
  }

  if (route.builderPage) {
    const access = await resolveBuilderAccess(request.headers);
    return { tenantId: access?.tenantId ?? null };
  }

  if (!multiTenant) return { tenantId: null };

  const tenantId = await resolveTenantByHost(host);

  // The editor shows the active site's images through the asset proxy (/a/)
  // on its own host; asset ids are unique across sites
  if (!tenantId && pathname.startsWith('/a/') && isBuilderHost(host)) {
    const access = await resolveBuilderAccess(request.headers);
    return { tenantId: access?.tenantId ?? null };
  }

  if (tenantId && route.siteContent && SAFE_METHODS.has(request.method)) {
    const redirect = await redirectToPrimaryHost(request, tenantId, host);
    if (redirect) return { response: redirect, tenantId: null };
  }

  // robots.txt, sitemap.xml, ... belong to a site: none on unknown hosts, and
  // the editor's host is not indexed
  if (!tenantId && route.siteFile) {
    if (isBuilderHost(host) && pathname === '/robots.txt') {
      return { response: new NextResponse('User-agent: *\nDisallow: /\n', { headers: { 'Content-Type': 'text/plain' } }), tenantId: null };
    }
    return { response: new NextResponse('Not found', { status: 404 }), tenantId: null };
  }

  if (!tenantId && route.publicPage) {
    // No home site: the sites domain itself leads to the editor
    if (isSitesApexHost(normalizeHostname(host)) && process.env.BETTER_AUTH_URL) {
      return { response: NextResponse.redirect(new URL('/ycode', process.env.BETTER_AUTH_URL), 302), tenantId: null };
    }
    if (isBuilderHost(host)) {
      return { response: NextResponse.redirect(new URL('/ycode', request.url)), tenantId: null };
    }
    return { response: new NextResponse('Site not found', { status: 404 }), tenantId: null };
  }

  return { tenantId };
}

/**
 * Tenant of an MCP request, from its token: `/ycode/mcp/<token>` or
 * `Authorization: Bearer <token>`. Unknown tokens, and tokens of another
 * site than the one whose address the request came to, resolve to no
 * tenant, and the route then rejects them.
 */
export async function resolveMcpTenant(request: NextRequest): Promise<string | null> {
  if (!isMultiTenant()) return null;
  const host = request.headers.get('host');

  const pathToken = request.nextUrl.pathname.match(/^\/ycode\/mcp\/([^/]+)/)?.[1];
  const bearerToken = request.headers.get('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  const token = pathToken ? decodeURIComponent(pathToken) : bearerToken;

  const tenantId = token ? await findTenantByMcpToken(token) : null;

  // On a site's own address (`<slug>.<sites domain>/ycode/mcp`) the
  // connection is for that site only
  if (tenantId && !isBuilderHost(host)) {
    return await resolveTenantByHost(host) === tenantId ? tenantId : null;
  }
  return tenantId;
}
