/**
 * Postgres Compatibility Bootstrap
 *
 * Ycode migrations are written for Supabase: RLS policies call `auth.uid()`,
 * a few migrations touch `auth.users` and `storage.buckets/objects`, and the
 * migration runner grants to the `anon`/`authenticated` roles.
 *
 * On plain Postgres this creates inert stand-ins for those objects so the
 * upstream migrations run unmodified. The app connects as the table owner,
 * which bypasses RLS, so the stub policies never filter anything.
 *
 * Idempotent, and a no-op for objects that already exist — on Supabase the
 * real `auth` and `storage` schemas are left untouched.
 */

import type { Knex } from 'knex';

const ROLES = ['anon', 'authenticated', 'service_role', 'postgres'];

const AUTH_STUB = `
  create schema auth;
  create function auth.uid() returns uuid language sql stable as 'select null::uuid';
  create function auth.role() returns text language sql stable as 'select null::text';
  create function auth.jwt() returns jsonb language sql stable as 'select null::jsonb';
  create table auth.users (
    id uuid primary key default gen_random_uuid(),
    email text,
    created_at timestamptz default now(),
    raw_app_meta_data jsonb default '{}'::jsonb,
    raw_user_meta_data jsonb default '{}'::jsonb
  );`;

const STORAGE_STUB = `
  create schema storage;
  create table storage.buckets (
    id text primary key,
    name text not null,
    public boolean default false,
    file_size_limit bigint,
    allowed_mime_types text[]
  );
  create table storage.objects (
    id uuid primary key default gen_random_uuid(),
    bucket_id text references storage.buckets (id),
    name text,
    owner uuid,
    metadata jsonb
  );
  alter table storage.objects enable row level security;`;

export interface PostgresCompatResult {
  createdRoles: string[];
  createdAuthStub: boolean;
  createdStorageStub: boolean;
}

export async function ensurePostgresCompat(knex: Knex): Promise<PostgresCompatResult> {
  return knex.transaction(async (trx) => {
    // gen_random_uuid() is built in since PG13; digest() still needs pgcrypto
    await trx.raw('create extension if not exists pgcrypto');

    const { rows: existingRoles } = await trx.raw('select rolname from pg_roles where rolname = any(?)', [ROLES]);
    const existing = new Set(existingRoles.map((row: { rolname: string }) => row.rolname));
    const createdRoles = ROLES.filter((role) => !existing.has(role));
    for (const role of createdRoles) {
      await trx.raw('create role ?? nologin', [role]);
    }

    const { rows: [schemas] } = await trx.raw(`
      select
        to_regnamespace('auth') is not null as has_auth,
        to_regnamespace('storage') is not null as has_storage
    `);

    if (!schemas.has_auth) await trx.raw(AUTH_STUB);
    if (!schemas.has_storage) await trx.raw(STORAGE_STUB);

    return {
      createdRoles,
      createdAuthStub: !schemas.has_auth,
      createdStorageStub: !schemas.has_storage,
    };
  });
}
