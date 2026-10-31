/**
 * Realtime Connection Tokens
 *
 * Issued on the SSE stream (after the proxy verified the session) and sent
 * with every POST action, so frequent actions such as cursor moves are
 * authorized without a session lookup. Short-lived: the client reconnects,
 * re-checking the session, when a token expires.
 */

import { createHmac, timingSafeEqual } from 'crypto';

export const REALTIME_TOKEN_TTL_MS = 60 * 60 * 1000;

export interface RealtimeTokenClaims {
  connectionId: string;
  tenantId: string | null;
  userId: string;
  expires: number;
}

function getSecret(): string {
  const secret = process.env.REALTIME_SECRET || process.env.BETTER_AUTH_SECRET;
  if (!secret) throw new Error('REALTIME_SECRET (or BETTER_AUTH_SECRET) is required for realtime');
  return secret;
}

function sign(body: string): string {
  return createHmac('sha256', getSecret()).update(body).digest('base64url');
}

export function issueRealtimeToken(claims: Omit<RealtimeTokenClaims, 'expires'>, ttlMs = REALTIME_TOKEN_TTL_MS): string {
  const body = Buffer.from(JSON.stringify({ ...claims, expires: Date.now() + ttlMs })).toString('base64url');
  return `${body}.${sign(body)}`;
}

export function verifyRealtimeToken(token: string | null): RealtimeTokenClaims | null {
  const [body, signature] = (token ?? '').split('.');
  if (!body || !signature) return null;

  const expected = Buffer.from(sign(body));
  const actual = Buffer.from(signature);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;

  try {
    const claims = JSON.parse(Buffer.from(body, 'base64url').toString()) as RealtimeTokenClaims;
    return claims.expires > Date.now() ? claims : null;
  } catch {
    return null;
  }
}
