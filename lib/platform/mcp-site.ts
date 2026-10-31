/**
 * MCP Site Instructions
 *
 * Kept apart from ./mcp, which the request proxy imports.
 */

import type { CreateMcpServerOptions } from '@/lib/mcp/server';
import { isMultiTenant } from '@/lib/database/tenancy';
import { getTenantIdFromHeaders } from '@/lib/supabase-server';
import { getHomeSiteSlug, getSitesDomain, PLATFORM_SCHEMA } from './config';
import { getPlatformPool } from './db';
import { normalizeHostname, resolveTenantByHost } from './tenants';

/**
 * Server instructions naming the site an MCP connection works on. Agents
 * with several website builders connected see the same tools on each, so
 * this is how they tell which one edits the site they were asked about.
 */
export async function getMcpSiteOptions(): Promise<CreateMcpServerOptions | undefined> {
  if (!isMultiTenant()) return undefined;
  const tenantId = await getTenantIdFromHeaders();
  if (!tenantId) return undefined;

  const { rows } = await getPlatformPool().query(
    `select o.name, o.slug,
       array(select d.hostname from ${PLATFORM_SCHEMA}.domains d
             where d.tenant_id = o.id and d.verified_at is not null
             order by d.is_primary desc, d.created_at) as domains
     from ${PLATFORM_SCHEMA}.organization o where o.id = $1`,
    [tenantId],
  );
  const site = rows[0] as { name: string; slug: string; domains: string[] } | undefined;
  if (!site) return undefined;

  const sitesDomain = getSitesDomain();
  const home = sitesDomain && site.slug === getHomeSiteSlug() ? [sitesDomain] : [];
  const addresses = [...home, ...site.domains, ...(sitesDomain ? [`${site.slug}.${sitesDomain}`] : [])]
    .map((hostname) => `https://${hostname}`);

  return {
    extraInstructions: `## Connected site

This connection works on the site ${JSON.stringify(site.name)}${addresses.length ? ` (${addresses.join(', ')})` : ''}.
Every tool reads and changes this site only. If several website builders are connected, check that this is
the site you were asked to work on before making changes.`,
  };
}

/**
 * The site an OAuth `resource` (RFC 8707) is for: the MCP endpoint on a
 * site's own address names that site. Undefined for the editor's endpoint
 * (or none given), where the user picks the site; null for an address no
 * site has.
 */
export async function resolveResourceSite(resource: string | null): Promise<string | null | undefined> {
  if (!resource || !isMultiTenant()) return undefined;
  let host: string | null;
  try {
    host = normalizeHostname(new URL(resource).host);
  } catch {
    return null;
  }
  const builderHost = process.env.BETTER_AUTH_URL ? normalizeHostname(new URL(process.env.BETTER_AUTH_URL).host) : null;
  if (host === builderHost) return undefined;
  return resolveTenantByHost(host);
}
