/**
 * Platform Auth
 *
 * Better Auth on the platform Postgres schema: accounts and organizations,
 * where each organization is a tenant (one website). Members carry the Ycode
 * roles (owner > admin > designer > editor).
 *
 * Sign in is passwordless (a code sent by email) in multi-tenant mode; a
 * single-tenant install keeps email + password for its setup wizard.
 *
 * Env: DATABASE_URL, BETTER_AUTH_SECRET, BETTER_AUTH_URL (the builder origin),
 * SMTP_URL + MAIL_FROM (sign-in codes).
 */

import { betterAuth, type BetterAuthOptions } from 'better-auth';
import { APIError } from 'better-auth/api';
import { getMigrations } from 'better-auth/db/migration';
import { nextCookies } from 'better-auth/next-js';
import { emailOTP } from 'better-auth/plugins/email-otp';
import { organization } from 'better-auth/plugins/organization';
import { adminAc, memberAc, ownerAc } from 'better-auth/plugins/organization/access';
import { PostgresDialect } from 'kysely';

import { getKnexClient } from '@/lib/knex-client';
import { provisionTenant } from '@/lib/database/tenant-provisioning';
import { setNewSiteName } from './site-defaults';
import { ensureSiteAnalytics, SITE_ANALYTICS_TABLE_SQL } from './analytics';
import { isMultiTenant } from '@/lib/database/tenancy';
import { getInvitationUrl, PLATFORM_AUTH_BASE_PATH, PLATFORM_SCHEMA } from './config';
import { getPlatformPool } from './db';
import { sendSignInCode, sendSiteInvitation } from './mailer';
import { countOwnedSites, DEFAULT_SITE_LIMIT, validateSiteSlug } from './sites';

const DOMAINS_TABLE_SQL = `
  create table if not exists ${PLATFORM_SCHEMA}.domains (
    id uuid primary key default gen_random_uuid(),
    tenant_id uuid not null references ${PLATFORM_SCHEMA}.organization (id) on delete cascade,
    hostname text not null,
    is_primary boolean not null default false,
    verified_at timestamptz,
    created_at timestamptz not null default now()
  );
  create index if not exists idx_domains_tenant_id on ${PLATFORM_SCHEMA}.domains (tenant_id);
  alter table ${PLATFORM_SCHEMA}.domains add column if not exists verification_token text;
  -- Several sites may claim a hostname while pending; only one can verify it
  alter table ${PLATFORM_SCHEMA}.domains drop constraint if exists domains_hostname_key;
  create unique index if not exists domains_verified_hostname_unique
    on ${PLATFORM_SCHEMA}.domains (hostname) where verified_at is not null;
  create unique index if not exists domains_tenant_hostname_unique
    on ${PLATFORM_SCHEMA}.domains (tenant_id, hostname);
  -- One primary domain per site
  create unique index if not exists domains_tenant_primary_unique
    on ${PLATFORM_SCHEMA}.domains (tenant_id) where is_primary;`;

/** OAuth grants of MCP clients connected to a whole account (lib/platform/mcp-account) */
const MCP_ACCOUNT_TABLES_SQL = `
  create table if not exists ${PLATFORM_SCHEMA}.mcp_account_codes (
    code_hash text primary key,
    user_id uuid not null references ${PLATFORM_SCHEMA}."user" (id) on delete cascade,
    client_id text not null,
    redirect_uri text not null,
    code_challenge text not null,
    code_challenge_method text not null,
    expires_at timestamptz not null
  );
  create table if not exists ${PLATFORM_SCHEMA}.mcp_account_tokens (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references ${PLATFORM_SCHEMA}."user" (id) on delete cascade,
    client_id text not null,
    name text not null,
    access_token_hash text not null unique,
    expires_at timestamptz not null,
    refresh_token_hash text not null unique,
    refresh_expires_at timestamptz not null,
    is_active boolean not null default true,
    refresh_grace_until timestamptz,
    created_at timestamptz not null default now(),
    last_used_at timestamptz
  );
  create index if not exists idx_mcp_account_tokens_user_id on ${PLATFORM_SCHEMA}.mcp_account_tokens (user_id);`;

async function countUsers(): Promise<number> {
  const { rows } = await getPlatformPool().query(`select count(*)::int as count from ${PLATFORM_SCHEMA}."user"`);
  return rows[0].count;
}

/** false also before the platform schema exists */
export async function hasPlatformUsers(): Promise<boolean> {
  try {
    return await countUsers() > 0;
  } catch {
    return false;
  }
}

function assertValidSlug(slug: unknown): void {
  const problem = validateSiteSlug(slug);
  if (problem) throw new APIError('BAD_REQUEST', { message: problem });
}

async function firstOrganizationId(userId: string): Promise<string | null> {
  const { rows } = await getPlatformPool().query(
    `select "organizationId" as id from ${PLATFORM_SCHEMA}.member where "userId" = $1 order by "createdAt" limit 1`,
    [userId],
  );
  return rows[0]?.id ?? null;
}

export function createAuthOptions() {
  return {
    appName: 'Ycode',
    basePath: PLATFORM_AUTH_BASE_PATH,
    database: {
      dialect: new PostgresDialect({ pool: getPlatformPool() }),
      type: 'postgres',
      schemaName: PLATFORM_SCHEMA,
    },
    emailAndPassword: { enabled: !isMultiTenant() },
    user: {
      additionalFields: {
        // Sites the account may own; raised per customer, never by the user
        siteLimit: { type: 'number', defaultValue: DEFAULT_SITE_LIMIT, input: false, required: false },
      },
    },
    // Stored in the database so limits hold across app instances
    rateLimit: { enabled: true, storage: 'database' },
    advanced: {
      // tenant_id columns are uuid
      database: { generateId: 'uuid' },
    },
    telemetry: { enabled: false },
    databaseHooks: {
      user: {
        create: {
          // A single-tenant install has one team: only the first account may sign up
          before: async () => {
            if (!isMultiTenant() && await countUsers() > 0) {
              throw new APIError('FORBIDDEN', { message: 'Sign up is closed' });
            }
          },
        },
      },
      session: {
        create: {
          // Start every session in the user's first site
          before: async (session) => ({
            data: { ...session, activeOrganizationId: await firstOrganizationId(session.userId) },
          }),
        },
      },
    },
    plugins: [
      emailOTP({
        sendVerificationOTP: async ({ email, otp }) => sendSignInCode(email, otp),
        otpLength: 6,
        expiresIn: 10 * 60,
        storeOTP: 'hashed',
      }),
      organization({
        roles: { owner: ownerAc, admin: adminAc, designer: memberAc, editor: memberAc },
        creatorRole: 'owner',
        // Accepting requires signing in with the invited email, which proves control of it
        requireEmailVerificationOnInvitation: true,
        sendInvitationEmail: async ({ id, email, organization: site, inviter }) =>
          sendSiteInvitation(email, site.name, inviter.user.name || inviter.user.email, getInvitationUrl(id)),
        // true when the user already owns as many sites as their account allows
        organizationLimit: async (user) =>
          await countOwnedSites(user.id) >= (Number(user.siteLimit) || DEFAULT_SITE_LIMIT),
        organizationHooks: {
          // The slug is the site's subdomain
          beforeCreateOrganization: async ({ organization: created }) => assertValidSlug(created.slug),
          beforeUpdateOrganization: async ({ organization: changes }) => {
            if (changes.slug !== undefined) assertValidSlug(changes.slug);
          },
          afterCreateOrganization: async ({ organization: created }) => {
            const knex = await getKnexClient();
            await provisionTenant(knex, created.id);
            await setNewSiteName(knex, created.id, created.name);
            // Statistics are not worth failing site creation for: page views retry later
            ensureSiteAnalytics(created.id).catch((error) => {
              console.error('[analytics] Could not create the Umami website:', error);
            });
          },
        },
      }),
      // Must be last: applies Set-Cookie from server-side auth calls
      nextCookies(),
    ],
  } satisfies BetterAuthOptions;
}

function createPlatformAuth() {
  return betterAuth(createAuthOptions());
}

export type PlatformAuth = ReturnType<typeof createPlatformAuth>;

const globalForAuth = globalThis as unknown as { __platformAuth?: PlatformAuth };

export function getPlatformAuth(): PlatformAuth {
  globalForAuth.__platformAuth ??= createPlatformAuth();
  return globalForAuth.__platformAuth;
}

/**
 * Create or update the platform schema: Better Auth tables, then domains.
 */
export async function migratePlatform(): Promise<void> {
  const { runMigrations } = await getMigrations(createAuthOptions());
  await runMigrations();
  await getPlatformPool().query(DOMAINS_TABLE_SQL);
  await getPlatformPool().query(MCP_ACCOUNT_TABLES_SQL);
  await getPlatformPool().query(SITE_ANALYTICS_TABLE_SQL);
}
