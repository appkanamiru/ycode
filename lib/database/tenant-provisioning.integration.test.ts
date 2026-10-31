/**
 * Integration tests for tenant provisioning.
 *
 * Skipped unless PG_CLIENT_TEST_DATABASE_URL is set. Works in its own
 * `provisioning_test` schema (recreated on every run).
 */

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import knex, { type Knex } from 'knex';

import { applyTenancy, TEMPLATE_TENANT_ID } from './tenancy';
import { provisionTenant } from './tenant-provisioning';

const DATABASE_URL = process.env.PG_CLIENT_TEST_DATABASE_URL;
const SCHEMA = 'provisioning_test';
const TENANT = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const HOME_ID = '11111111-1111-1111-1111-111111111111';
const LAYERS_ID = '22222222-2222-2222-2222-222222222222';

let db: Knex;

before(async () => {
  if (!DATABASE_URL) return;

  const admin = knex({ client: 'pg', connection: DATABASE_URL });
  await admin.raw(`drop schema if exists ${SCHEMA} cascade; create schema ${SCHEMA}`);
  await admin.destroy();

  db = knex({ client: 'pg', connection: DATABASE_URL, searchPath: [SCHEMA, 'public'], pool: { min: 0, max: 1 } });
  // Children are created first on purpose: copy order must follow foreign keys, not names
  await db.raw(`
    create table pages (
      id uuid not null default gen_random_uuid(),
      is_published boolean not null default false,
      slug text not null,
      settings jsonb default '{}',
      primary key (id, is_published)
    );
    create table page_layers (
      id uuid not null default gen_random_uuid(),
      is_published boolean not null default false,
      page_id uuid not null,
      layers jsonb not null default '[]',
      primary key (id, is_published),
      foreign key (page_id, is_published) references pages (id, is_published)
    );
    create table counters (id serial primary key, name text);
    create table settings (id uuid primary key default gen_random_uuid(), key text not null unique, value jsonb);

    insert into pages (id, is_published, slug) values ('${HOME_ID}', false, ''), ('${HOME_ID}', true, '');
    insert into page_layers (id, is_published, page_id, layers) values
      ('${LAYERS_ID}', false, '${HOME_ID}', '[{"id":"body","link":{"page_id":"${HOME_ID}"}}]'),
      ('${LAYERS_ID}', true, '${HOME_ID}', '[{"id":"body"}]');
    insert into counters (name) values ('visits');
    insert into settings (key, value) values ('homepage', '"${HOME_ID}"');
  `);
  await applyTenancy(db);
});

after(async () => {
  await db?.destroy();
});

test('copies the template tenant with fresh, consistent ids', { skip: !DATABASE_URL }, async () => {
  const result = await provisionTenant(db, TENANT);
  assert.deepEqual(result, { provisioned: true, rows: { counters: 1, page_layers: 2, pages: 2, settings: 1 } });

  const pages = await db('pages').where('tenant_id', TENANT);
  assert.equal(pages.length, 2);
  const newHomeId = pages[0].id;
  assert.notEqual(newHomeId, HOME_ID);
  assert.ok(pages.every((page) => page.id === newHomeId), 'draft and published rows keep sharing an id');

  const layers = await db('page_layers').where('tenant_id', TENANT).orderBy('is_published');
  assert.ok(layers.every((row) => row.page_id === newHomeId), 'foreign keys follow the new ids');
  assert.notEqual(layers[0].id, LAYERS_ID);
  assert.deepEqual(layers[0].layers, [{ id: 'body', link: { page_id: newHomeId } }], 'ids inside JSON are remapped');

  const [setting] = await db('settings').where('tenant_id', TENANT);
  assert.equal(setting.value, newHomeId);

  const [counter] = await db('counters').where('tenant_id', TENANT);
  assert.equal(counter.name, 'visits');
  assert.notEqual(counter.id, 1, 'serial ids come from the sequence');
});

test('leaves the template untouched', { skip: !DATABASE_URL }, async () => {
  const pages = await db('pages').where('tenant_id', TEMPLATE_TENANT_ID);
  assert.ok(pages.length === 2 && pages.every((page) => page.id === HOME_ID));
});

test('is a no-op for a tenant that already has content', { skip: !DATABASE_URL }, async () => {
  assert.deepEqual(await provisionTenant(db, TENANT), { provisioned: false, rows: {} });
  assert.equal((await db('pages').where('tenant_id', TENANT)).length, 2);
});
