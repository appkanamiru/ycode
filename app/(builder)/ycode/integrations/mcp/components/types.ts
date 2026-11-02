export interface McpToken {
  id: string;
  name: string;
  token?: string;
  token_prefix: string;
  mcp_url?: string;
  is_active: boolean;
  last_used_at: string | null;
  created_at: string;
  oauth_client_id: string | null;
  expires_at: string | null;
  refresh_expires_at: string | null;
  /** Multi-tenant: whether the connection is for this site or all of the user's sites */
  scope?: 'site' | 'account';
}

export function isOAuthToken(token: McpToken): boolean {
  return Boolean(token.oauth_client_id);
}

/**
 * An OAuth connection stays usable for as long as its refresh token is valid.
 * The 1-hour `expires_at` on the access token is an implementation detail —
 * the client silently refreshes it — so it must never be shown as "expired".
 */
export function isConnectionExpired(token: McpToken): boolean {
  if (!isOAuthToken(token)) return false;
  if (!token.refresh_expires_at) return false;
  return new Date(token.refresh_expires_at).getTime() < Date.now();
}
