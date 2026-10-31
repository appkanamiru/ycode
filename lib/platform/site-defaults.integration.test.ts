/**
 * Integration tests for the defaults of new sites.
 *
 * Skipped unless PG_CLIENT_TEST_DATABASE_URL is set. Works in its own
 * `site_defaults_test` schema (recreated on every run).
 */

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import knex, { type Knex } from 'knex';

import { TEMPLATE_TENANT_ID } from '@/lib/database/tenancy';
import { applySiteDefaults, setNewSiteName } from './site-defaults';

const DATABASE_URL = process.env.PG_CLIENT_TEST_DATABASE_URL;
const SCHEMA = 'site_defaults_test';
const SITE = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const PAGE = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

let db: Knex;

before(async () => {
  if (!DATABASE_URL) return;

  const admin = knex({ client: 'pg', connection: DATABASE_URL });
  await admin.raw(`drop schema if exists ${SCHEMA} cascade; create schema ${SCHEMA}`);
  await admin.destroy();

  db = knex({ client: 'pg', connection: DATABASE_URL, searchPath: [SCHEMA, 'public'], pool: { min: 0, max: 1 } });
  await db.raw(`
    create table locales (
      id uuid not null default gen_random_uuid(),
      tenant_id uuid not null,
      code varchar(10) not null,
      label varchar(255) not null,
      is_default boolean not null default false,
      is_published boolean not null default false,
      updated_at timestamptz,
      primary key (id, is_published),
      unique (tenant_id, code, is_published)
    );
    create table settings (
      id uuid primary key default gen_random_uuid(),
      tenant_id uuid not null,
      key varchar(255) not null,
      value jsonb not null,
      updated_at timestamptz,
      unique (tenant_id, key)
    );
    create table pages (
      id uuid not null, tenant_id uuid not null, is_published boolean not null default false,
      name text, error_page integer, settings jsonb, primary key (tenant_id, id, is_published)
    );
    create table page_layers (
      id uuid not null, tenant_id uuid not null, page_id uuid not null, is_published boolean not null default false,
      layers jsonb not null, primary key (tenant_id, id, is_published)
    );
    insert into pages (id, tenant_id, is_published, name, error_page, settings) values
      ('${PAGE}', '${TEMPLATE_TENANT_ID}', false, '404 - Page not found', 404, '{"seo":{"title":"Error 404 - Page not found"}}'),
      ('${PAGE}', '${SITE}', false, '404 - Page not found', 404, '{"seo":{"title":"Error 404 - Page not found"}}');
    insert into page_layers (id, tenant_id, page_id, is_published, layers) values
      ('${PAGE}', '${TEMPLATE_TENANT_ID}', '${PAGE}', false, '[{"id":"t","variables":{"text":{"data":{"content":{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"Page not found"}]}]}}}}}]'),
      ('${PAGE}', '${SITE}', '${PAGE}', false, '[{"id":"t","variables":{"text":{"data":{"content":{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"Page not found"}]}]}}}}}]');
    insert into locales (tenant_id, code, label, is_default) values
      ('${TEMPLATE_TENANT_ID}', 'en', 'English', true),
      ('${SITE}', 'en', 'English', true);
    insert into settings (tenant_id, key, value) values
      ('${TEMPLATE_TENANT_ID}', 'timezone', '"UTC"'),
      ('${TEMPLATE_TENANT_ID}', 'ycode_badge', 'true'),
      ('${SITE}', 'timezone', '"UTC"');
  `);
});

after(async () => {
  await db?.destroy();
});

test('the template gets the defaults, existing sites keep theirs', { skip: !DATABASE_URL }, async () => {
  await applySiteDefaults(db);
  // Running again (every migration run) changes nothing
  await applySiteDefaults(db);

  const locales = await db('locales').select('tenant_id', 'code', 'label', 'is_default').orderBy('tenant_id');
  assert.deepEqual(locales, [
    { tenant_id: TEMPLATE_TENANT_ID, code: 'cs', label: 'Czech', is_default: true },
    { tenant_id: SITE, code: 'en', label: 'English', is_default: true },
  ]);

  const settings = await db('settings').select('tenant_id', 'key', 'value').orderBy(['tenant_id', 'key']);
  assert.deepEqual(settings, [
    { tenant_id: TEMPLATE_TENANT_ID, key: 'site_description', value: '' },
    { tenant_id: TEMPLATE_TENANT_ID, key: 'timezone', value: 'Europe/Prague' },
    { tenant_id: TEMPLATE_TENANT_ID, key: 'ycode_badge', value: false },
    { tenant_id: SITE, key: 'timezone', value: 'UTC' },
  ]);

  const pages = await db('pages').select('tenant_id', 'name', 'settings').orderBy('tenant_id');
  assert.deepEqual(pages, [
    { tenant_id: TEMPLATE_TENANT_ID, name: '404 – Stránka nenalezena', settings: { seo: { title: 'Chyba 404 – Stránka nenalezena' } } },
    { tenant_id: SITE, name: '404 - Page not found', settings: { seo: { title: 'Error 404 - Page not found' } } },
  ]);
  const texts = await db('page_layers').select('tenant_id', db.raw(`layers #>> '{0,variables,text,data,content,content,0,content,0,text}' as text`)).orderBy('tenant_id');
  assert.deepEqual(texts.map((row: { text: string }) => row.text), ['Stránka nenalezena', 'Page not found']);
});

test('a new site is named after the name it was created with', { skip: !DATABASE_URL }, async () => {
  const site = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
  await db('settings').insert({ tenant_id: site, key: 'site_name', value: JSON.stringify('Ycode Site') });

  await setNewSiteName(db, site, 'Kavárna "U Lípy"');

  const row = await db('settings').where({ tenant_id: site, key: 'site_name' }).first('value');
  assert.equal(row.value, 'Kavárna "U Lípy"');
  await db('settings').where({ tenant_id: site }).delete();
});
