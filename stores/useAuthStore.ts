/**
 * Auth Store
 *
 * Manages authentication state using Supabase Auth
 */

import { create } from 'zustand';
import { createBrowserClient } from '../lib/supabase-browser';
import { extractRoleFromUser } from '@/lib/roles';
import { fetchPlatformUser, platformSignIn, platformSignOut, platformSignUp } from '@/lib/platform/browser-auth';
import type { User, Session } from '@supabase/supabase-js';

interface AuthState {
  user: User | null;
  session: Session | null;
  role: string | null;
  loading: boolean;
  initialized: boolean;
  error: string | null;
}

interface AuthActions {
  initialize: () => Promise<void>;
  signUp: (email: string, password: string) => Promise<{ error: string | null }>;
  signIn: (email: string, password: string) => Promise<{ error: string | null }>;
  signOut: () => Promise<void>;
  checkSession: () => Promise<void>;
  setError: (error: string | null) => void;
}

type AuthStore = AuthState & AuthActions;

/**
 * Platform auth (plain Postgres): run the sign in/up request, then load the
 * user from the session cookie it set.
 */
async function platformAuthenticate(
  set: (state: Partial<AuthState>) => void,
  request: () => Promise<string | null>,
): Promise<{ error: string | null }> {
  const error = await request();
  if (error) {
    set({ loading: false, error });
    return { error };
  }

  const platform = await fetchPlatformUser();
  set({ user: platform.user, session: null, role: platform.role, loading: false });
  return { error: null };
}

export const useAuthStore = create<AuthStore>((set, get) => ({
  user: null,
  session: null,
  role: null,
  loading: false,
  initialized: false,
  error: null,

  /**
   * Initialize auth state and listen for auth changes
   * Gracefully handles missing Supabase config (expected during setup)
   */
  initialize: async () => {
    if (get().initialized) return;

    try {
      const supabase = await createBrowserClient();

      // No Supabase: platform auth (plain Postgres), or setup not done yet
      if (!supabase) {
        const platform = await fetchPlatformUser();
        set({
          user: platform.user,
          session: null,
          role: platform.role,
          initialized: true,
          error: null,
        });
        return;
      }

      // Validate session server-side (getUser verifies the JWT, unlike getSession)
      const { data: { user } } = await supabase.auth.getUser();

      if (user) {
        // Refresh the session so the JWT contains the latest app_metadata
        // (role changes via Admin API don't update existing JWTs)
        await supabase.auth.refreshSession();
      }

      const { data: { session } } = await supabase.auth.getSession();

      set({
        user: user ?? null,
        session: user ? session : null,
        role: extractRoleFromUser(user),
        initialized: true,
      });

      supabase.auth.onAuthStateChange((_event, session) => {
        set({
          user: session?.user ?? null,
          session,
          role: extractRoleFromUser(session?.user ?? null),
        });
      });
    } catch (error) {
      console.error('Failed to initialize auth:', error);
      set({
        error: error instanceof Error ? error.message : 'Failed to initialize auth',
        initialized: true,
      });
    }
  },

  /**
   * Sign up a new user
   */
  signUp: async (email, password) => {
    set({ loading: true, error: null });

    try {
      const supabase = await createBrowserClient();

      if (!supabase) {
        return await platformAuthenticate(set, () => platformSignUp(email, password));
      }

      const { data, error } = await supabase.auth.signUp({
        email,
        password,
        options: {
          emailRedirectTo: `${window.location.origin}/ycode`,
          // Note: Email confirmation should be disabled in Supabase Dashboard
          // (Authentication → Providers → Email → Disable "Confirm email")
          // This is recommended for self-hosted single-admin setups
        },
      });

      if (error) {
        set({ loading: false, error: error.message });
        return { error: error.message };
      }

      // Check if email confirmation is required
      if (data.user && !data.session) {
        const message = 'Email confirmation required. Please disable email confirmation in your Supabase project settings (Authentication → Providers → Email).';
        set({ loading: false, error: message });
        return { error: message };
      }

      set({
        user: data.user,
        session: data.session,
        role: extractRoleFromUser(data.user),
        loading: false,
      });

      return { error: null };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Sign up failed';
      set({ loading: false, error: message });
      return { error: message };
    }
  },

  /**
   * Sign in existing user
   */
  signIn: async (email, password) => {
    set({ loading: true, error: null });

    try {
      const supabase = await createBrowserClient();

      if (!supabase) {
        return await platformAuthenticate(set, () => platformSignIn(email, password));
      }

      const { data, error } = await supabase.auth.signInWithPassword({
        email,
        password,
      });

      if (error) {
        set({ loading: false, error: error.message });
        return { error: error.message };
      }

      set({
        user: data.user,
        session: data.session,
        role: extractRoleFromUser(data.user),
        loading: false,
      });

      return { error: null };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Sign in failed';
      set({ loading: false, error: message });
      return { error: message };
    }
  },

  /**
   * Sign out current user
   */
  signOut: async () => {
    set({ loading: true, error: null });

    try {
      const supabase = await createBrowserClient();

      if (!supabase) {
        await platformSignOut();
        set({
          user: null,
          session: null,
          role: null,
          loading: false,
        });
        return;
      }

      const { error } = await supabase.auth.signOut();

      if (error) {
        set({ loading: false, error: error.message });
        return;
      }

      set({
        user: null,
        session: null,
        role: null,
        loading: false,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Sign out failed';
      set({ loading: false, error: message });
    }
  },

  /**
   * Check current session
   */
  checkSession: async () => {
    try {
      const supabase = await createBrowserClient();

      if (!supabase) {
        const platform = await fetchPlatformUser();
        set({ user: platform.user, session: null, role: platform.role });
        return;
      }

      const { data: { session } } = await supabase.auth.getSession();

      set({
        user: session?.user ?? null,
        session,
      });
    } catch (error) {
      console.error('Failed to check session:', error);
    }
  },

  /**
   * Set error message
   */
  setError: (error) => {
    set({ error });
  },
}));
