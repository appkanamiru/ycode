/**
 * Multi-Tenancy Schema
 *
 * Turns the single-tenant Ycode schema into a shared-schema multi-tenant one,
 * enabled with YCODE_MULTI_TENANT=true (requires YCODE_DB_DRIVER=postgres).
 *
 * `applyTenancy()` runs after every migration batch. It is idempotent and
 * works off the catalog, so tables and indexes added by future upstream
 * migrations are picked up without changes here:
 * - every table in the current schema (except migration bookkeeping) gets a NOT NULL
 *   `tenant_id`, defaulting to the `app.tenant_id` setting
 * - rows without a tenant are assigned to the template tenant
 * - unique indexes are re-created with `tenant_id` as the leading column, so
 *   uniqueness (slugs, keys, ...) holds per tenant instead of globally;
 *   primary keys stay and get a tenant-scoped twin for upsert conflict targets
 */

import { createHash } from 'crypto';
import type { Knex } from 'knex';

import { TENANT_SETTING } from './pg-client/client';
import { TENANT_COLUMN } from './pg-client/schema-introspector';

/** Owns rows seeded by migrations; a template for provisioning new tenants */
export const TEMPLATE_TENANT_ID = '00000000-0000-0000-0000-000000000000';

/** Tables shared by all tenants */
export const GLOBAL_TABLES = new Set(['migrations', 'migrations_lock']);

const MAX_IDENTIFIER_LENGTH = 63;

export function isMultiTenant(): boolean {
  return process.env.YCODE_MULTI_TENANT === 'true';
}

/**
 * Error message for operations that work on whole tables (truncate, drop,
 * full export) and would affect every tenant, or null when allowed.
 */
export function multiTenantRestriction(operation: string): string | null {
  return isMultiTenant()
    ? `${operation} is not available in multi-tenant mode`
    : null;
}

function identifier(name: string): string {
  if (name.length <= MAX_IDENTIFIER_LENGTH) return name;
  const hash = createHash('md5').update(name).digest('hex').slice(0, 8);
  return `${name.slice(0, MAX_IDENTIFIER_LENGTH - 9)}_${hash}`;
}

/** Catalog SQL is passed through knex.raw, which treats `?` as a placeholder */
function escapePlaceholders(sql: string): string {
  return sql.replace(/\?/g, '\\?');
}

const UNIQUE_INDEXES_SQL = `
  select
    ic.relname::text as index_name,
    i.indisprimary as is_primary,
    con.conname::text as constraint_name,
    exists (
      select 1 from pg_constraint f where f.contype = 'f' and f.conindid = i.indexrelid
    ) as is_referenced,
    pg_get_expr(i.indpred, i.indrelid) as predicate,
    array(
      select pg_get_indexdef(i.indexrelid, k, true)
      from generate_series(1, i.indnkeyatts) k
      order by k
    ) as keys
  from pg_index i
  join pg_class ic on ic.oid = i.indexrelid
  left join pg_constraint con on con.conindid = i.indexrelid and con.contype in ('p', 'u')
  where i.indrelid = to_regclass(?)
    and i.indisunique
    and not exists (
      select 1 from pg_attribute a
      where a.attrelid = i.indrelid and a.attname = ? and a.attnum = any(i.indkey)
    )
  order by ic.relname`;

export interface TenancyResult {
  tables: string[];
  rewrittenIndexes: Array<{ table: string; from: string; to: string }>;
  /** Unique indexes left global because a foreign key depends on them */
  globalIndexes: Array<{ table: string; index: string }>;
}

export async function applyTenancy(
  knex: Knex,
  options: { backfillTenantId?: string } = {},
): Promise<TenancyResult> {
  const backfillTenantId = options.backfillTenantId ?? TEMPLATE_TENANT_ID;
  const result: TenancyResult = { tables: [], rewrittenIndexes: [], globalIndexes: [] };

  await knex.transaction(async (trx) => {
    const { rows } = await trx.raw('select tablename::text as name from pg_tables where schemaname = current_schema() order by tablename');
    const tables = (rows as Array<{ name: string }>).map((row) => row.name).filter((name) => !GLOBAL_TABLES.has(name));

    for (const table of tables) {
      await trx.raw('alter table ?? add column if not exists ?? uuid', [table, TENANT_COLUMN]);
      await trx.raw('update ?? set ?? = ? where ?? is null', [table, TENANT_COLUMN, backfillTenantId, TENANT_COLUMN]);
      await trx.raw(
        `alter table ?? alter column ?? set default nullif(current_setting('${TENANT_SETTING}', true), '')::uuid, alter column ?? set not null`,
        [table, TENANT_COLUMN, TENANT_COLUMN],
      );
      await trx.raw('create index if not exists ?? on ?? (??)', [identifier(`idx_${table}_${TENANT_COLUMN}`), table, TENANT_COLUMN]);

      const { rows: indexes } = await trx.raw(UNIQUE_INDEXES_SQL, [table, TENANT_COLUMN]);
      for (const index of indexes) {
        // Dropping it would break the foreign key (primary keys are never dropped)
        if (index.is_referenced && !index.is_primary) {
          result.globalIndexes.push({ table, index: index.index_name });
          continue;
        }

        const tenantIndex = identifier(`${index.index_name}_tenant`);

        // Primary keys stay, so their twin only needs creating once
        if (index.is_primary) {
          const { rows: [existing] } = await trx.raw('select to_regclass(?) is not null as found', [tenantIndex]);
          if (existing.found) continue;
        }

        const keys = (index.keys as string[]).map(escapePlaceholders).join(', ');
        const where = index.predicate ? ` where ${escapePlaceholders(index.predicate)}` : '';

        // A global original still existing means upstream (re)created it, so rebuild the twin
        await trx.raw('drop index if exists ??', [tenantIndex]);
        await trx.raw(`create unique index ?? on ?? (??, ${keys})${where}`, [tenantIndex, table, TENANT_COLUMN]);

        if (index.constraint_name && !index.is_primary) {
          await trx.raw('alter table ?? drop constraint ??', [table, index.constraint_name]);
        } else if (!index.is_primary) {
          await trx.raw('drop index ??', [index.index_name]);
        }

        result.rewrittenIndexes.push({ table, from: index.index_name, to: tenantIndex });
      }

      result.tables.push(table);
    }
  });

  return result;
}
