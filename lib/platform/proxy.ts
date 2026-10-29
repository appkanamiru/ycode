/**
 * Platform Request Routing (used by proxy.ts)
 *
 * Authenticates builder requests with the platform session and, in
 * multi-tenant mode, resolves the tenant each request belongs to.
 */

import { NextResponse, type NextRequest } from 'next/server';

import { isMultiTenant } from '@/lib/database/tenancy';
import { findTenantByMcpToken } from './mcp';
import { normalizeHostname, resolveBuilderAccess, resolveTenantByHost } from './tenants';

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

export async function resolvePlatformRequest(
  request: NextRequest,
  route: { protectedRoute: boolean; builderPage: boolean; publicPage: boolean },
): Promise<PlatformRouting> {
  const multiTenant = isMultiTenant();

  if (route.protectedRoute) {
    const access = await resolveBuilderAccess(request.headers);
    if (!access) {
      return request.nextUrl.pathname.startsWith('/ycode/preview')
        ? { response: NextResponse.redirect(new URL('/ycode', request.url)), tenantId: null }
        : { response: NextResponse.json({ error: 'Not authenticated' }, { status: 401 }), tenantId: null };
    }
    // Platform endpoints (account, creating a site) work before a site is active
    if (multiTenant && !access.tenantId && !request.nextUrl.pathname.startsWith('/ycode/api/platform/')) {
      return { response: NextResponse.json({ error: 'No active site' }, { status: 403 }), tenantId: null };
    }
    return { tenantId: access.tenantId };
  }

  if (route.builderPage) {
    const access = await resolveBuilderAccess(request.headers);
    return { tenantId: access?.tenantId ?? null };
  }

  if (!multiTenant) return { tenantId: null };

  const host = request.headers.get('host');
  const tenantId = await resolveTenantByHost(host);

  if (!tenantId && route.publicPage) {
    if (isBuilderHost(host)) {
      return { response: NextResponse.redirect(new URL('/ycode', request.url)), tenantId: null };
    }
    return { response: new NextResponse('Site not found', { status: 404 }), tenantId: null };
  }

  return { tenantId };
}

/**
 * Tenant of an MCP request, from its token: `/ycode/mcp/<token>` or
 * `Authorization: Bearer <token>`. Unknown tokens resolve to no tenant, and
 * the route then rejects them.
 */
export async function resolveMcpTenant(request: NextRequest): Promise<string | null> {
  if (!isMultiTenant()) return null;

  const pathToken = request.nextUrl.pathname.match(/^\/ycode\/mcp\/([^/]+)/)?.[1];
  const bearerToken = request.headers.get('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  const token = pathToken ? decodeURIComponent(pathToken) : bearerToken;

  return token ? findTenantByMcpToken(token) : null;
}
