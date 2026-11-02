/**
 * Tenant Provisioning
 *
 * A new tenant starts as a copy of another tenant, by default the template
 * tenant that owns the rows seeded by migrations (homepage, error pages,
 * default locale, settings).
 *
 * Ids are unique across tenants, so every uuid `id` is replaced with a fresh
 * one, consistently in foreign key columns and inside JSON columns (layers
 * reference pages, components and assets by id). Tables are copied parents
 * first, following the foreign keys in the catalog.
 */

import { randomUUID } from 'crypto';
import type { Knex } from 'knex';

import { TENANT_COLUMN } from './pg-client/schema-introspector';
import { TEMPLATE_TENANT_ID } from './tenancy';

const UUID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const JSON_TYPES = new Set(['json', 'jsonb']);
const INSERT_CHUNK_SIZE = 500;

interface ColumnInfo {
  name: string;
  type: string;
  /** Filled in by the database (serial or generated), so never copied */
  generated: boolean;
}

export interface ProvisionResult {
  /** false when the tenant already had content and was left untouched */
  provisioned: boolean;
  rows: Record<string, number>;
}

const COLUMNS_SQL = `
  select
    c.table_name::text as table_name,
    c.column_name::text as column_name,
    c.udt_name::text as type,
    (
      c.is_generated = 'ALWAYS'
      or c.identity_generation = 'ALWAYS'
      or coalesce(c.column_default, '') like 'nextval(%'
    ) as generated
  from information_schema.columns c
  join pg_tables t on t.schemaname = c.table_schema and t.tablename = c.table_name
  where c.table_schema = current_schema()
  order by c.table_name, c.ordinal_position`;

const FOREIGN_KEYS_SQL = `
  select conrelid::regclass::text as child, confrelid::regclass::text as parent
  from pg_constraint
  where contype = 'f' and connamespace = current_schema()::regnamespace`;

/** Order tables so every table comes after the tables it references. */
function sortByDependencies(tables: string[], edges: Array<{ child: string; parent: string }>): string[] {
  const included = new Set(tables);
  const parents = new Map(tables.map((table) => [table, new Set<string>()]));
  for (const { child, parent } of edges) {
    if (child !== parent && included.has(child) && included.has(parent)) {
      parents.get(child)!.add(parent);
    }
  }

  const ordered: string[] = [];
  const remaining = new Set(tables);
  while (remaining.size > 0) {
    const ready = [...remaining].filter((table) => [...parents.get(table)!].every((parent) => !remaining.has(parent)));
    if (ready.length === 0) {
      throw new Error(`Circular foreign keys between: ${[...remaining].join(', ')}`);
    }
    for (const table of ready.sort()) {
      ordered.push(table);
      remaining.delete(table);
    }
  }
  return ordered;
}

export async function provisionTenant(
  knex: Knex,
  tenantId: string,
  options: { fromTenantId?: string } = {},
): Promise<ProvisionResult> {
  const sourceTenantId = options.fromTenantId ?? TEMPLATE_TENANT_ID;

  return knex.transaction(async (trx) => {
    const { rows: columnRows } = await trx.raw(COLUMNS_SQL);
    const columnsByTable = new Map<string, ColumnInfo[]>();
    for (const row of columnRows) {
      const columns = columnsByTable.get(row.table_name) ?? [];
      columns.push({ name: row.column_name, type: row.type, generated: row.generated });
      columnsByTable.set(row.table_name, columns);
    }

    const tenantTables = [...columnsByTable.entries()]
      .filter(([, columns]) => columns.some((column) => column.name === TENANT_COLUMN))
      .map(([table]) => table);

    for (const table of tenantTables) {
      const existing = await trx(table).where(TENANT_COLUMN, tenantId).first(trx.raw('1'));
      if (existing) return { provisioned: false, rows: {} };
    }

    const { rows: edges } = await trx.raw(FOREIGN_KEYS_SQL);
    const ordered = sortByDependencies(tenantTables, edges);

    const sourceRows = new Map<string, Record<string, unknown>[]>();
    const idMap = new Map<string, string>();
    for (const table of ordered) {
      const rows = await trx(table).where(TENANT_COLUMN, sourceTenantId);
      sourceRows.set(table, rows);

      const idColumn = columnsByTable.get(table)!.find((column) => column.name === 'id');
      if (idColumn?.type === 'uuid') {
        // Draft and published rows share an id, so they share the new one too
        for (const row of rows) {
          const id = String(row.id).toLowerCase();
          if (!idMap.has(id)) idMap.set(id, randomUUID());
        }
      }
    }

    const remapText = (text: string) => text.replace(UUID_PATTERN, (match) => idMap.get(match.toLowerCase()) ?? match);
    const remap = (value: unknown, column: ColumnInfo): unknown => {
      if (value === null || value === undefined) return value;
      if (JSON_TYPES.has(column.type)) return remapText(JSON.stringify(value));
      if (Array.isArray(value)) return value.map((item) => (typeof item === 'string' ? remapText(item) : item));
      if (typeof value === 'string') return idMap.get(value.toLowerCase()) ?? value;
      return value;
    };

    const result: ProvisionResult = { provisioned: true, rows: {} };
    for (const table of ordered) {
      const rows = sourceRows.get(table)!;
      if (rows.length === 0) continue;

      const columns = columnsByTable.get(table)!.filter((column) => !column.generated);
      const copies = rows.map((row) => Object.fromEntries(columns.map((column) => [
        column.name,
        column.name === TENANT_COLUMN ? tenantId : remap(row[column.name], column),
      ])));

      for (let i = 0; i < copies.length; i += INSERT_CHUNK_SIZE) {
        await trx(table).insert(copies.slice(i, i + INSERT_CHUNK_SIZE));
      }
      result.rows[table] = copies.length;
    }

    return result;
  });
}
