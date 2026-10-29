import assert from 'node:assert/strict';
import { test } from 'node:test';

import knex from 'knex';

import { createPgClient } from './client';
import type { QueryExecutor } from './query-builder';
import type { SchemaIntrospector, TableMeta } from './schema-introspector';

const TENANT = '11111111-1111-1111-1111-111111111111';

function table(name: string, columns: Record<string, string>, primaryKey: string[]): TableMeta {
  const map = new Map(Object.entries(columns));
  return { name, columns: map, primaryKey, hasTenantColumn: map.has('tenant_id') };
}

const TABLES: Record<string, TableMeta> = {
  pages: table('pages', {
    id: 'uuid', is_published: 'bool', name: 'text', settings: 'jsonb', order: 'int4', deleted_at: 'timestamptz', tenant_id: 'uuid',
  }, ['id', 'is_published']),
  page_layers: table('page_layers', {
    id: 'uuid', page_id: 'uuid', is_published: 'bool', layers: 'jsonb', content_hash: 'text', deleted_at: 'timestamptz', tenant_id: 'uuid',
  }, ['id', 'is_published']),
  app_settings: table('app_settings', { key: 'text', value: 'jsonb' }, ['key']),
};

const schema: SchemaIntrospector = {
  async table(name) {
    if (!TABLES[name]) throw new Error(`unknown table ${name}`);
    return TABLES[name];
  },
  async relation(parent, child) {
    assert.equal(`${parent}->${child}`, 'pages->page_layers');
    return { on: [{ parent: 'id', child: 'page_id' }, { parent: 'is_published', child: 'is_published' }], many: true };
  },
};

function setup(tenantId: string | null, results: Record<string, any>[][] = []) {
  const statements: Array<{ sql: string; bindings: readonly unknown[] }> = [];
  const execute: QueryExecutor = async (sql, bindings) => {
    statements.push({ sql, bindings });
    return { rows: results.shift() ?? [] };
  };
  const client = createPgClient({ knex: knex({ client: 'pg' }), execute, schema, resolveTenantId: () => tenantId });
  return { client, statements };
}

test('select is scoped to the tenant', async () => {
  const { client, statements } = setup(TENANT, [[{ id: 'p1' }]]);
  const { data, error } = await client.from('pages').select('*').eq('is_published', false).is('deleted_at', null).order('order', { ascending: true });

  assert.equal(error, null);
  assert.deepEqual(data, [{ id: 'p1' }]);
  assert.equal(
    statements[0].sql,
    'select "pages".* from "pages" where "pages"."tenant_id" = $1 and "pages"."is_published" = $2 and "pages"."deleted_at" is null order by "pages"."order" asc',
  );
  assert.deepEqual(statements[0].bindings, [TENANT, false]);
});

test('without a tenant, queries are unscoped', async () => {
  const { client, statements } = setup(null);
  await client.from('pages').select('id').eq('id', 'p1');
  assert.equal(statements[0].sql, 'select "pages"."id" from "pages" where "pages"."id" = $1');
});

test('tables without tenant_id are never scoped', async () => {
  const { client, statements } = setup(TENANT);
  await client.from('app_settings').select('*');
  assert.equal(statements[0].sql, 'select "app_settings".* from "app_settings"');
});

test('insert sets tenant_id and serializes JSON columns', async () => {
  const { client, statements } = setup(TENANT, [[{ id: 'p1' }]]);
  const { data } = await client
    .from('pages')
    .insert({ id: 'p1', name: 'Home', settings: { seo: [1, 2] }, tenant_id: 'other-tenant' })
    .select()
    .single();

  assert.deepEqual(data, { id: 'p1' });
  assert.equal(statements[0].sql, 'insert into "pages" ("id", "name", "settings", "tenant_id") values ($1, $2, $3, $4) returning *');
  assert.deepEqual(statements[0].bindings, ['p1', 'Home', '{"seo":[1,2]}', TENANT]);
});

test('bulk insert fills missing keys with null', async () => {
  const { client, statements } = setup(null);
  await client.from('pages').insert([{ id: 'a', name: 'A' }, { id: 'b', order: 2 }]);
  assert.deepEqual(statements[0].bindings, ['a', 'A', null, 'b', null, 2]);
});

test('upsert conflicts on tenant_id so other tenants rows cannot be overwritten', async () => {
  const { client, statements } = setup(TENANT);
  await client.from('pages').upsert([{ id: 'p1', is_published: false, name: 'Home' }], { onConflict: 'id,is_published' });
  assert.equal(
    statements[0].sql,
    'insert into "pages" ("id", "is_published", "name", "tenant_id") values ($1, $2, $3, $4) on conflict ("tenant_id", "id", "is_published") do update set "name" = excluded."name"',
  );
});

test('upsert defaults the conflict target to the primary key', async () => {
  const { client, statements } = setup(null);
  await client.from('app_settings').upsert({ key: 'theme', value: 'dark' });
  assert.equal(
    statements[0].sql,
    'insert into "app_settings" ("key", "value") values ($1, $2) on conflict ("key") do update set "value" = excluded."value"',
  );
  assert.deepEqual(statements[0].bindings, ['theme', '"dark"']);
});

test('update is scoped and cannot move rows to another tenant', async () => {
  const { client, statements } = setup(TENANT);
  const { status } = await client.from('pages').update({ name: 'New', tenant_id: 'other' }).eq('id', 'p1');
  assert.equal(status, 204);
  assert.equal(statements[0].sql, 'update "pages" set "name" = $1 where "pages"."tenant_id" = $2 and "pages"."id" = $3');
});

test('delete is scoped', async () => {
  const { client, statements } = setup(TENANT);
  await client.from('pages').delete().in('id', ['a', 'b']);
  assert.equal(statements[0].sql, 'delete from "pages" where "pages"."tenant_id" = $1 and "pages"."id" in ($2, $3)');
});

test('inner embeds filter parents and project JSON arrays', async () => {
  const { client, statements } = setup(TENANT);
  await client
    .from('pages')
    .select('id, page_layers!inner(content_hash)')
    .eq('is_published', false)
    .eq('page_layers.is_published', false)
    .is('page_layers.deleted_at', null);

  const embed = 'from "page_layers" as "__embed_page_layers" where "__embed_page_layers"."page_id" = "pages"."id"'
    + ' and "__embed_page_layers"."is_published" = "pages"."is_published"'
    + ' and "__embed_page_layers"."tenant_id" = $%TENANT%'
    + ' and "__embed_page_layers"."is_published" = $%PUB%'
    + ' and "__embed_page_layers"."deleted_at" is null';

  assert.equal(
    statements[0].sql,
    'select "pages"."id", (select coalesce(json_agg(json_build_object(\'content_hash\', "__embed_page_layers"."content_hash")), \'[]\'::json) '
      + embed.replace('%TENANT%', '1').replace('%PUB%', '2')
      + ') as "page_layers" from "pages" where "pages"."tenant_id" = $3 and "pages"."is_published" = $4 and exists (select 1 '
      + embed.replace('%TENANT%', '5').replace('%PUB%', '6')
      + ')',
  );
  assert.deepEqual(statements[0].bindings, [TENANT, false, TENANT, false, TENANT, false]);
});

test('or filters and JSON paths compile to SQL', async () => {
  const { client, statements } = setup(null);
  await client
    .from('pages')
    .select('id')
    .or('name.is.null,and(order.gt.1,name.not.like.*draft*)')
    .eq('settings->>slug', 'home');

  assert.equal(
    statements[0].sql,
    'select "pages"."id" from "pages" where ("pages"."name" is null or ("pages"."order" > $1 and not ("pages"."name" like $2))) and "pages"."settings"->>\'slug\' = $3',
  );
  assert.deepEqual(statements[0].bindings, ['1', '%draft%', 'home']);
});

test('count with head runs only a count query', async () => {
  const { client, statements } = setup(TENANT, [[{ count: 3 }]]);
  const { data, count } = await client.from('pages').select('*', { count: 'exact', head: true }).eq('is_published', true);

  assert.equal(data, null);
  assert.equal(count, 3);
  assert.equal(statements.length, 1);
  assert.equal(statements[0].sql, 'select count(*) as "count" from "pages" where "pages"."tenant_id" = $1 and "pages"."is_published" = $2');
});

test('range translates to limit/offset', async () => {
  const { client, statements } = setup(null);
  await client.from('pages').select('id').range(20, 29);
  assert.equal(statements[0].sql, 'select "pages"."id" from "pages" limit $1 offset $2');
  assert.deepEqual(statements[0].bindings, [10, 20]);
});

test('single() returns PGRST116 when no row matches, maybeSingle() returns null', async () => {
  const { client } = setup(null, [[], []]);

  const single = await client.from('pages').select('*').eq('id', 'missing').single();
  assert.equal(single.data, null);
  assert.equal(single.error?.code, 'PGRST116');
  assert.equal(single.status, 406);

  const maybe = await client.from('pages').select('*').eq('id', 'missing').maybeSingle();
  assert.equal(maybe.data, null);
  assert.equal(maybe.error, null);
});

test('unsupported syntax is reported as an error, not thrown', async () => {
  const { client, statements } = setup(null);
  const { error } = await client.from('pages').select('id').filter('tags', 'cs', '{a}');
  assert.equal(error?.code, 'PGRST100');
  assert.equal(statements.length, 0);
});

test('throwOnError() rejects', async () => {
  const { client } = setup(null, [[]]);
  await assert.rejects(async () => client.from('pages').select('*').single().throwOnError(), { code: 'PGRST116' });
});
