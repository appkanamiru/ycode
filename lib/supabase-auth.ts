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
import { getPlatformAuth } from '@/lib/platform/auth';

export interface AuthResult {
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

/**
 * Update the signed-in user's display name and/or avatar, in Supabase Auth
 * or on the platform (plain Postgres). Returns the updated user.
 */
export async function updateUserProfile(
  auth: AuthResult,
  profile: { displayName?: string; avatarUrl?: string },
): Promise<User> {
  if (isPlatformAuth()) {
    const requestHeaders = await headers();
    await getPlatformAuth().api.updateUser({
      headers: requestHeaders,
      body: {
        ...(profile.displayName !== undefined ? { name: profile.displayName } : {}),
        ...(profile.avatarUrl !== undefined ? { image: profile.avatarUrl } : {}),
      },
    });
    const access = await resolveBuilderAccess(requestHeaders);
    if (!access) throw new Error('Not authenticated');
    return toAppUser(access);
  }

  const { data, error } = await auth.client.auth.updateUser({
    data: {
      ...(profile.displayName !== undefined ? { display_name: profile.displayName, full_name: profile.displayName } : {}),
      ...(profile.avatarUrl !== undefined ? { avatar_url: profile.avatarUrl } : {}),
    },
  });
  if (error) throw error;
  return data.user;
}
