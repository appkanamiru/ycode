/**
 * Platform Configuration
 *
 * The platform layer (accounts, organizations = tenants, domains) replaces
 * Supabase Auth when the database runs on plain Postgres
 * (YCODE_DB_DRIVER=postgres). Its tables live in their own schema, apart from
 * the site content in `public`.
 */

export const PLATFORM_SCHEMA = 'platform';

/** Better Auth endpoints, e.g. POST /ycode/api/platform/auth/sign-in/email */
export const PLATFORM_AUTH_BASE_PATH = '/ycode/api/platform/auth';

/**
 * Request header carrying the resolved tenant from the proxy to the app.
 * The proxy always strips it from incoming requests, so it cannot be spoofed.
 */
export const TENANT_HEADER = 'x-ycode-tenant-id';

export function isPlatformAuth(): boolean {
  return process.env.YCODE_DB_DRIVER === 'postgres';
}

/**
 * Optional wildcard domain for sites, e.g. `sites.example.com` serves the
 * organization with slug `acme` at `acme.sites.example.com`.
 */
export function getSitesDomain(): string | null {
  return process.env.PLATFORM_SITES_DOMAIN?.toLowerCase() || null;
}

/**
 * The site served on the sites domain itself (PLATFORM_HOME_SITE, a site
 * slug): `example.com` shows it and `www.example.com` redirects there.
 * Without it both redirect to the editor.
 */
export function getHomeSiteSlug(): string | null {
  return process.env.PLATFORM_HOME_SITE?.trim().toLowerCase() || null;
}

/** The sites domain itself or its www, which the home site is served on */
export function isSitesApexHost(hostname: string | null): boolean {
  const sitesDomain = getSitesDomain();
  return Boolean(sitesDomain && hostname && (hostname === sitesDomain || hostname === `www.${sitesDomain}`));
}

/** Link in invitation emails: the editor's accept page */
export function getInvitationUrl(invitationId: string): string {
  const base = process.env.BETTER_AUTH_URL?.replace(/\/+$/, '') ?? '';
  return `${base}/ycode/accept-invite?invitation=${encodeURIComponent(invitationId)}`;
}

/** Accounts that run the platform (PLATFORM_ADMIN_EMAILS, comma separated) */
export function isPlatformAdmin(email: string | null | undefined): boolean {
  if (!email) return false;
  const admins = (process.env.PLATFORM_ADMIN_EMAILS ?? '')
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
  return admins.includes(email.trim().toLowerCase());
}

export interface UmamiConfig {
  /** Where the app reaches Umami, e.g. http://umami:3000 */
  url: string;
  /** Where people open Umami, e.g. https://stats.example.com */
  publicUrl: string;
  /** Password of Umami's `admin` account, set on first use */
  adminPassword: string;
}

/** Visitor statistics through Umami; null when not configured */
export function getUmamiConfig(): UmamiConfig | null {
  const url = process.env.UMAMI_URL?.trim().replace(/\/+$/, '');
  const publicUrl = process.env.UMAMI_PUBLIC_URL?.trim().replace(/\/+$/, '');
  const adminPassword = process.env.UMAMI_ADMIN_PASSWORD?.trim();
  if (!url || !publicUrl || !adminPassword) return null;
  return { url, publicUrl, adminPassword };
}

/**
 * Path on every site's own host that Caddy forwards to Umami (the tracker
 * script and its collect endpoint), so blockers of third-party trackers
 * and the sites' CSP see a first-party request.
 */
export const UMAMI_SITE_PATH = '/_umami';
