/**
 * Supabase Storage
 *
 * File storage still runs on Supabase while the database can run on plain
 * Postgres (see lib/database/pg-client), so storage calls get their client
 * here instead of from the database client.
 *
 * SERVER-ONLY: imports the Supabase server module.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

import { getSupabaseAdmin } from './supabase-server';

export async function getSupabaseStorage(): Promise<SupabaseClient['storage']> {
  const client = await getSupabaseAdmin();

  if (!client) {
    throw new Error('Supabase Storage is not configured');
  }

  return client.storage;
}
