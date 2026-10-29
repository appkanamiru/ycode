/**
 * Server-side auth utilities for API routes.
 * Creates a Supabase client from cookies and verifies the session.
 */

import { createServerClient } from '@supabase/ssr';
import { cookies, headers } from 'next/headers';
import { credentials } from '@/lib/credentials';
import { parseSupabaseConfig } from '@/lib/supabase-config-parser';
import type { SupabaseClient, User } from '@supabase/supabase-js';
import type { SupabaseConfig } from '@/types';
import { isPlatformAuth } from '@/lib/platform/config';
import { resolveBuilderAccess } from '@/lib/platform/tenants';
import { toAppUser } from '@/lib/platform/user';

interface AuthResult {
  user: User;
  client: SupabaseClient;
}

/**
 * Get the authenticated user and Supabase client from request cookies.
 * Returns null if not authenticated or Supabase is not configured.
 */
export async function getAuthUser(): Promise<AuthResult | null> {
  if (isPlatformAuth()) {
    return getPlatformAuthUser();
  }

  try {
    const config = await credentials.get<SupabaseConfig>('supabase_config');
    if (!config) return null;

    const parsed = parseSupabaseConfig(config);
    const cookieStore = await cookies();

    const client = createServerClient(parsed.projectUrl, parsed.anonKey, {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value, options }) => {
            cookieStore.set({ name, value, ...options });
          });
        },
      },
    });

    const { data: { user }, error } = await client.auth.getUser();
    if (error || !user) return null;

    return { user, client };
  } catch {
    return null;
  }
}

/**
 * Supabase Auth client operations (profile changes) are not available with
 * platform auth; fail clearly instead of with an undefined property.
 */
const platformAuthClient = new Proxy({}, {
  get() {
    throw new Error('This operation is not available with platform auth yet');
  },
}) as SupabaseClient;

/** Platform session (plain Postgres) in the same shape as the Supabase result. */
async function getPlatformAuthUser(): Promise<AuthResult | null> {
  try {
    const access = await resolveBuilderAccess(await headers());
    if (!access) return null;

    return { user: toAppUser(access), client: platformAuthClient };
  } catch {
    return null;
  }
}
