import { getKnexClient, closeKnexClient, testKnexConnection } from '../knex-client';
import { migrations } from '../migrations-loader';
import { TENANT_SETTING } from '../database/pg-client/client';
import { ensurePostgresCompat } from '../database/postgres-compat';
import { applyTenancy, isMultiTenant, TEMPLATE_TENANT_ID } from '../database/tenancy';
import { applySiteDefaults } from '../platform/site-defaults';
import { migratePlatform } from '../platform/auth';

/**
 * Migration Service
 *
 * Runs database migrations programmatically using manually loaded migrations
 * This avoids Next.js webpack bundling issues with dynamic file loading
 */

export interface MigrationResult {
  success: boolean;
  executed: string[];
  failed?: string;
  error?: string;
}

/**
 * Ensure migrations table exists
 */
async function ensureMigrationsTable(knex: any): Promise<void> {
  const hasTable = await knex.schema.hasTable('migrations');

  if (!hasTable) {
    await knex.schema.createTable('migrations', (table: any) => {
      table.uuid('id').defaultTo(knex.raw('gen_random_uuid()')).primary();
      table.string('name').notNullable();
      table.integer('batch').notNullable();
      table.timestamp('migration_time').defaultTo(knex.fn.now());
    });

    // Revoke any public or client-facing access
    await knex.raw('REVOKE ALL ON public.migrations FROM PUBLIC');
    await knex.raw('REVOKE ALL ON public.migrations FROM anon');
    await knex.raw('REVOKE ALL ON public.migrations FROM authenticated');

    // Grant only to the internal DB role(s) that perform migrations
    await knex.raw('GRANT SELECT, INSERT, UPDATE, DELETE ON public.migrations TO postgres');
  }
}

/**
 * Get completed migrations from database
 */
async function getCompletedMigrations(knex: any): Promise<Set<string>> {
  await ensureMigrationsTable(knex);

  const completed = await knex('migrations')
    .select('name')
    .orderBy('migration_time', 'asc');

  return new Set(completed.map((m: any) => m.name));
}

/**
 * Get next batch number
 */
async function getNextBatch(knex: any): Promise<number> {
  const result = await knex('migrations')
    .max('batch as maxBatch')
    .first();

  return (result?.maxBatch || 0) + 1;
}

/**
 * Run pending migrations manually
 */
export async function runMigrations(): Promise<MigrationResult> {
  try {

    // Test connection first
    const canConnect = await testKnexConnection();
    if (!canConnect) {
      return {
        success: false,
        executed: [],
        error: 'Cannot connect to database. Please check your database password is configured correctly.',
      };
    }

    const knex = await getKnexClient();

    // Plain Postgres: stand-ins for the Supabase objects migrations rely on
    if (process.env.YCODE_DB_DRIVER === 'postgres') {
      await ensurePostgresCompat(knex);
    }
    const completed = await getCompletedMigrations(knex);
    const batch = await getNextBatch(knex);
    const executed: string[] = [];

    // Run each pending migration
    for (const migration of migrations) {
      if (!completed.has(migration.name)) {

        try {
          // Run migration in a transaction
          await knex.transaction(async (trx: any) => {
            // Rows seeded by migrations belong to the template tenant
            if (isMultiTenant()) {
              await trx.raw('select set_config(?, ?, true)', [TENANT_SETTING, TEMPLATE_TENANT_ID]);
            }
            await migration.up(trx);

            // Record migration
            await trx('migrations').insert({
              name: migration.name,
              batch,
            });
          });

          executed.push(migration.name);
        } catch (error) {
          console.error(`[runMigrations] ✗ ${migration.name} failed:`, error);
          await closeKnexClient();

          return {
            success: false,
            executed,
            failed: migration.name,
            error: error instanceof Error ? error.message : 'Migration failed',
          };
        }
      }
    }

    // Scope tables and unique indexes added by this batch to tenants
    if (isMultiTenant()) {
      await applyTenancy(knex);
      await applySiteDefaults(knex);
    }

    // Accounts, organizations (tenants) and domains
    if (process.env.YCODE_DB_DRIVER === 'postgres') {
      await migratePlatform();
    }

    // Close connection
    await closeKnexClient();

    return {
      success: true,
      executed,
    };
  } catch (error) {
    console.error('[runMigrations] Migration failed:', error);

    // Make sure to close connection on error
    try {
      await closeKnexClient();
    } catch (closeError) {
      console.error('[runMigrations] Error closing connection:', closeError);
    }

    return {
      success: false,
      executed: [],
      error: error instanceof Error ? error.message : 'Migration failed',
    };
  }
}
