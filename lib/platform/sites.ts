/**
 * Sites
 *
 * A site is an organization (= tenant). Each one gets a free subdomain
 * `<slug>.<PLATFORM_SITES_DOMAIN>`, so slugs are restricted to valid,
 * non-reserved DNS labels. How many sites a user may own is a per-account
 * setting (`siteLimit`, default 1).
 */

import { PLATFORM_SCHEMA, getHomeSiteSlug, getSitesDomain } from './config';
import { getPlatformPool } from './db';

export const DEFAULT_SITE_LIMIT = 1;

/** Subdomains that belong to the platform, not to sites */
const RESERVED_SLUGS = new Set([
  'app', 'builder', 'stats', 'www', 'api', 'admin', 'auth', 'login', 'signin', 'signup', 'account', 'accounts',
  'dashboard', 'mail', 'email', 'smtp', 'imap', 'pop', 'ftp', 'cdn', 'static', 'assets',
  'media', 'files', 'storage', 'status', 'help', 'support', 'docs', 'blog', 'billing',
  'ns1', 'ns2', 'mx', 'test', 'staging', 'dev', 'ycode', 'mcp', 'oauth',
]);

const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/;

/** Error message for an invalid slug, or null when it can be used */
export function validateSiteSlug(slug: unknown): string | null {
  if (typeof slug !== 'string' || !SLUG_PATTERN.test(slug)) {
    return 'Use 3–40 lowercase letters, numbers and dashes, starting and ending with a letter or number';
  }
  if (slug.includes('--')) return 'Consecutive dashes are not allowed';
  if (RESERVED_SLUGS.has(slug)) return 'This address is reserved';
  return null;
}

export function getSiteUrl(slug: string): string | null {
  const domain = getSitesDomain();
  return domain ? `https://${slug}.${domain}` : null;
}

/**
 * Where a site is served (its other addresses redirect there): its primary
 * custom domain, the sites domain itself for the home site, else its subdomain.
 */
export function getSiteAddress(slug: string, primaryDomain: string | null): string | null {
  if (primaryDomain) return `https://${primaryDomain}`;
  const domain = getSitesDomain();
  if (domain && slug === getHomeSiteSlug()) return `https://${domain}`;
  return getSiteUrl(slug);
}

/**
 * Whether a site is served on its own address: a primary custom domain, or
 * the sites domain itself for the home site. It then has no "Made in …"
 * badge and gets visitor statistics (later a paid plan); on its free
 * subdomain it shows the badge and is not tracked.
 */
export function hasOwnAddress(slug: string, primaryDomain: string | null): boolean {
  return Boolean(primaryDomain) || slug === getHomeSiteSlug();
}

export async function countOwnedSites(userId: string): Promise<number> {
  const { rows } = await getPlatformPool().query(
    `select count(*)::int as count from ${PLATFORM_SCHEMA}.member where "userId" = $1 and role = 'owner'`,
    [userId],
  );
  return rows[0].count;
}

export interface SiteSummary {
  id: string;
  name: string;
  slug: string;
  role: string;
  url: string | null;
  domains: string[];
  /** Published pages show the platform badge: the site has no own address (see hasOwnAddress) */
  badge: boolean;
  active: boolean;
}

/** Sites the user is a member of, with their verified custom domains */
export async function listSites(userId: string, activeSiteId: string | null): Promise<SiteSummary[]> {
  const { rows } = await getPlatformPool().query(
    `select o.id, o.name, o.slug, m.role,
       coalesce(array_agg(d.hostname order by d.is_primary desc, d.hostname) filter (where d.verified_at is not null), '{}') as domains,
       max(d.hostname) filter (where d.verified_at is not null and d.is_primary) as primary_domain
     from ${PLATFORM_SCHEMA}.member m
     join ${PLATFORM_SCHEMA}.organization o on o.id = m."organizationId"
     left join ${PLATFORM_SCHEMA}.domains d on d.tenant_id = o.id
     where m."userId" = $1
     group by o.id, o.name, o.slug, m.role, o."createdAt"
     order by o."createdAt"`,
    [userId],
  );

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    slug: row.slug,
    role: row.role,
    url: getSiteAddress(row.slug, row.primary_domain),
    domains: row.domains,
    badge: !hasOwnAddress(row.slug, row.primary_domain),
    active: row.id === activeSiteId,
  }));
}

/** Slug of a site, for redirects from its own domain to the editor */
export async function getSiteSlug(siteId: string): Promise<string | null> {
  const { rows } = await getPlatformPool().query(`select slug from ${PLATFORM_SCHEMA}.organization where id = $1`, [siteId]);
  return rows[0]?.slug ?? null;
}

/** The user's role on a site, or null when they are not a member */
export async function getSiteMembership(userId: string, siteId: string): Promise<{ role: string; slug: string } | null> {
  const { rows } = await getPlatformPool().query(
    `select m.role, o.slug from ${PLATFORM_SCHEMA}.member m
     join ${PLATFORM_SCHEMA}.organization o on o.id = m."organizationId"
     where m."userId" = $1 and m."organizationId" = $2`,
    [userId, siteId],
  );
  return rows[0] ?? null;
}

/** Where a site is served (see getSiteAddress), by its id */
export async function getSiteAddressById(siteId: string): Promise<string | null> {
  const { rows } = await getPlatformPool().query(
    `select o.slug, d.hostname as primary_domain from ${PLATFORM_SCHEMA}.organization o
     left join ${PLATFORM_SCHEMA}.domains d on d.tenant_id = o.id and d.is_primary and d.verified_at is not null
     where o.id = $1`,
    [siteId],
  );
  return rows[0] ? getSiteAddress(rows[0].slug, rows[0].primary_domain) : null;
}
