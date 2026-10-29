/**
 * Browser side of platform auth (plain Postgres), used by the auth store
 * when Supabase is not configured.
 */

import type { User } from '@supabase/supabase-js';

import type { UserRole } from '@/lib/roles';

const AUTH_BASE = '/ycode/api/platform/auth';

export interface PlatformUserState {
  /** false when the server does not use platform auth */
  available: boolean;
  user: User | null;
  role: UserRole | null;
}

let availability: Promise<boolean> | null = null;

/** Whether the server uses platform auth (plain Postgres); checked once per page */
export function isPlatformAuthAvailable(): Promise<boolean> {
  availability ??= fetch('/ycode/api/platform/me', { cache: 'no-store' })
    .then((response) => response.status !== 404)
    .catch(() => {
      availability = null;
      return false;
    });
  return availability;
}

export async function fetchPlatformUser(): Promise<PlatformUserState> {
  const response = await fetch('/ycode/api/platform/me', { cache: 'no-store' });
  if (response.status === 404) return { available: false, user: null, role: null };
  if (!response.ok) return { available: true, user: null, role: null };

  const { data } = await response.json();
  return { available: true, user: data.user, role: data.role };
}

async function post(path: string, body: Record<string, unknown>): Promise<string | null> {
  const response = await fetch(`${AUTH_BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (response.ok) return null;

  const result = await response.json().catch(() => null);
  return result?.message || `Request failed (${response.status})`;
}

/** Returns an error message, or null on success */
export function platformSignIn(email: string, password: string): Promise<string | null> {
  return post('/sign-in/email', { email, password });
}

export function platformSignUp(email: string, password: string): Promise<string | null> {
  return post('/sign-up/email', { email, password, name: email.split('@')[0] });
}

export function platformSignOut(): Promise<string | null> {
  return post('/sign-out', {});
}
