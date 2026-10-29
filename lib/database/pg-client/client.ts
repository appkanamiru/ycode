/**
 * Postgres Client
 *
 * Drop-in replacement for the subset of SupabaseClient used by repositories
 * (`from()` and `rpc()`), running directly on Postgres through knex's pool.
 *
 * Storage, auth and realtime are intentionally not provided — they get their
 * own replacements (filesystem storage, app auth) in later steps.
 */

import type { Knex } from 'knex';

import { PgClientError, toPostgrestError } from './errors';
import { PgQueryBuilder, type PostgrestResponse, type QueryExecutor, type QueryResult } from './query-builder';
import { createSchemaIntrospector, type SchemaIntrospector } from './schema-introspector';

/** Postgres setting that RPC functions (and RLS policies) can read the tenant from */
export const TENANT_SETTING = 'app.tenant_id';

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
const VOID_TYPE_OID = 2278;

const TYPE_OIDS = {
  int8: 20,
  date: 1082,
  timestamp: 1114,
  timestamptz: 1184,
  numeric: 1700,
};

/** `2024-01-01 10:00:00.123456+00` -> `2024-01-01T10:00:00.123456+00:00`, as PostgREST returns it */
export function toPostgrestTimestamp(value: string): string {
  const iso = value.replace(' ', 'T');
  return /[+-]\d{2}$/.test(iso) ? `${iso}:00` : iso;
}

/**
 * Type parsers matching PostgREST's JSON output: timestamps stay ISO strings
 * (no Date objects, no lost microseconds) and int8/numeric become numbers.
 */
function createTypeParsers(knex: Knex) {
  const pgTypes = (knex.client as any).driver.types;

  return {
    getTypeParser(oid: number, format?: string) {
      switch (oid) {
        case TYPE_OIDS.timestamptz:
        case TYPE_OIDS.timestamp:
          return toPostgrestTimestamp;
        case TYPE_OIDS.date:
          return (value: string) => value;
        case TYPE_OIDS.int8:
        case TYPE_OIDS.numeric:
          return Number;
        default:
          return pgTypes.getTypeParser(oid, format);
      }
    },
  };
}

/**
 * Run statements on a pooled connection. When a tenant id is passed, the
 * statement runs in a transaction with `app.tenant_id` set for its duration.
 */
export function createKnexExecutor(knex: Knex): QueryExecutor {
  const types = createTypeParsers(knex);

  return async (sql, bindings, options) => {
    const connection = await knex.client.acquireConnection();
    const query = (text: string, values: readonly unknown[]): Promise<QueryResult> =>
      connection.query({ text, values, types });

    try {
      if (!options?.tenantId) {
        return await query(sql, bindings);
      }

      await connection.query('begin');
      try {
        await query('select set_config($1, $2, true)', [TENANT_SETTING, options.tenantId]);
        const result = await query(sql, bindings);
        await connection.query('commit');
        return result;
      } catch (error) {
        await connection.query('rollback');
        throw error;
      }
    } finally {
      await knex.client.releaseConnection(connection);
    }
  };
}

export interface PgClientOptions {
  knex: Knex;
  execute?: QueryExecutor;
  schema?: SchemaIntrospector;
  resolveTenantId?: () => Promise<string | null> | string | null;
  /** Refuse queries on tenant-scoped tables (and RPCs) without a tenant */
  requireTenant?: boolean;
}

export interface PgClient {
  from<T = any>(table: string): PgQueryBuilder<T>;
  rpc<T = any>(fn: string, args?: Record<string, unknown>): Promise<PostgrestResponse<T>>;
  /** A client bound to a fixed tenant (null = unscoped) */
  withTenant(tenantId: string | null): PgClient;
  readonly storage: never;
  readonly auth: never;
}

export function createPgClient(options: PgClientOptions): PgClient {
  const { knex } = options;
  const execute = options.execute ?? createKnexExecutor(knex);
  const schema = options.schema ?? createSchemaIntrospector(
    async (sql, bindings) => (await execute(sql, bindings)).rows,
  );
  const resolveTenantId = async () => (await options.resolveTenantId?.()) ?? null;
  const requireTenant = options.requireTenant ?? false;
  const context = { knex, execute, schema, resolveTenantId, requireTenant };

  return {
    from(table) {
      return new PgQueryBuilder(context, table);
    },

    async rpc(fn, args = {}) {
      try {
        const names = Object.keys(args).filter((name) => args[name] !== undefined);
        const invalid = [fn, ...names].find((name) => !IDENTIFIER.test(name));
        if (invalid) {
          throw new PgClientError('PGRST100', `Invalid function or argument name "${invalid}"`);
        }

        const tenantId = await resolveTenantId();
        if (requireTenant && !tenantId) {
          throw new PgClientError('TENANT_REQUIRED', `No tenant resolved for rpc "${fn}"`);
        }

        // Named notation, like PostgREST: fn("p_limit" => $1, ...)
        const { sql, bindings } = knex
          .raw(`select * from ??(${names.map((name) => `"${name}" => ?`).join(', ')})`, [fn, ...names.map((name) => args[name])] as Knex.RawBinding[])
          .toSQL()
          .toNative();
        const result = await execute(sql, bindings, { tenantId });

        const field = result.fields?.length === 1 ? result.fields[0] : null;
        let data: unknown = result.rows;
        if (field?.dataTypeID === VOID_TYPE_OID) {
          data = null;
        } else if (field?.name === fn && result.rows.length === 1) {
          data = result.rows[0][fn];
        }

        return { data: data as any, error: null, count: null, status: 200, statusText: 'OK' };
      } catch (error) {
        return { data: null, error: toPostgrestError(error), count: null, status: 400, statusText: 'Bad Request' };
      }
    },

    withTenant(tenantId) {
      return createPgClient({ knex, execute, schema, requireTenant, resolveTenantId: () => tenantId });
    },

    get storage(): never {
      throw new Error('Storage is not available on the Postgres client yet');
    },

    get auth(): never {
      throw new Error('Auth is not available on the Postgres client yet');
    },
  };
}
