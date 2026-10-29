/**
 * Query Builder
 *
 * A supabase-js compatible query builder (`from(table).select().eq()...`) that
 * compiles to SQL with knex and runs directly against Postgres, without
 * PostgREST. Responses keep the supabase-js shape: `{ data, error, count }`.
 *
 * Tenant scoping is applied here, in one place, whenever a tenant id is
 * resolved and the table has a `tenant_id` column:
 * - select/update/delete get `WHERE tenant_id = ?` (embedded tables too)
 * - insert/upsert rows get `tenant_id` set, overriding any value passed in
 * - upsert conflict targets are prefixed with `tenant_id`, so an upsert can
 *   never overwrite a row owned by another tenant
 */

import type { Knex } from 'knex';

import { PgClientError, toPostgrestError, type PostgrestError } from './errors';
import {
  isFilterOperator,
  parseColumnPath,
  parseFilterValue,
  parseOrFilter,
  parseSelect,
  type Condition,
  type FilterOperator,
  type SelectItem,
} from './postgrest-syntax';
import { TENANT_COLUMN, type Relation, type SchemaIntrospector, type TableMeta } from './schema-introspector';

export interface PostgrestResponse<T> {
  data: T | null;
  error: PostgrestError | null;
  count: number | null;
  status: number;
  statusText: string;
}

export interface QueryResult {
  rows: Record<string, any>[];
  fields?: Array<{ name: string; dataTypeID: number }>;
}

export type QueryExecutor = (
  sql: string,
  bindings: readonly unknown[],
  options?: { tenantId?: string | null },
) => Promise<QueryResult>;

export interface QueryContext {
  /** Used only to compile SQL; execution goes through `execute`. */
  knex: Knex;
  execute: QueryExecutor;
  schema: SchemaIntrospector;
  resolveTenantId: () => Promise<string | null>;
}

type Row = Record<string, unknown>;
type Operation = 'select' | 'insert' | 'upsert' | 'update' | 'delete';
type EmbedItem = Extract<SelectItem, { type: 'embed' }>;

interface Order {
  column: string;
  ascending: boolean;
  nullsFirst?: boolean;
}

interface ResolvedEmbed {
  embed: EmbedItem;
  alias: string;
  relation: Relation;
  meta: TableMeta;
  conditions: Condition[];
}

const JSON_TYPES = new Set(['json', 'jsonb']);
const COMPARISON_SQL: Partial<Record<FilterOperator, string>> = {
  neq: '<>',
  gt: '>',
  gte: '>=',
  lt: '<',
  lte: '<=',
  like: 'like',
  ilike: 'ilike',
};

function quoteLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function columnSql(alias: string, reference: string): { sql: string; bindings: unknown[] } {
  const { column, json } = parseColumnPath(reference);
  const path = json.map((segment) => `${segment.arrow}${quoteLiteral(segment.key)}`).join('');
  return { sql: `??${path}`, bindings: [`${alias}.${column}`] };
}

/**
 * Compile a condition tree to a raw SQL fragment with knex placeholders.
 */
export function compileCondition(condition: Condition, alias: string): { sql: string; bindings: unknown[] } {
  let compiled: { sql: string; bindings: unknown[] };

  if (condition.type !== 'filter') {
    const parts = condition.conditions.map((child) => compileCondition(child, alias));
    compiled = parts.length === 0
      ? { sql: 'true', bindings: [] }
      : {
        sql: `(${parts.map((part) => part.sql).join(` ${condition.type} `)})`,
        bindings: parts.flatMap((part) => part.bindings),
      };
  } else {
    const column = columnSql(alias, condition.column);
    const { operator, value } = condition;

    if (operator === 'is' || (operator === 'eq' && value === null)) {
      const keyword = value === null ? 'null' : value === true ? 'true' : value === false ? 'false' : 'unknown';
      compiled = { sql: `${column.sql} is ${keyword}`, bindings: column.bindings };
    } else if (operator === 'in') {
      const values = value as unknown[];
      compiled = values.length === 0
        ? { sql: 'false', bindings: [] }
        : { sql: `${column.sql} in (${values.map(() => '?').join(', ')})`, bindings: [...column.bindings, ...values] };
    } else {
      // PostgREST accepts `*` as a wildcard alias for `%` in like patterns
      const bound = operator === 'like' || operator === 'ilike' ? String(value).replace(/\*/g, '%') : value;
      compiled = {
        sql: `${column.sql} ${COMPARISON_SQL[operator] ?? '='} ?`,
        bindings: [...column.bindings, bound],
      };
    }
  }

  return condition.negate ? { sql: `not (${compiled.sql})`, bindings: compiled.bindings } : compiled;
}

function referencesEmbed(condition: Condition, embeds: Set<string>): boolean {
  if (condition.type !== 'filter') {
    return condition.conditions.some((child) => referencesEmbed(child, embeds));
  }
  return condition.column.includes('.');
}

export class PgQueryBuilder<T = any> implements PromiseLike<PostgrestResponse<T>> {
  private operation: Operation = 'select';
  private selection: SelectItem[] | null = null;
  private countRequested = false;
  private head = false;
  private conditions: Condition[] = [];
  private orders: Order[] = [];
  private limitCount: number | null = null;
  private offsetCount: number | null = null;
  private resultMode: 'many' | 'single' | 'maybeSingle' = 'many';
  private values: Row[] = [];
  private onConflict: string[] | null = null;
  private ignoreDuplicates = false;
  private shouldThrow = false;
  /** Builder errors are reported on execution, like supabase-js does */
  private deferredError: Error | null = null;

  constructor(private readonly ctx: QueryContext, private readonly table: string) {}

  // ---------------------------------------------------------------------------
  // Operations
  // ---------------------------------------------------------------------------

  select(columns = '*', options?: { count?: 'exact' | 'planned' | 'estimated'; head?: boolean }): this {
    this.capture(() => {
      this.selection = parseSelect(columns);
    });
    if (options?.count) this.countRequested = true;
    if (options?.head) this.head = true;
    return this;
  }

  insert(values: Row | Row[], _options?: { count?: string; defaultToNull?: boolean }): this {
    this.operation = 'insert';
    this.values = Array.isArray(values) ? values : [values];
    return this;
  }

  upsert(values: Row | Row[], options?: { onConflict?: string; ignoreDuplicates?: boolean }): this {
    this.operation = 'upsert';
    this.values = Array.isArray(values) ? values : [values];
    this.onConflict = options?.onConflict
      ? options.onConflict.split(',').map((column) => column.trim()).filter(Boolean)
      : null;
    this.ignoreDuplicates = options?.ignoreDuplicates ?? false;
    return this;
  }

  update(values: Row, _options?: { count?: string }): this {
    this.operation = 'update';
    this.values = [values];
    return this;
  }

  delete(_options?: { count?: string }): this {
    this.operation = 'delete';
    return this;
  }

  // ---------------------------------------------------------------------------
  // Filters
  // ---------------------------------------------------------------------------

  eq(column: string, value: unknown): this { return this.addFilter(column, 'eq', value); }
  neq(column: string, value: unknown): this { return this.addFilter(column, 'neq', value); }
  gt(column: string, value: unknown): this { return this.addFilter(column, 'gt', value); }
  gte(column: string, value: unknown): this { return this.addFilter(column, 'gte', value); }
  lt(column: string, value: unknown): this { return this.addFilter(column, 'lt', value); }
  lte(column: string, value: unknown): this { return this.addFilter(column, 'lte', value); }
  like(column: string, pattern: string): this { return this.addFilter(column, 'like', pattern); }
  ilike(column: string, pattern: string): this { return this.addFilter(column, 'ilike', pattern); }
  is(column: string, value: boolean | null): this { return this.addFilter(column, 'is', value); }
  in(column: string, values: readonly unknown[]): this { return this.addFilter(column, 'in', [...values]); }

  not(column: string, operator: string, value: unknown): this {
    return this.filter(column, `not.${operator}`, value);
  }

  filter(column: string, operator: string, value: unknown): this {
    const negate = operator.startsWith('not.');
    const name = negate ? operator.slice(4) : operator;

    this.capture(() => {
      if (!isFilterOperator(name)) {
        throw new PgClientError('PGRST100', `Unsupported filter operator "${operator}"`);
      }
      const parsed = typeof value === 'string' && (name === 'in' || name === 'is')
        ? parseFilterValue(name, value)
        : value;
      this.conditions.push({ type: 'filter', column, operator: name, value: parsed, negate });
    });
    return this;
  }

  match(query: Record<string, unknown>): this {
    Object.entries(query).forEach(([column, value]) => this.eq(column, value));
    return this;
  }

  or(filters: string, options?: { referencedTable?: string; foreignTable?: string }): this {
    this.capture(() => {
      if (options?.referencedTable || options?.foreignTable) {
        throw new PgClientError('PGRST100', '.or() on embedded tables is not supported');
      }
      this.conditions.push(parseOrFilter(filters));
    });
    return this;
  }

  // ---------------------------------------------------------------------------
  // Modifiers
  // ---------------------------------------------------------------------------

  order(column: string, options?: { ascending?: boolean; nullsFirst?: boolean; referencedTable?: string; foreignTable?: string }): this {
    if (options?.referencedTable || options?.foreignTable) {
      this.deferredError ??= new PgClientError('PGRST100', 'Ordering embedded tables is not supported');
    }
    this.orders.push({ column, ascending: options?.ascending ?? true, nullsFirst: options?.nullsFirst });
    return this;
  }

  limit(count: number): this {
    this.limitCount = count;
    return this;
  }

  range(from: number, to: number): this {
    this.offsetCount = from;
    this.limitCount = to - from + 1;
    return this;
  }

  single(): this {
    this.resultMode = 'single';
    return this;
  }

  maybeSingle(): this {
    this.resultMode = 'maybeSingle';
    return this;
  }

  throwOnError(): this {
    this.shouldThrow = true;
    return this;
  }

  returns(): this {
    return this;
  }

  abortSignal(): this {
    return this;
  }

  then<TResult1 = PostgrestResponse<T>, TResult2 = never>(
    onfulfilled?: ((value: PostgrestResponse<T>) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    return this.execute().then(onfulfilled, onrejected);
  }

  // ---------------------------------------------------------------------------
  // Execution
  // ---------------------------------------------------------------------------

  private addFilter(column: string, operator: FilterOperator, value: unknown): this {
    this.conditions.push({ type: 'filter', column, operator, value, negate: false });
    return this;
  }

  private capture(fn: () => void): void {
    try {
      fn();
    } catch (error) {
      this.deferredError ??= error as Error;
    }
  }

  private async execute(): Promise<PostgrestResponse<T>> {
    try {
      if (this.deferredError) throw this.deferredError;

      const tenantId = await this.ctx.resolveTenantId();
      const meta = await this.ctx.schema.table(this.table);

      return this.operation === 'select'
        ? await this.runSelect(meta, tenantId)
        : await this.runMutation(meta, tenantId);
    } catch (error) {
      const postgrestError = toPostgrestError(error);
      if (this.shouldThrow) throw postgrestError;

      const status = postgrestError.code === 'PGRST116' ? 406 : postgrestError.code === '23505' ? 409 : 400;
      return { data: null, error: postgrestError, count: null, status, statusText: status === 406 ? 'Not Acceptable' : 'Bad Request' };
    }
  }

  private async run(builder: Knex.QueryBuilder): Promise<Record<string, any>[]> {
    const { sql, bindings } = builder.toSQL().toNative();
    const result = await this.ctx.execute(sql, bindings);
    return result.rows;
  }

  private applyScope(builder: Knex.QueryBuilder, alias: string, meta: TableMeta, tenantId: string | null): void {
    if (tenantId && meta.hasTenantColumn) {
      builder.where(`${alias}.${TENANT_COLUMN}`, tenantId);
    }
  }

  private applyConditions(builder: Knex.QueryBuilder, conditions: Condition[], alias: string): void {
    for (const condition of conditions) {
      const { sql, bindings } = compileCondition(condition, alias);
      builder.whereRaw(sql, bindings as Knex.RawBinding[]);
    }
  }

  private async runSelect(meta: TableMeta, tenantId: string | null): Promise<PostgrestResponse<T>> {
    const { knex } = this.ctx;
    const items = this.selection ?? [{ type: 'star' }];
    const embedItems = items.filter((item): item is EmbedItem => item.type === 'embed');
    const embedNames = new Set(embedItems.map((item) => item.relation));

    // Split `.eq('page_layers.is_published', false)` style filters off to their embed
    const mainConditions: Condition[] = [];
    const embedConditions = new Map<string, Condition[]>();
    for (const condition of this.conditions) {
      if (condition.type === 'filter' && condition.column.includes('.')) {
        const [relation, column] = condition.column.split('.', 2);
        if (!embedNames.has(relation)) {
          throw new PgClientError('PGRST100', `"${relation}" is not an embedded resource in this request`);
        }
        embedConditions.set(relation, [...(embedConditions.get(relation) ?? []), { ...condition, column }]);
      } else if (referencesEmbed(condition, embedNames)) {
        throw new PgClientError('PGRST100', 'Logic trees referencing embedded resources are not supported');
      } else {
        mainConditions.push(condition);
      }
    }

    const embeds: ResolvedEmbed[] = await Promise.all(embedItems.map(async (embed) => ({
      embed,
      alias: `__embed_${embed.relation}`,
      relation: await this.ctx.schema.relation(this.table, embed.relation),
      meta: await this.ctx.schema.table(embed.relation),
      conditions: embedConditions.get(embed.relation) ?? [],
    })));

    const embedQuery = (resolved: ResolvedEmbed): Knex.QueryBuilder => {
      const builder = knex({ [resolved.alias]: resolved.embed.relation });
      for (const pair of resolved.relation.on) {
        builder.whereRaw('?? = ??', [`${resolved.alias}.${pair.child}`, `${this.table}.${pair.parent}`]);
      }
      this.applyScope(builder, resolved.alias, resolved.meta, tenantId);
      this.applyConditions(builder, resolved.conditions, resolved.alias);
      return builder;
    };

    const baseQuery = (): Knex.QueryBuilder => {
      const builder = knex(this.table);
      this.applyScope(builder, this.table, meta, tenantId);
      this.applyConditions(builder, mainConditions, this.table);
      for (const resolved of embeds) {
        if (resolved.embed.inner) {
          builder.whereExists(embedQuery(resolved).select(knex.raw('1')));
        }
      }
      return builder;
    };

    let count: number | null = null;
    if (this.countRequested) {
      const [row] = await this.run(baseQuery().count({ count: '*' }));
      count = Number(row.count);
    }
    if (this.head) {
      return { data: null, error: null, count, status: 200, statusText: 'OK' };
    }

    const query = baseQuery();
    for (const item of items) {
      if (item.type === 'star') query.select(`${this.table}.*`);
      if (item.type === 'column') query.select(`${this.table}.${item.name}`);
    }
    for (const resolved of embeds) {
      query.select(this.embedProjection(embedQuery(resolved), resolved).as(resolved.embed.relation));
    }
    for (const order of this.orders) {
      const column = columnSql(this.table, order.column);
      const nulls = order.nullsFirst === undefined ? '' : order.nullsFirst ? ' nulls first' : ' nulls last';
      query.orderByRaw(`${column.sql} ${order.ascending ? 'asc' : 'desc'}${nulls}`, column.bindings as Knex.RawBinding[]);
    }
    if (this.limitCount !== null) query.limit(this.limitCount);
    if (this.offsetCount !== null) query.offset(this.offsetCount);

    return this.shapeResult(await this.run(query), count, 200);
  }

  /**
   * Embedded rows are returned as JSON built by Postgres, matching PostgREST:
   * an array for one-to-many, an object (or null) for many-to-one.
   */
  private embedProjection(builder: Knex.QueryBuilder, resolved: ResolvedEmbed): Knex.QueryBuilder {
    const { knex } = this.ctx;
    const columns = resolved.embed.items.filter((item): item is Extract<SelectItem, { type: 'column' }> => item.type === 'column');
    const hasStar = resolved.embed.items.some((item) => item.type === 'star');

    const object = hasStar
      ? knex.raw('to_json(??)', [resolved.alias])
      : knex.raw(
        `json_build_object(${columns.map((column) => `${quoteLiteral(column.name)}, ??`).join(', ')})`,
        columns.map((column) => `${resolved.alias}.${column.name}`),
      );

    if (resolved.relation.many) {
      return builder.select(knex.raw(`coalesce(json_agg(?), '[]'::json)`, [object]));
    }
    return builder.select(object).limit(1);
  }

  private async runMutation(meta: TableMeta, tenantId: string | null): Promise<PostgrestResponse<T>> {
    const { knex } = this.ctx;
    const scopedTenant = tenantId && meta.hasTenantColumn ? tenantId : null;
    const status = this.operation === 'insert' || this.operation === 'upsert' ? 201 : 200;

    if (this.selection?.some((item) => item.type === 'embed')) {
      throw new PgClientError('PGRST100', 'Embedded resources are not supported on mutations');
    }
    if (this.conditions.some((condition) => referencesEmbed(condition, new Set()))) {
      throw new PgClientError('PGRST100', 'Filters on embedded resources are not supported on mutations');
    }

    let query: Knex.QueryBuilder;

    if (this.operation === 'insert' || this.operation === 'upsert') {
      const rows = this.prepareRows(meta, scopedTenant);
      if (rows.length === 0) {
        return this.shapeResult([], null, status);
      }

      const insert = knex(this.table).insert(rows);
      if (this.operation === 'upsert') {
        const target = this.onConflict ?? meta.primaryKey;
        const conflict = scopedTenant ? [TENANT_COLUMN, ...target.filter((column) => column !== TENANT_COLUMN)] : target;
        const merge = Object.keys(rows[0]).filter((column) => !conflict.includes(column) && column !== TENANT_COLUMN);
        const onConflict = insert.onConflict(conflict);
        query = this.ignoreDuplicates || merge.length === 0 ? onConflict.ignore() : onConflict.merge(merge);
      } else {
        query = insert;
      }
    } else {
      query = this.operation === 'update'
        ? knex(this.table).update(this.prepareUpdate(meta))
        : knex(this.table).del();
      this.applyScope(query, this.table, meta, scopedTenant);
      this.applyConditions(query, this.conditions, this.table);
    }

    if (!this.selection) {
      await this.run(query);
      return { data: null, error: null, count: null, status: status === 201 ? 201 : 204, statusText: status === 201 ? 'Created' : 'No Content' };
    }

    const returning = this.selection.some((item) => item.type === 'star')
      ? '*'
      : this.selection.map((item) => (item as Extract<SelectItem, { type: 'column' }>).name);
    return this.shapeResult(await this.run(query.returning(returning)), null, status);
  }

  /** JSON columns are serialized up front; pg would turn JS arrays into Postgres arrays. */
  private serializeRow(row: Row, meta: TableMeta): Row {
    const serialized: Row = {};
    for (const [column, value] of Object.entries(row)) {
      if (value === undefined) continue;
      serialized[column] = value !== null && JSON_TYPES.has(meta.columns.get(column) ?? '')
        ? JSON.stringify(value)
        : value;
    }
    return serialized;
  }

  /**
   * Bulk inserts use the union of all keys and fill gaps with null, like
   * PostgREST does by default (supabase-js `defaultToNull: true`).
   */
  private prepareRows(meta: TableMeta, scopedTenant: string | null): Row[] {
    const rows = this.values.map((row) => this.serializeRow(row, meta));
    const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))];

    return rows.map((row) => {
      const normalized: Row = Object.fromEntries(columns.map((column) => [column, column in row ? row[column] : null]));
      if (scopedTenant) normalized[TENANT_COLUMN] = scopedTenant;
      return normalized;
    });
  }

  private prepareUpdate(meta: TableMeta): Row {
    const row = this.serializeRow(this.values[0] ?? {}, meta);
    // Rows can never be moved between tenants
    delete row[TENANT_COLUMN];
    return row;
  }

  private shapeResult(rows: Record<string, any>[], count: number | null, status: number): PostgrestResponse<T> {
    if (this.resultMode === 'many') {
      return { data: rows as T, error: null, count, status, statusText: 'OK' };
    }
    if (rows.length === 1) {
      return { data: rows[0] as T, error: null, count, status, statusText: 'OK' };
    }
    if (rows.length === 0 && this.resultMode === 'maybeSingle') {
      return { data: null, error: null, count, status, statusText: 'OK' };
    }
    throw new PgClientError(
      'PGRST116',
      'Cannot coerce the result to a single JSON object',
      `The result contains ${rows.length} rows`,
    );
  }
}
