/**
 * Supabase Storage
 *
 * File storage for the app: Supabase Storage, or on plain Postgres
 * (YCODE_DB_DRIVER=postgres) the local filesystem, which implements the same
 * subset of the API. Storage calls get their client here instead of from the
 * database client.
 *
 * SERVER-ONLY: imports the Supabase server module.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

import { isMultiTenant } from './database/tenancy';
import { isPlatformAuth } from './platform/config';
import { createFilesystemStorage } from './storage/filesystem-storage';
import { getSupabaseAdmin, getTenantIdFromHeaders } from './supabase-server';

export async function getSupabaseStorage(): Promise<SupabaseClient['storage']> {
  if (isPlatformAuth()) {
    const tenantId = await getTenantIdFromHeaders();
    // Never fall back to the shared, unprefixed area
    if (isMultiTenant() && !tenantId) {
      throw new Error('No tenant resolved for storage');
    }
    return createFilesystemStorage(tenantId) as unknown as SupabaseClient['storage'];
  }

  const client = await getSupabaseAdmin();

  if (!client) {
    throw new Error('Supabase Storage is not configured');
  }

  return client.storage;
}
