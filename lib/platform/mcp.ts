/**
 * MCP Tenant Resolution
 *
 * MCP clients connect to one endpoint on the builder host for every site, so
 * the credential identifies the tenant. These lookups deliberately run across
 * tenants and return only the tenant id; validating the credential stays with
 * the repositories, which then run scoped to that tenant.
 */

import { createHash } from 'crypto';

import { getPlatformPool } from './db';

const CACHE_TTL_MS = 60_000;
const cache = new Map<string, { tenantId: string | null; expiresAt: number }>();

async function lookup(key: string, sql: string, value: string): Promise<string | null> {
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.tenantId;

  const { rows } = await getPlatformPool().query(sql, [value]);
  const tenantId: string | null = rows[0]?.tenant_id ?? null;
  // Only hits are cached: a token issued a moment ago must work right away
  if (tenantId) cache.set(key, { tenantId, expiresAt: Date.now() + CACHE_TTL_MS });
  return tenantId;
}

/** Tenant of an MCP access token (URL token or OAuth bearer token). */
export function findTenantByMcpToken(token: string): Promise<string | null> {
  return lookup(`token:${token}`, 'select tenant_id from mcp_tokens where token = $1', token);
}

/** Tenant of an OAuth token request (authorization code or refresh token). */
export async function findTenantByOAuthGrant(grant: {
  grant_type?: string;
  code?: string;
  refresh_token?: string;
}): Promise<string | null> {
  if (grant.grant_type === 'authorization_code' && grant.code) {
    const { rows } = await getPlatformPool().query('select tenant_id from mcp_oauth_codes where code = $1', [grant.code]);
    return rows[0]?.tenant_id ?? null;
  }

  if (grant.grant_type === 'refresh_token' && grant.refresh_token) {
    // Stored hashed, the same way mcpTokenRepository does
    const hash = createHash('sha256').update(grant.refresh_token).digest('hex');
    const { rows } = await getPlatformPool().query('select tenant_id from mcp_tokens where refresh_token_hash = $1', [hash]);
    return rows[0]?.tenant_id ?? null;
  }

  return null;
}
