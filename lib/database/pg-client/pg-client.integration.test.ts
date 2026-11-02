/**
 * Integration tests against a real Postgres database.
 *
 * Skipped unless PG_CLIENT_TEST_DATABASE_URL is set. The tests DROP and
 * recreate the `pages` and `page_layers` tables — point it at a throwaway
 * database, e.g.:
 *
 *   docker run -d -p 55432:5432 -e POSTGRES_PASSWORD=postgres postgres:16-alpine
 *   PG_CLIENT_TEST_DATABASE_URL=postgres://postgres:postgres@localhost:55432/postgres npm test
 */

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import knex, { type Knex } from 'knex';

import { createPgClient, type PgClient } from './client';

const DATABASE_URL = process.env.PG_CLIENT_TEST_DATABASE_URL;
const TENANT_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const TENANT_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const PAGE_ID = '00000000-0000-0000-0000-000000000001';

let db: Knex;
let client: PgClient;

before(async () => {
  if (!DATABASE_URL) return;

  db = knex({ client: 'pg', connection: DATABASE_URL, pool: { min: 0, max: 2 } });
  client = createPgClient({ knex: db });

  // Mirrors the real migrations, plus the tenant_id column and the
  // tenant-scoped unique index a multi-tenant migration would add.
  await db.raw(`
    drop table if exists page_layers;
    drop table if exists pages;
    create table pages (
      id uuid default gen_random_uuid(),
      tenant_id uuid,
      name varchar(255) not null,
      slug varchar(255) not null,
      "order" integer default 0,
      settings jsonb default '{}',
      is_published boolean not null default false,
      content_hash varchar(64),
      created_at timestamptz default now(),
      deleted_at timestamptz,
      primary key (id, is_published)
    );
    create unique index pages_tenant_key on pages (tenant_id, id, is_published);
    create table page_layers (
      id uuid default gen_random_uuid(),
      tenant_id uuid,
      page_id uuid not null,
      layers jsonb not null default '[]',
      is_published boolean not null default false,
      content_hash varchar(64),
      deleted_at timestamptz,
      primary key (id, is_published),
      foreign key (page_id, is_published) references pages (id, is_published) on delete cascade
    );
    create or replace function current_tenant() returns text
      language sql stable as $$ select current_setting('app.tenant_id', true) $$;
  `);
});

after(async () => {
  await db?.destroy();
});

test('tenants only see their own rows', { skip: !DATABASE_URL }, async () => {
  const a = client.withTenant(TENANT_A);
  const b = client.withTenant(TENANT_B);

  const inserted = await a.from('pages').insert({ id: PAGE_ID, name: 'Home', slug: '', settings: { seo: { title: 'A' } } }).select().single();
  assert.equal(inserted.error, null);
  assert.equal(inserted.data.tenant_id, TENANT_A);
  assert.deepEqual(inserted.data.settings, { seo: { title: 'A' } });

  const seenByB = await b.from('pages').select('*').eq('id', PAGE_ID);
  assert.deepEqual(seenByB.data, []);

  const updatedByB = await b.from('pages').update({ name: 'Hacked' }).eq('id', PAGE_ID).select();
  assert.deepEqual(updatedByB.data, []);

  const deletedByB = await b.from('pages').delete().eq('id', PAGE_ID).select();
  assert.deepEqual(deletedByB.data, []);

  const { data } = await a.from('pages').select('name').eq('id', PAGE_ID).single();
  assert.deepEqual(data, { name: 'Home' });
});

test('upsert cannot overwrite another tenant\'s row', { skip: !DATABASE_URL }, async () => {
  const b = client.withTenant(TENANT_B);
  const { error } = await b.from('pages').upsert({ id: PAGE_ID, is_published: false, name: 'Hijack', slug: 'x' }, { onConflict: 'id,is_published' });
  assert.equal(error?.code, '23505');

  const { data } = await client.withTenant(TENANT_A).from('pages').select('name').eq('id', PAGE_ID).single();
  assert.deepEqual(data, { name: 'Home' });
});

test('upsert updates the tenant\'s own row', { skip: !DATABASE_URL }, async () => {
  const a = client.withTenant(TENANT_A);
  const { error } = await a.from('pages').upsert({ id: PAGE_ID, is_published: false, name: 'Home v2', slug: '' }, { onConflict: 'id,is_published' });
  assert.equal(error, null);

  const { data } = await a.from('pages').select('name').eq('id', PAGE_ID).single();
  assert.deepEqual(data, { name: 'Home v2' });
});

test('inner embeds, JSON arrays and timestamps match PostgREST output', { skip: !DATABASE_URL }, async () => {
  const a = client.withTenant(TENANT_A);
  const layers = [{ id: 'body', name: 'body', children: [] }];

  await a.from('pages').insert({ id: '00000000-0000-0000-0000-000000000002', name: 'No layers', slug: 'empty' });
  const insertedLayers = await a.from('page_layers').insert({ page_id: PAGE_ID, layers, content_hash: 'h1' }).select('layers');
  assert.deepEqual(insertedLayers.data, [{ layers }]);

  const { data, error } = await a
    .from('pages')
    .select('id, created_at, page_layers!inner(content_hash)')
    .eq('is_published', false)
    .eq('page_layers.is_published', false)
    .is('page_layers.deleted_at', null);

  assert.equal(error, null);
  assert.equal(data.length, 1, 'pages without layers are filtered out by !inner');
  assert.equal(data[0].id, PAGE_ID);
  assert.deepEqual(data[0].page_layers, [{ content_hash: 'h1' }]);
  assert.match(data[0].created_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?[+-]\d{2}:\d{2}$/);
});

test('count, single and or-filters', { skip: !DATABASE_URL }, async () => {
  const a = client.withTenant(TENANT_A);

  const counted = await a.from('pages').select('*', { count: 'exact', head: true }).is('deleted_at', null);
  assert.equal(counted.count, 2);

  const missing = await a.from('pages').select('*').eq('slug', 'nope').single();
  assert.equal(missing.error?.code, 'PGRST116');

  const filtered = await a.from('pages').select('slug').or('slug.eq.empty,and(name.like.*v2,order.gte.0)').order('slug');
  assert.deepEqual(filtered.data, [{ slug: '' }, { slug: 'empty' }]);
});

test('rpc runs with the tenant setting', { skip: !DATABASE_URL }, async () => {
  const { data, error } = await client.withTenant(TENANT_A).rpc('current_tenant');
  assert.equal(error, null);
  assert.equal(data, TENANT_A);
});
