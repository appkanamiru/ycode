/* eslint-disable @typescript-eslint/no-require-imports */
/**
 * Run migrations against plain Postgres (YCODE_DB_DRIVER=postgres).
 *
 *   DATABASE_URL=postgres://... npm run migrate:postgres
 *   DATABASE_URL=postgres://... YCODE_MULTI_TENANT=true npm run migrate:postgres
 *
 * Same steps as the in-app migration runner: Supabase compatibility stubs,
 * pending migrations, (multi-tenant) tenant scoping of the schema, then the
 * platform schema (accounts, organizations, domains).
 *
 * Some migrations import modules guarded by `server-only`, so it is
 * neutralized for this standalone CLI.
 */
import Module from 'module';
import path from 'path';

const origLoad = (Module as any)._load;
(Module as any)._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'server-only') return {};
  return origLoad.call(this, request, parent, isMain);
};

const knex = require('knex');
const { TENANT_SETTING } = require('@/lib/database/pg-client/client');
const { ensurePostgresCompat } = require('@/lib/database/postgres-compat');
const { applyTenancy, isMultiTenant, TEMPLATE_TENANT_ID } = require('@/lib/database/tenancy');
const { migratePlatform } = require('@/lib/platform/auth');
const { getPlatformPool } = require('@/lib/platform/db');

async function main() {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is required');
  }

  const multiTenant = isMultiTenant();
  const db = knex({
    client: 'pg',
    connection: process.env.DATABASE_URL,
    pool: {
      min: 0,
      max: 1,
      // Rows seeded by migrations belong to the template tenant
      afterCreate: (connection: any, done: (error: Error | null, connection: any) => void) => {
        if (!multiTenant) return done(null, connection);
        connection.query(`set ${TENANT_SETTING} = '${TEMPLATE_TENANT_ID}'`, (error: Error | null) => done(error, connection));
      },
    },
    migrations: {
      directory: path.join(process.cwd(), 'database/migrations'),
      tableName: 'migrations',
      loadExtensions: ['.ts'],
    },
  });

  try {
    const compat = await ensurePostgresCompat(db);
    console.log('Postgres compatibility:', compat);

    const [batch, executed] = await db.migrate.latest();
    console.log(executed.length ? `Batch ${batch}: ${executed.length} migrations` : 'Already up to date');

    if (multiTenant) {
      const tenancy = await applyTenancy(db);
      console.log(`Tenancy: ${tenancy.tables.length} tables, ${tenancy.rewrittenIndexes.length} unique indexes scoped`);
      for (const index of tenancy.globalIndexes) {
        console.warn(`  kept global (referenced by a foreign key): ${index.table}.${index.index}`);
      }
    }

    await migratePlatform();
    console.log('Platform schema: up to date');
  } finally {
    await db.destroy();
    await getPlatformPool().end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
