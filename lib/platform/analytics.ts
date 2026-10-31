/**
 * Visitor Statistics (Umami)
 *
 * Every site gets an Umami website, created on first need and remembered in
 * platform.site_analytics; published pages load the tracker from the site's
 * own host (see UMAMI_SITE_PATH). The app signs in to Umami as its `admin`
 * account, whose default password it replaces with UMAMI_ADMIN_PASSWORD the
 * first time. Platform admins open Umami through its SSO page with a token
 * the app obtains, so their editor session is the only login they need.
 */

import { getUmamiConfig, PLATFORM_SCHEMA, type UmamiConfig } from './config';
import { getPlatformPool } from './db';
import { getSiteAddress } from './sites';

export const SITE_ANALYTICS_TABLE_SQL = `
  create table if not exists ${PLATFORM_SCHEMA}.site_analytics (
    tenant_id uuid primary key references ${PLATFORM_SCHEMA}.organization (id) on delete cascade,
    website_id uuid not null,
    created_at timestamptz not null default now()
  );`;

const UMAMI_ADMIN = 'admin';
/** Umami's password for `admin` on a fresh database */
const UMAMI_DEFAULT_PASSWORD = 'umami';
const WEBSITE_CACHE_TTL_MS = 5 * 60_000;
/** A site without a website is retried at most this often */
const ENSURE_RETRY_MS = 5 * 60_000;

const globalForAnalytics = globalThis as unknown as {
  __umamiToken?: string | null;
  __umamiWebsiteCache?: Map<string, { websiteId: string | null; expiresAt: number }>;
  __umamiEnsureAttempts?: Map<string, number>;
  __umamiEnsureInFlight?: Map<string, Promise<string | null>>;
};
const websiteCache = globalForAnalytics.__umamiWebsiteCache ??= new Map();
const ensureAttempts = globalForAnalytics.__umamiEnsureAttempts ??= new Map();
const ensureInFlight = globalForAnalytics.__umamiEnsureInFlight ??= new Map();

export class UmamiError extends Error {}

async function login(config: UmamiConfig, password: string): Promise<string | null> {
  const response = await fetch(`${config.url}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: UMAMI_ADMIN, password }),
  });
  if (response.status === 401) return null;
  if (!response.ok) throw new UmamiError(`Umami sign-in failed (${response.status})`);
  return (await response.json()).token ?? null;
}

/** Sign in as admin, first replacing the default password of a fresh Umami */
async function signIn(config: UmamiConfig): Promise<string> {
  const token = await login(config, config.adminPassword);
  if (token) return token;

  const initial = await login(config, UMAMI_DEFAULT_PASSWORD);
  if (!initial) throw new UmamiError('Umami rejected UMAMI_ADMIN_PASSWORD');
  const changed = await fetch(`${config.url}/api/me/password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${initial}` },
    body: JSON.stringify({ currentPassword: UMAMI_DEFAULT_PASSWORD, newPassword: config.adminPassword }),
  });
  if (!changed.ok) throw new UmamiError(`Could not set the Umami admin password (${changed.status})`);

  const token2 = await login(config, config.adminPassword);
  if (!token2) throw new UmamiError('Umami rejected the new admin password');
  return token2;
}

async function getToken(config: UmamiConfig, renew = false): Promise<string> {
  if (renew || !globalForAnalytics.__umamiToken) {
    globalForAnalytics.__umamiToken = await signIn(config);
  }
  return globalForAnalytics.__umamiToken;
}

/** Umami API call as admin; signs in again once when the token expired */
async function umamiFetch(config: UmamiConfig, path: string, init: RequestInit = {}): Promise<Response> {
  const send = async (token: string) => fetch(`${config.url}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init.headers, Authorization: `Bearer ${token}` },
  });
  const response = await send(await getToken(config));
  return response.status === 401 ? send(await getToken(config, true)) : response;
}

/** How Umami lists a site: its name, and the host it is served on */
async function getWebsiteLabel(tenantId: string): Promise<{ name: string; domain: string } | null> {
  const { rows } = await getPlatformPool().query(
    `select o.name, o.slug, d.hostname as primary_domain from ${PLATFORM_SCHEMA}.organization o
     left join ${PLATFORM_SCHEMA}.domains d on d.tenant_id = o.id and d.is_primary and d.verified_at is not null
     where o.id = $1`,
    [tenantId],
  );
  if (!rows[0]) return null;
  const address = getSiteAddress(rows[0].slug, rows[0].primary_domain);
  return {
    name: String(rows[0].name || rows[0].slug).slice(0, 100),
    domain: address ? new URL(address).host : rows[0].slug,
  };
}

/** The site's Umami website id, creating the website when it has none */
export async function ensureSiteAnalytics(tenantId: string): Promise<string | null> {
  const config = getUmamiConfig();
  if (!config) return null;

  const running = ensureInFlight.get(tenantId);
  if (running) return running;

  const task = (async () => {
    const pool = getPlatformPool();
    const existing = await pool.query(
      `select website_id from ${PLATFORM_SCHEMA}.site_analytics where tenant_id = $1`,
      [tenantId],
    );
    if (existing.rows[0]) return existing.rows[0].website_id as string;

    const label = await getWebsiteLabel(tenantId);
    if (!label) return null;

    const response = await umamiFetch(config, '/api/websites', { method: 'POST', body: JSON.stringify(label) });
    if (!response.ok) throw new UmamiError(`Could not create the Umami website (${response.status})`);
    const website = await response.json();

    // A concurrent instance may have won: keep its website
    const saved = await pool.query(
      `insert into ${PLATFORM_SCHEMA}.site_analytics (tenant_id, website_id) values ($1, $2)
       on conflict (tenant_id) do update set tenant_id = excluded.tenant_id
       returning website_id`,
      [tenantId, website.id],
    );
    const websiteId: string = saved.rows[0].website_id;
    websiteCache.set(tenantId, { websiteId, expiresAt: Date.now() + WEBSITE_CACHE_TTL_MS });
    return websiteId;
  })();

  ensureInFlight.set(tenantId, task);
  try {
    return await task;
  } finally {
    ensureInFlight.delete(tenantId);
  }
}

/**
 * Bring the site's name and address in Umami up to date, after the site was
 * renamed or its primary domain changed. Sites without a website yet get the
 * current ones when it is created.
 */
export async function syncSiteAnalytics(tenantId: string): Promise<void> {
  const config = getUmamiConfig();
  if (!config) return;
  const { rows } = await getPlatformPool().query(
    `select website_id from ${PLATFORM_SCHEMA}.site_analytics where tenant_id = $1`,
    [tenantId],
  );
  const label = rows[0] && await getWebsiteLabel(tenantId);
  if (!label) return;

  const response = await umamiFetch(config, `/api/websites/${rows[0].website_id}`, {
    method: 'POST',
    body: JSON.stringify(label),
  });
  if (!response.ok) throw new UmamiError(`Could not update the Umami website (${response.status})`);
}

/** Fire-and-forget syncSiteAnalytics: statistics never fail the change that triggered them */
export function syncSiteAnalyticsLater(tenantId: string): void {
  syncSiteAnalytics(tenantId).catch((error) => {
    console.error('[analytics] Could not update the Umami website:', error);
  });
}

/**
 * Website id the site's pages report to, from a short cache. A site without
 * one yet (created before Umami, or while it was down) gets it created in the
 * background and reports from a later request on.
 */
export async function getSiteAnalyticsId(tenantId: string): Promise<string | null> {
  if (!getUmamiConfig()) return null;

  const cached = websiteCache.get(tenantId);
  if (cached && cached.expiresAt > Date.now()) return cached.websiteId;

  const { rows } = await getPlatformPool().query(
    `select website_id from ${PLATFORM_SCHEMA}.site_analytics where tenant_id = $1`,
    [tenantId],
  );
  const websiteId: string | null = rows[0]?.website_id ?? null;
  websiteCache.set(tenantId, { websiteId, expiresAt: Date.now() + WEBSITE_CACHE_TTL_MS });

  if (!websiteId && (ensureAttempts.get(tenantId) ?? 0) + ENSURE_RETRY_MS < Date.now()) {
    ensureAttempts.set(tenantId, Date.now());
    ensureSiteAnalytics(tenantId).catch((error) => {
      console.error('[analytics] Could not create the Umami website:', error);
    });
  }
  return websiteId;
}

/** Address that signs the browser in to Umami and opens its dashboard */
export async function getStatsSignInUrl(): Promise<string | null> {
  const config = getUmamiConfig();
  if (!config) return null;
  const token = await getToken(config, true);
  const url = new URL('/sso', config.publicUrl);
  url.searchParams.set('token', token);
  url.searchParams.set('url', '/websites');
  return url.toString();
}
