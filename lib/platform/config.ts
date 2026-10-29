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
