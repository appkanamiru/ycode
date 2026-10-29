/**
 * Platform users in the shape the app expects from Supabase Auth, so the
 * builder UI and role checks read them unchanged.
 */

import type { User } from '@supabase/supabase-js';

import type { BuilderAccess } from './tenants';

export function toAppUser(access: BuilderAccess): User {
  return {
    id: access.user.id,
    email: access.user.email,
    app_metadata: { role: access.role },
    user_metadata: {
      display_name: access.user.name,
      full_name: access.user.name,
      avatar_url: access.user.image ?? null,
    },
    aud: 'authenticated',
    created_at: '',
  };
}
