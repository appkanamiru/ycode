/**
 * Database Client Selection
 *
 * Repositories call `getDbClient()` instead of `getSupabaseAdmin()`.
 * - default: the Supabase client (unchanged behaviour)
 * - YCODE_DB_DRIVER=postgres: the Postgres client on DATABASE_URL, with tenant
 *   scoping resolved from `runWithTenantId()` or the request headers
 * - YCODE_MULTI_TENANT=true (postgres only): queries without a tenant fail
 *
 * SERVER-ONLY: imports the Supabase server module.
 */

import knex from 'knex';
import type { SupabaseClient } from '@supabase/supabase-js';

import { getSupabaseAdmin, getTenantIdFromHeaders } from '../../supabase-server';
import { isMultiTenant } from '../tenancy';
import { createPgClient, type PgClient } from './client';

export { createPgClient } from './client';
export type { PgClient } from './client';

const globalForPgClient = globalThis as unknown as { __pgClient?: PgClient };

export function isPostgresDriver(): boolean {
  return process.env.YCODE_DB_DRIVER === 'postgres';
}

/**
 * Shared Postgres client, stored on globalThis so the pool survives Next.js HMR.
 */
export function getPgClient(): PgClient {
  if (globalForPgClient.__pgClient) {
    return globalForPgClient.__pgClient;
  }

  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is required when YCODE_DB_DRIVER=postgres');
  }

  globalForPgClient.__pgClient = createPgClient({
    knex: knex({
      client: 'pg',
      connection: process.env.DATABASE_URL,
      pool: { min: 0, max: Number(process.env.DATABASE_POOL_MAX) || 10 },
    }),
    resolveTenantId: getTenantIdFromHeaders,
    requireTenant: isMultiTenant(),
  });

  return globalForPgClient.__pgClient;
}

/**
 * Get the database client for repositories.
 *
 * Typed as SupabaseClient so existing query chains compile unchanged; the
 * Postgres client implements the `from()`/`rpc()` subset they use.
 *
 * @param tenantId - Explicit tenant, for code running outside a request
 */
export async function getDbClient(tenantId?: string): Promise<SupabaseClient | null> {
  if (!isPostgresDriver()) {
    if (isMultiTenant()) {
      throw new Error('YCODE_MULTI_TENANT=true requires YCODE_DB_DRIVER=postgres');
    }
    return getSupabaseAdmin(tenantId);
  }

  const client = getPgClient();
  return (tenantId ? client.withTenant(tenantId) : client) as unknown as SupabaseClient;
}
