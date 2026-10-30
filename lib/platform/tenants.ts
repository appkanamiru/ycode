/**
 * Tenant Resolution
 *
 * - Public site requests: hostname -> tenant, via a verified custom domain or
 *   `<organization slug>.<PLATFORM_SITES_DOMAIN>`
 * - Builder requests: session -> active organization, re-checked against the
 *   membership on every request so removed members lose access immediately
 */

import { resolveRole, type UserRole } from '@/lib/roles';
import { isMultiTenant } from '@/lib/database/tenancy';
import { getSitesDomain, PLATFORM_SCHEMA } from './config';
import { getPlatformPool } from './db';
import { getPlatformAuth } from './auth';

const HOST_CACHE_TTL_MS = 30_000;
const globalForHosts = globalThis as unknown as {
  __platformHostCache?: Map<string, { tenantId: string | null; expiresAt: number }>;
  __platformPrimaryHostCache?: Map<string, { hostname: string | null; expiresAt: number }>;
};
/** On globalThis: the proxy and the routes that change domains are separate bundles */
const hostCache = globalForHosts.__platformHostCache ??= new Map();
const primaryHostCache = globalForHosts.__platformPrimaryHostCache ??= new Map();

export function normalizeHostname(host: string | null): string | null {
  if (!host) return null;
  return host.trim().toLowerCase().replace(/:\d+$/, '').replace(/\.$/, '') || null;
}

async function lookupTenantByHostname(hostname: string): Promise<string | null> {
  const pool = getPlatformPool();
  const sitesDomain = getSitesDomain();

  if (sitesDomain && hostname.endsWith(`.${sitesDomain}`)) {
    const slug = hostname.slice(0, -(sitesDomain.length + 1));
    if (slug.includes('.')) return null;
    const { rows } = await pool.query(`select id from ${PLATFORM_SCHEMA}.organization where slug = $1`, [slug]);
    return rows[0]?.id ?? null;
  }

  const { rows } = await pool.query(
    `select tenant_id from ${PLATFORM_SCHEMA}.domains where hostname = $1 and verified_at is not null`,
    [hostname],
  );
  return rows[0]?.tenant_id ?? null;
}

/** Drop a cached lookup after the hostname's domain changed (this instance only) */
export function forgetHostname(host: string): void {
  const hostname = normalizeHostname(host);
  if (hostname) hostCache.delete(hostname);
}

export async function resolveTenantByHost(host: string | null): Promise<string | null> {
  const hostname = normalizeHostname(host);
  if (!hostname) return null;

  const cached = hostCache.get(hostname);
  if (cached && cached.expiresAt > Date.now()) return cached.tenantId;

  const tenantId = await lookupTenantByHostname(hostname);
  hostCache.set(hostname, { tenantId, expiresAt: Date.now() + HOST_CACHE_TTL_MS });
  return tenantId;
}

/** Drop a site's cached primary domain after it changed (this instance only) */
export function forgetPrimaryHost(tenantId: string): void {
  primaryHostCache.delete(tenantId);
}

/**
 * The custom domain a site's other hostnames redirect to, or null when the
 * site has none set (it is then served on all of them).
 */
export async function resolvePrimaryHost(tenantId: string): Promise<string | null> {
  const cached = primaryHostCache.get(tenantId);
  if (cached && cached.expiresAt > Date.now()) return cached.hostname;

  const { rows } = await getPlatformPool().query(
    `select hostname from ${PLATFORM_SCHEMA}.domains where tenant_id = $1 and is_primary and verified_at is not null`,
    [tenantId],
  );
  const hostname: string | null = rows[0]?.hostname ?? null;
  primaryHostCache.set(tenantId, { hostname, expiresAt: Date.now() + HOST_CACHE_TTL_MS });
  return hostname;
}

export interface BuilderAccess {
  user: { id: string; email: string; name: string; image?: string | null };
  /** Active organization, when it is a membership (multi-tenant only) */
  tenantId: string | null;
  role: UserRole;
}

/**
 * Resolve the signed-in user and their active site from the request headers
 * (session cookie). Returns null when there is no valid session.
 */
export async function resolveBuilderAccess(headers: Headers): Promise<BuilderAccess | null> {
  const session = await getPlatformAuth().api.getSession({ headers });
  if (!session) return null;

  const user = {
    id: session.user.id,
    email: session.user.email,
    name: session.user.name,
    image: session.user.image,
  };

  // Single-tenant: sign up is limited to the first account, which owns the site
  if (!isMultiTenant()) {
    return { user, tenantId: null, role: 'owner' };
  }

  const organizationId = session.session.activeOrganizationId;
  if (!organizationId) return { user, tenantId: null, role: resolveRole(null) };

  const { rows } = await getPlatformPool().query(
    `select role from ${PLATFORM_SCHEMA}.member where "organizationId" = $1 and "userId" = $2`,
    [organizationId, user.id],
  );
  if (!rows[0]) return { user, tenantId: null, role: resolveRole(null) };

  return { user, tenantId: organizationId, role: resolveRole(rows[0].role) };
}
