import { getDbClient } from '@/lib/database/pg-client';
import { createHash, randomBytes } from 'crypto';
import { invalidateToken } from '@/lib/mcp/token-cache';

export interface McpToken {
  id: string;
  name: string;
  token_prefix: string;
  is_active: boolean;
  last_used_at: string | null;
  created_at: string;
  updated_at: string;
  oauth_client_id: string | null;
  expires_at: string | null;
  refresh_expires_at: string | null;
  user_id: string | null;
}

export interface McpTokenWithPlainToken extends McpToken {
  token: string;
}

export interface OAuthTokenPair {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  refresh_expires_in: number;
}

export interface CreateOAuthTokenData {
  user_id: string;
  oauth_client_id: string;
  name: string;
  access_token_ttl_seconds?: number;
  refresh_token_ttl_seconds?: number;
  /**
   * Original connection time. Rotation passes the previous row's value so the
   * "Created" date shown in the builder stays stable across hourly refreshes.
   */
  created_at?: string;
}

const DEFAULT_ACCESS_TOKEN_TTL_SECONDS = 60 * 60; // 1 hour
const DEFAULT_REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days

/**
 * How long a rotated refresh token keeps working after it has been used.
 * Clients occasionally fire two refreshes at once; without a grace window the
 * second one fails and the connection drops.
 */
const REFRESH_GRACE_MS = 30 * 1000;

const TOKEN_COLUMNS = 'id, name, token_prefix, is_active, last_used_at, created_at, updated_at, oauth_client_id, expires_at, refresh_expires_at, user_id';

function generateToken(): string {
  return 'ymc_' + randomBytes(24).toString('hex');
}

function generateRefreshToken(): string {
  return 'ymr_' + randomBytes(32).toString('hex');
}

/**
 * Hash a refresh token with SHA-256 before storing. We only ever hand the
 * plaintext value back to the OAuth client once at issue time; the database
 * keeps the hash so a DB leak can't be replayed against `/oauth/token`.
 */
function hashRefreshToken(refreshToken: string): string {
  return createHash('sha256').update(refreshToken).digest('hex');
}

export async function getAllTokens(): Promise<McpToken[]> {
  const client = await getDbClient();

  if (!client) {
    throw new Error('Supabase not configured');
  }

  const { data, error } = await client
    .from('mcp_tokens')
    .select(TOKEN_COLUMNS)
    .eq('is_active', true)
    .order('created_at', { ascending: false });

  if (error) {
    throw new Error(`Failed to fetch MCP tokens: ${error.message}`);
  }

  return data || [];
}

export async function createToken(name: string): Promise<McpTokenWithPlainToken> {
  const client = await getDbClient();

  if (!client) {
    throw new Error('Supabase not configured');
  }

  const token = generateToken();
  const tokenPrefix = token.substring(0, 12);

  const { data, error } = await client
    .from('mcp_tokens')
    .insert({
      name,
      token,
      token_prefix: tokenPrefix,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .select(`token, ${TOKEN_COLUMNS}`)
    .single();

  if (error) {
    throw new Error(`Failed to create MCP token: ${error.message}`);
  }

  return data;
}

/**
 * Validate a token and return the record if active and not expired.
 * Updates last_used_at in the background.
 */
export async function validateToken(token: string): Promise<McpToken | null> {
  const client = await getDbClient();

  if (!client) {
    throw new Error('Supabase not configured');
  }

  const { data, error } = await client
    .from('mcp_tokens')
    .select(TOKEN_COLUMNS)
    .eq('token', token)
    .eq('is_active', true)
    .single();

  if (error || !data) {
    return null;
  }

  if (data.expires_at && new Date(data.expires_at).getTime() < Date.now()) {
    return null;
  }

  await client
    .from('mcp_tokens')
    .update({ last_used_at: new Date().toISOString() })
    .eq('id', data.id);

  return data;
}

export async function deleteToken(id: string): Promise<void> {
  const client = await getDbClient();

  if (!client) {
    throw new Error('Supabase not configured');
  }

  const { data: existing } = await client
    .from('mcp_tokens')
    .select('token')
    .eq('id', id)
    .single();

  const { error } = await client
    .from('mcp_tokens')
    .delete()
    .eq('id', id);

  if (error) {
    throw new Error(`Failed to delete MCP token: ${error.message}`);
  }

  if (existing?.token) {
    invalidateToken(existing.token);
  }
}

export async function getTokenById(id: string): Promise<McpToken | null> {
  const client = await getDbClient();

  if (!client) {
    throw new Error('Supabase not configured');
  }

  const { data, error } = await client
    .from('mcp_tokens')
    .select(TOKEN_COLUMNS)
    .eq('id', id)
    .single();

  if (error && error.code !== 'PGRST116') {
    throw new Error(`Failed to fetch MCP token: ${error.message}`);
  }

  return data;
}

/**
 * Issue an OAuth-bound MCP token pair (access + refresh).
 * Both tokens are random opaque strings stored alongside their TTLs.
 */
export async function createOAuthToken(
  data: CreateOAuthTokenData,
): Promise<OAuthTokenPair> {
  const client = await getDbClient();

  if (!client) {
    throw new Error('Supabase not configured');
  }

  const accessTtl = data.access_token_ttl_seconds ?? DEFAULT_ACCESS_TOKEN_TTL_SECONDS;
  const refreshTtl = data.refresh_token_ttl_seconds ?? DEFAULT_REFRESH_TOKEN_TTL_SECONDS;

  const token = generateToken();
  const refreshToken = generateRefreshToken();
  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  const expiresAt = new Date(now + accessTtl * 1000).toISOString();
  const refreshExpiresAt = new Date(now + refreshTtl * 1000).toISOString();
  const tokenPrefix = token.substring(0, 12);

  const { error } = await client
    .from('mcp_tokens')
    .insert({
      name: data.name,
      token,
      token_prefix: tokenPrefix,
      oauth_client_id: data.oauth_client_id,
      user_id: data.user_id,
      expires_at: expiresAt,
      refresh_token_hash: hashRefreshToken(refreshToken),
      refresh_expires_at: refreshExpiresAt,
      created_at: data.created_at ?? nowIso,
      updated_at: nowIso,
    });

  if (error) {
    throw new Error(`Failed to create OAuth MCP token: ${error.message}`);
  }

  return {
    access_token: token,
    refresh_token: refreshToken,
    expires_in: accessTtl,
    refresh_expires_in: refreshTtl,
  };
}

/**
 * Rotate a refresh token: validate the old one, issue a fresh access+refresh
 * pair, and retire the old row. Returns null if the refresh token is unknown,
 * revoked, expired, or was issued to a different client.
 *
 * The old row is kept (inactive) for a short grace window instead of being
 * deleted outright so a concurrent duplicate refresh still succeeds. Inactive
 * rows past their grace window are removed by `cleanupExpiredOAuthTokens`.
 */
export async function rotateRefreshToken(
  refreshToken: string,
  clientId: string,
  options?: { access_token_ttl_seconds?: number; refresh_token_ttl_seconds?: number },
): Promise<OAuthTokenPair | null> {
  const client = await getDbClient();

  if (!client) {
    throw new Error('Supabase not configured');
  }

  const nowIso = new Date().toISOString();

  const { data: existing, error: fetchError } = await client
    .from('mcp_tokens')
    .select('id, name, token, oauth_client_id, user_id, refresh_expires_at, is_active, created_at')
    .eq('refresh_token_hash', hashRefreshToken(refreshToken))
    .or(`is_active.eq.true,refresh_grace_until.gt.${nowIso}`)
    .single();

  if (fetchError || !existing) {
    return null;
  }

  if (!existing.refresh_expires_at
      || new Date(existing.refresh_expires_at).getTime() < Date.now()) {
    return null;
  }

  if (!existing.oauth_client_id || !existing.user_id) {
    return null;
  }

  // RFC 6749 §6: a refresh token is bound to the client it was issued to.
  if (existing.oauth_client_id !== clientId) {
    return null;
  }

  // Retire the old row before issuing the new pair. The access token stops
  // working immediately (validateToken requires is_active); the refresh token
  // stays usable only until refresh_grace_until.
  if (existing.is_active) {
    await client
      .from('mcp_tokens')
      .update({
        is_active: false,
        refresh_grace_until: new Date(Date.now() + REFRESH_GRACE_MS).toISOString(),
        updated_at: nowIso,
      })
      .eq('id', existing.id);

    if (existing.token) {
      invalidateToken(existing.token);
    }
  }

  return createOAuthToken({
    user_id: existing.user_id,
    oauth_client_id: existing.oauth_client_id,
    name: existing.name,
    created_at: existing.created_at,
    access_token_ttl_seconds: options?.access_token_ttl_seconds,
    refresh_token_ttl_seconds: options?.refresh_token_ttl_seconds,
  });
}

/**
 * Remove OAuth token rows that can no longer be used: refresh token expired,
 * or rotated and past the grace window. URL tokens (no oauth_client_id) are
 * never touched. Best-effort; callers should not await failures.
 */
export async function cleanupExpiredOAuthTokens(): Promise<void> {
  const client = await getDbClient();

  if (!client) {
    return;
  }

  const nowIso = new Date().toISOString();

  await client
    .from('mcp_tokens')
    .delete()
    .not('oauth_client_id', 'is', null)
    .or(`refresh_expires_at.lt.${nowIso},and(is_active.eq.false,refresh_grace_until.lt.${nowIso})`);
}
