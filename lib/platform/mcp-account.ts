/**
 * Account-wide MCP Connections
 *
 * An MCP client connected at the editor's `/ycode/mcp` works on every site
 * of the user who approved it, including sites they join later; each tool
 * call names its site. (A site's own address, `<slug>.<sites domain>/ycode/mcp`,
 * connects to that site only.) Its OAuth codes
 * and tokens belong to the user, not to a site, so they live in the platform
 * schema instead of the per-site mcp_oauth_codes / mcp_tokens. Only hashes
 * are stored. Lifetimes and refresh rotation match the per-site tokens.
 */

import { createHash, randomBytes } from 'crypto';

import { PLATFORM_SCHEMA } from './config';
import { getPlatformPool } from './db';

const CODE_PREFIX = 'mcp_acct_';
const ACCESS_PREFIX = 'yma_';
const REFRESH_PREFIX = 'ymar_';

const CODE_TTL_MS = 10 * 60 * 1000;
const ACCESS_TTL_SECONDS = 60 * 60;
const REFRESH_TTL_SECONDS = 30 * 24 * 60 * 60;
/** A rotated refresh token keeps working this long, for concurrent refreshes */
const REFRESH_GRACE_MS = 30 * 1000;

const ACCESS_CACHE_TTL_MS = 30_000;
const globalForAccount = globalThis as unknown as {
  __mcpAccountTokenCache?: Map<string, { userId: string | null; expiresAt: number }>;
};
/** On globalThis: the MCP route and the route that revokes tokens are separate bundles */
const accessCache = globalForAccount.__mcpAccountTokenCache ??= new Map();

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** Whether an access token is one of an account-wide connection */
export function isAccountAccessToken(token: string | null | undefined): boolean {
  return Boolean(token?.startsWith(ACCESS_PREFIX));
}

/** Whether a code or refresh token was issued for an account-wide connection */
export function isAccountGrant(grant: { grant_type?: string; code?: string; refresh_token?: string }): boolean {
  if (grant.grant_type === 'authorization_code') return Boolean(grant.code?.startsWith(CODE_PREFIX));
  if (grant.grant_type === 'refresh_token') return Boolean(grant.refresh_token?.startsWith(REFRESH_PREFIX));
  return false;
}

export interface AccountCodeData {
  userId: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  codeChallengeMethod: string;
}

export async function createAccountCode(data: AccountCodeData): Promise<string> {
  const code = CODE_PREFIX + randomBytes(32).toString('hex');
  await getPlatformPool().query(
    `insert into ${PLATFORM_SCHEMA}.mcp_account_codes
       (code_hash, user_id, client_id, redirect_uri, code_challenge, code_challenge_method, expires_at)
     values ($1, $2, $3, $4, $5, $6, $7)`,
    [hash(code), data.userId, data.clientId, data.redirectUri, data.codeChallenge, data.codeChallengeMethod, new Date(Date.now() + CODE_TTL_MS)],
  );
  return code;
}

/** Use up a code: it works once, until it expires */
export async function consumeAccountCode(code: string): Promise<AccountCodeData | null> {
  const { rows } = await getPlatformPool().query(
    `delete from ${PLATFORM_SCHEMA}.mcp_account_codes where code_hash = $1
     returning user_id, client_id, redirect_uri, code_challenge, code_challenge_method, expires_at`,
    [hash(code)],
  );
  const row = rows[0];
  if (!row || new Date(row.expires_at).getTime() < Date.now()) return null;
  return {
    userId: row.user_id,
    clientId: row.client_id,
    redirectUri: row.redirect_uri,
    codeChallenge: row.code_challenge,
    codeChallengeMethod: row.code_challenge_method,
  };
}

export interface AccountTokenPair {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  refresh_expires_in: number;
}

export async function issueAccountToken(
  data: { userId: string; clientId: string; name: string; createdAt?: Date },
): Promise<AccountTokenPair> {
  const accessToken = ACCESS_PREFIX + randomBytes(24).toString('hex');
  const refreshToken = REFRESH_PREFIX + randomBytes(32).toString('hex');
  const now = Date.now();
  await getPlatformPool().query(
    `insert into ${PLATFORM_SCHEMA}.mcp_account_tokens
       (user_id, client_id, name, access_token_hash, expires_at, refresh_token_hash, refresh_expires_at, created_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      data.userId, data.clientId, data.name,
      hash(accessToken), new Date(now + ACCESS_TTL_SECONDS * 1000),
      hash(refreshToken), new Date(now + REFRESH_TTL_SECONDS * 1000),
      data.createdAt ?? new Date(now),
    ],
  );
  return { access_token: accessToken, refresh_token: refreshToken, expires_in: ACCESS_TTL_SECONDS, refresh_expires_in: REFRESH_TTL_SECONDS };
}

/**
 * Exchange a refresh token for a new pair and retire the old one. Null when
 * it is unknown, expired, revoked or was issued to another client.
 */
export async function rotateAccountRefreshToken(refreshToken: string, clientId: string): Promise<AccountTokenPair | null> {
  const pool = getPlatformPool();
  const { rows } = await pool.query(
    `select id, user_id, client_id, name, access_token_hash, refresh_expires_at, is_active, created_at
     from ${PLATFORM_SCHEMA}.mcp_account_tokens
     where refresh_token_hash = $1 and (is_active or refresh_grace_until > now())`,
    [hash(refreshToken)],
  );
  const row = rows[0];
  if (!row || new Date(row.refresh_expires_at).getTime() < Date.now() || row.client_id !== clientId) return null;

  if (row.is_active) {
    await pool.query(
      `update ${PLATFORM_SCHEMA}.mcp_account_tokens set is_active = false, refresh_grace_until = $2 where id = $1`,
      [row.id, new Date(Date.now() + REFRESH_GRACE_MS)],
    );
    accessCache.delete(row.access_token_hash);
  }

  return issueAccountToken({ userId: row.user_id, clientId: row.client_id, name: row.name, createdAt: row.created_at });
}

/** The user an access token acts for, or null when it is not valid */
export async function validateAccountToken(accessToken: string): Promise<string | null> {
  if (!isAccountAccessToken(accessToken)) return null;
  const tokenHash = hash(accessToken);
  const cached = accessCache.get(tokenHash);
  if (cached && cached.expiresAt > Date.now()) return cached.userId;

  const { rows } = await getPlatformPool().query(
    `update ${PLATFORM_SCHEMA}.mcp_account_tokens set last_used_at = now()
     where access_token_hash = $1 and is_active and expires_at > now()
     returning user_id, expires_at`,
    [tokenHash],
  );
  const userId: string | null = rows[0]?.user_id ?? null;
  const expiresAt = rows[0] ? Math.min(Date.now() + ACCESS_CACHE_TTL_MS, new Date(rows[0].expires_at).getTime()) : Date.now() + ACCESS_CACHE_TTL_MS;
  accessCache.set(tokenHash, { userId, expiresAt });
  return userId;
}

export interface AccountConnection {
  id: string;
  name: string;
  createdAt: string;
  lastUsedAt: string | null;
}

/** The user's active account-wide connections, one per client */
export async function listAccountConnections(userId: string): Promise<AccountConnection[]> {
  const { rows } = await getPlatformPool().query(
    `select id, name, created_at, last_used_at from ${PLATFORM_SCHEMA}.mcp_account_tokens
     where user_id = $1 and is_active and refresh_expires_at > now() order by created_at`,
    [userId],
  );
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    createdAt: new Date(row.created_at).toISOString(),
    lastUsedAt: row.last_used_at ? new Date(row.last_used_at).toISOString() : null,
  }));
}

/** Revoke a connection: its access token stops working, it cannot be refreshed */
export async function revokeAccountConnection(userId: string, connectionId: string): Promise<boolean> {
  const { rows } = await getPlatformPool().query(
    `delete from ${PLATFORM_SCHEMA}.mcp_account_tokens where id = $1 and user_id = $2 returning access_token_hash`,
    [connectionId, userId],
  );
  if (rows[0]) accessCache.delete(rows[0].access_token_hash);
  return Boolean(rows[0]);
}

/** Drop expired codes and tokens that can no longer be refreshed. Best-effort. */
export async function cleanupAccountGrants(): Promise<void> {
  const pool = getPlatformPool();
  await pool.query(`delete from ${PLATFORM_SCHEMA}.mcp_account_codes where expires_at < now()`);
  await pool.query(
    `delete from ${PLATFORM_SCHEMA}.mcp_account_tokens
     where refresh_expires_at < now() or (not is_active and (refresh_grace_until is null or refresh_grace_until < now()))`,
  );
}
