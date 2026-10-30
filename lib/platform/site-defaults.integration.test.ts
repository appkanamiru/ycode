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
import { applySiteDefaults } from './site-defaults';

const DATABASE_URL = process.env.PG_CLIENT_TEST_DATABASE_URL;
const SCHEMA = 'site_defaults_test';
const SITE = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

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
    { tenant_id: TEMPLATE_TENANT_ID, key: 'timezone', value: 'Europe/Prague' },
    { tenant_id: TEMPLATE_TENANT_ID, key: 'ycode_badge', value: false },
    { tenant_id: SITE, key: 'timezone', value: 'UTC' },
  ]);
});
