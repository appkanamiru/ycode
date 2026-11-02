/**
 * Integration tests for the Postgres compatibility bootstrap and tenancy.
 *
 * Skipped unless PG_CLIENT_TEST_DATABASE_URL is set. Works in its own
 * `tenancy_test` schema (recreated on every run); the compatibility bootstrap
 * creates the `auth`/`storage` stub schemas in that database.
 */

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import knex, { type Knex } from 'knex';

import { ensurePostgresCompat } from './postgres-compat';
import { applyTenancy, TEMPLATE_TENANT_ID } from './tenancy';

const DATABASE_URL = process.env.PG_CLIENT_TEST_DATABASE_URL;
const SCHEMA = 'tenancy_test';
const TENANT_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const TENANT_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

let db: Knex;

async function indexes(table: string): Promise<string[]> {
  const { rows } = await db.raw('select indexname from pg_indexes where schemaname = ? and tablename = ? order by 1', [SCHEMA, table]);
  return rows.map((row: { indexname: string }) => row.indexname);
}

before(async () => {
  if (!DATABASE_URL) return;

  const admin = knex({ client: 'pg', connection: DATABASE_URL });
  await admin.raw(`drop schema if exists ${SCHEMA} cascade; create schema ${SCHEMA}`);
  await admin.destroy();

  db = knex({ client: 'pg', connection: DATABASE_URL, searchPath: [SCHEMA, 'public'], pool: { min: 0, max: 1 } });
  await db.raw(`
    create table migrations (id serial primary key, name text unique);
    create table settings (id uuid primary key default gen_random_uuid(), key text not null unique, value jsonb);
    create table folders (id uuid not null, is_published boolean not null, code text unique, primary key (id, is_published));
    create table pages (
      id uuid not null default gen_random_uuid(),
      is_published boolean not null default false,
      folder_id uuid,
      folder_code text references folders (code),
      slug text not null,
      deleted_at timestamptz,
      primary key (id, is_published),
      foreign key (folder_id, is_published) references folders (id, is_published)
    );
    create unique index pages_slug_unique on pages (slug, is_published, coalesce(folder_id, '00000000-0000-0000-0000-000000000000'::uuid)) where deleted_at is null;
    insert into settings (key, value) values ('theme', '"dark"');
    insert into pages (slug) values ('');
  `);
});

after(async () => {
  await db?.destroy();
});

test('compatibility bootstrap is idempotent', { skip: !DATABASE_URL }, async () => {
  await ensurePostgresCompat(db);
  const second = await ensurePostgresCompat(db);
  assert.deepEqual(second, { createdRoles: [], createdAuthStub: false, createdStorageStub: false });

  const { rows: [row] } = await db.raw('select auth.uid() as uid, to_regclass(?) is not null as has_objects', ['storage.objects']);
  assert.deepEqual(row, { uid: null, has_objects: true });
});

test('tenancy scopes tables and unique indexes', { skip: !DATABASE_URL }, async () => {
  const result = await applyTenancy(db);

  assert.deepEqual(result.tables, ['folders', 'pages', 'settings']);
  assert.deepEqual(result.globalIndexes, [{ table: 'folders', index: 'folders_code_key' }]);
  assert.deepEqual(await indexes('pages'), ['idx_pages_tenant_id', 'pages_pkey', 'pages_pkey_tenant', 'pages_slug_unique_tenant']);
  assert.deepEqual(await indexes('settings'), ['idx_settings_tenant_id', 'settings_key_key_tenant', 'settings_pkey', 'settings_pkey_tenant']);
  assert.ok((await indexes('migrations')).every((name) => !name.includes('tenant')));

  const { rows } = await db.raw('select tenant_id from pages union all select tenant_id from settings');
  assert.deepEqual(rows.map((row: { tenant_id: string }) => row.tenant_id), [TEMPLATE_TENANT_ID, TEMPLATE_TENANT_ID]);
});

test('tenancy is idempotent', { skip: !DATABASE_URL }, async () => {
  const result = await applyTenancy(db);
  assert.deepEqual(result.rewrittenIndexes, []);
});

test('uniqueness holds per tenant', { skip: !DATABASE_URL }, async () => {
  await db.raw('insert into settings (key, tenant_id) values (?, ?), (?, ?)', ['theme', TENANT_A, 'theme', TENANT_B]);
  await assert.rejects(db.raw('insert into settings (key, tenant_id) values (?, ?)', ['theme', TENANT_A]), { code: '23505' });

  // upsert conflict targets used by the Postgres client
  await db.raw(`insert into settings (key, value, tenant_id) values ('theme', '"light"', ?) on conflict (tenant_id, key) do update set value = excluded.value`, [TENANT_A]);
});

test('inserts without a tenant fail unless app.tenant_id is set', { skip: !DATABASE_URL }, async () => {
  await assert.rejects(db.raw(`insert into pages (slug) values ('about')`), { code: '23502' });

  await db.transaction(async (trx) => {
    await trx.raw(`select set_config('app.tenant_id', ?, true)`, [TENANT_B]);
    const { rows: [row] } = await trx.raw(`insert into pages (slug) values ('about') returning tenant_id`);
    assert.equal(row.tenant_id, TENANT_B);
  });
});

test('indexes re-created by a later migration are scoped again', { skip: !DATABASE_URL }, async () => {
  await db.raw(`create unique index pages_slug_unique on pages (slug, is_published) where deleted_at is null`);
  const result = await applyTenancy(db);

  assert.deepEqual(result.rewrittenIndexes, [{ table: 'pages', from: 'pages_slug_unique', to: 'pages_slug_unique_tenant' }]);
  const { rows: [row] } = await db.raw('select indexdef from pg_indexes where schemaname = ? and indexname = ?', [SCHEMA, 'pages_slug_unique_tenant']);
  assert.match(row.indexdef, /\(tenant_id, slug, is_published\) WHERE \(deleted_at IS NULL\)$/);
});
