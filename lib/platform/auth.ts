/**
 * Platform Auth
 *
 * Better Auth on the platform Postgres schema: email + password accounts and
 * organizations, where each organization is a tenant (one website). Members
 * carry the Ycode roles (owner > admin > designer > editor).
 *
 * Env: DATABASE_URL, BETTER_AUTH_SECRET, BETTER_AUTH_URL (the builder origin).
 */

import { betterAuth, type BetterAuthOptions } from 'better-auth';
import { APIError } from 'better-auth/api';
import { getMigrations } from 'better-auth/db/migration';
import { nextCookies } from 'better-auth/next-js';
import { organization } from 'better-auth/plugins/organization';
import { adminAc, memberAc, ownerAc } from 'better-auth/plugins/organization/access';
import { PostgresDialect } from 'kysely';

import { getKnexClient } from '@/lib/knex-client';
import { provisionTenant } from '@/lib/database/tenant-provisioning';
import { isMultiTenant } from '@/lib/database/tenancy';
import { PLATFORM_AUTH_BASE_PATH, PLATFORM_SCHEMA } from './config';
import { getPlatformPool } from './db';

const DOMAINS_TABLE_SQL = `
  create table if not exists ${PLATFORM_SCHEMA}.domains (
    id uuid primary key default gen_random_uuid(),
    tenant_id uuid not null references ${PLATFORM_SCHEMA}.organization (id) on delete cascade,
    hostname text not null unique,
    is_primary boolean not null default false,
    verified_at timestamptz,
    created_at timestamptz not null default now()
  );
  create index if not exists idx_domains_tenant_id on ${PLATFORM_SCHEMA}.domains (tenant_id);`;

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
    emailAndPassword: { enabled: true },
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
      organization({
        roles: { owner: ownerAc, admin: adminAc, designer: memberAc, editor: memberAc },
        creatorRole: 'owner',
        organizationHooks: {
          afterCreateOrganization: async ({ organization: created }) => {
            await provisionTenant(await getKnexClient(), created.id);
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
}
