/**
 * Schema Introspector
 *
 * Reads table metadata (column types, primary key, tenant column) and foreign
 * key relationships from the Postgres catalog, the same way PostgREST builds
 * its schema cache. Results are cached for the lifetime of the process.
 */

import { PgClientError } from './errors';

export const TENANT_COLUMN = 'tenant_id';

export interface TableMeta {
  name: string;
  /** Column name -> Postgres type name (udt_name, e.g. `jsonb`, `uuid`, `_text`) */
  columns: Map<string, string>;
  primaryKey: string[];
  hasTenantColumn: boolean;
}

export interface Relation {
  /** Column pairs joining the parent to the embedded table */
  on: Array<{ parent: string; child: string }>;
  /** true when the parent has many embedded rows (FK lives on the embedded table) */
  many: boolean;
}

export interface SchemaIntrospector {
  table(name: string): Promise<TableMeta>;
  relation(parent: string, child: string): Promise<Relation>;
}

export type RowQuery = (sql: string, bindings: unknown[]) => Promise<Record<string, any>[]>;

const COLUMNS_SQL = `
  select column_name::text as name, udt_name::text as type
  from information_schema.columns
  where table_schema = $1 and table_name = $2
  order by ordinal_position`;

const PRIMARY_KEY_SQL = `
  select a.attname::text as name
  from pg_index i
  join pg_attribute a on a.attrelid = i.indrelid and a.attnum = any(i.indkey)
  where i.indrelid = to_regclass($1) and i.indisprimary
  order by array_position(i.indkey, a.attnum)`;

const FOREIGN_KEYS_SQL = `
  select
    c.conrelid = to_regclass($1) as from_parent,
    array(
      select a.attname::text
      from unnest(c.conkey) with ordinality k(attnum, ord)
      join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum
      order by k.ord
    ) as source_columns,
    array(
      select a.attname::text
      from unnest(c.confkey) with ordinality k(attnum, ord)
      join pg_attribute a on a.attrelid = c.confrelid and a.attnum = k.attnum
      order by k.ord
    ) as target_columns
  from pg_constraint c
  where c.contype = 'f'
    and (
      (c.conrelid = to_regclass($1) and c.confrelid = to_regclass($2))
      or (c.conrelid = to_regclass($2) and c.confrelid = to_regclass($1))
    )`;

export function createSchemaIntrospector(query: RowQuery, schema = 'public'): SchemaIntrospector {
  const tables = new Map<string, Promise<TableMeta>>();
  const relations = new Map<string, Promise<Relation>>();

  async function loadTable(name: string): Promise<TableMeta> {
    const [columnRows, keyRows] = await Promise.all([
      query(COLUMNS_SQL, [schema, name]),
      query(PRIMARY_KEY_SQL, [`${schema}.${name}`]),
    ]);

    if (columnRows.length === 0) {
      throw new PgClientError('PGRST205', `Could not find the table '${schema}.${name}' in the schema cache`);
    }

    const columns = new Map(columnRows.map((row) => [row.name as string, row.type as string]));
    return {
      name,
      columns,
      primaryKey: keyRows.map((row) => row.name as string),
      hasTenantColumn: columns.has(TENANT_COLUMN),
    };
  }

  async function loadRelation(parent: string, child: string): Promise<Relation> {
    const rows = await query(FOREIGN_KEYS_SQL, [`${schema}.${parent}`, `${schema}.${child}`]);

    if (rows.length === 0) {
      throw new PgClientError('PGRST200', `Could not find a relationship between '${parent}' and '${child}' in the schema cache`);
    }
    if (rows.length > 1) {
      throw new PgClientError('PGRST201', `More than one relationship was found for '${parent}' and '${child}'`);
    }

    const { from_parent: fromParent, source_columns: source, target_columns: target } = rows[0];
    const pairs = (source as string[]).map((column, i) => (
      fromParent
        ? { parent: column, child: (target as string[])[i] }
        : { parent: (target as string[])[i], child: column }
    ));

    return { on: pairs, many: !fromParent };
  }

  return {
    table(name) {
      let cached = tables.get(name);
      if (!cached) {
        cached = loadTable(name);
        cached.catch(() => tables.delete(name));
        tables.set(name, cached);
      }
      return cached;
    },
    relation(parent, child) {
      const key = `${parent}->${child}`;
      let cached = relations.get(key);
      if (!cached) {
        cached = loadRelation(parent, child);
        cached.catch(() => relations.delete(key));
        relations.set(key, cached);
      }
      return cached;
    },
  };
}
