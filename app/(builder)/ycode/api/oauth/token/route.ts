import { NextRequest } from 'next/server';
import { consumeCode, cleanupExpired } from '@/lib/repositories/mcpOAuthCodeRepository';
import { cleanupOrphanClients } from '@/lib/repositories/mcpOAuthClientRepository';
import { resolveOAuthClient } from '@/lib/oauth/resolve-client';
import {
  cleanupExpiredOAuthTokens,
  createOAuthToken,
  rotateRefreshToken,
  type OAuthTokenPair,
} from '@/lib/repositories/mcpTokenRepository';
import { verifyPkce } from '@/lib/oauth/pkce';
import { isMultiTenant } from '@/lib/database/tenancy';
import { findTenantByOAuthGrant } from '@/lib/platform/mcp';
import {
  cleanupAccountGrants,
  consumeAccountCode,
  isAccountGrant,
  issueAccountToken,
  rotateAccountRefreshToken,
} from '@/lib/platform/mcp-account';
import { runInTenantContext } from '@/lib/supabase-server';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * POST /ycode/api/oauth/token
 *
 * Public token endpoint supporting two grant types:
 *
 *  - `authorization_code`: consume a single-use code issued by /authorize,
 *     verify the PKCE code_verifier matches the stored code_challenge, and
 *     issue an access + refresh token pair.
 *
 *  - `refresh_token`: rotate a refresh token, revoking the old one and
 *     issuing a fresh access + refresh pair.
 */

interface FormBody {
  grant_type?: string;
  code?: string;
  redirect_uri?: string;
  client_id?: string;
  code_verifier?: string;
  refresh_token?: string;
}

function jsonError(status: number, error: string, description?: string): Response {
  return new Response(
    JSON.stringify(description ? { error, error_description: description } : { error }),
    {
      status,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
        'Access-Control-Allow-Origin': '*',
      },
    },
  );
}

function jsonTokens(pair: OAuthTokenPair): Response {
  return new Response(
    JSON.stringify({
      access_token: pair.access_token,
      token_type: 'Bearer',
      expires_in: pair.expires_in,
      refresh_token: pair.refresh_token,
      scope: 'mcp',
    }),
    {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
        'Pragma': 'no-cache',
        'Access-Control-Allow-Origin': '*',
      },
    },
  );
}

async function parseBody(request: NextRequest): Promise<FormBody | null> {
  const contentType = request.headers.get('content-type') || '';

  try {
    if (contentType.includes('application/x-www-form-urlencoded')) {
      const text = await request.text();
      const params = new URLSearchParams(text);
      return {
        grant_type: params.get('grant_type') ?? undefined,
        code: params.get('code') ?? undefined,
        redirect_uri: params.get('redirect_uri') ?? undefined,
        client_id: params.get('client_id') ?? undefined,
        code_verifier: params.get('code_verifier') ?? undefined,
        refresh_token: params.get('refresh_token') ?? undefined,
      };
    }

    if (contentType.includes('application/json')) {
      const json = await request.json();
      return json as FormBody;
    }
  } catch {
    return null;
  }

  return null;
}

export async function POST(request: NextRequest) {
  const body = await parseBody(request);
  if (!body || !body.grant_type) {
    return jsonError(400, 'invalid_request', 'Missing or unparseable request body');
  }

  // Multi-tenant: one token endpoint serves every site, so the code or
  // refresh token decides which tenant the grant is handled in
  if (!isMultiTenant()) {
    return handleGrant(body);
  }
  // Clients connected to a whole account have grants of the user, not a site
  if (isAccountGrant(body)) {
    return handleAccountGrant(body);
  }
  const tenantId = await findTenantByOAuthGrant(body);
  if (!tenantId) {
    return body.grant_type === 'authorization_code' || body.grant_type === 'refresh_token'
      ? jsonError(400, 'invalid_grant', 'Code or refresh token is invalid, expired, or already used')
      : jsonError(400, 'unsupported_grant_type', `Unknown grant_type: ${body.grant_type}`);
  }
  return runInTenantContext(tenantId, () => handleGrant(body));
}

async function handleGrant(body: FormBody): Promise<Response> {
  // Best-effort cleanup of expired codes, dead OAuth tokens, and orphaned
  // DCR registrations ~10% of the time.
  if (Math.random() < 0.1) {
    cleanupExpired().catch(() => {});
    cleanupExpiredOAuthTokens().catch(() => {});
    cleanupOrphanClients().catch(() => {});
  }

  if (body.grant_type === 'authorization_code') {
    return handleAuthorizationCode(body);
  }

  if (body.grant_type === 'refresh_token') {
    return handleRefreshToken(body);
  }

  return jsonError(400, 'unsupported_grant_type', `Unknown grant_type: ${body.grant_type}`);
}

async function handleAuthorizationCode(body: FormBody): Promise<Response> {
  const { code, redirect_uri: redirectUri, client_id: clientId, code_verifier: codeVerifier } = body;

  if (!code || !redirectUri || !clientId || !codeVerifier) {
    return jsonError(
      400,
      'invalid_request',
      'authorization_code grant requires code, redirect_uri, client_id, code_verifier',
    );
  }

  const stored = await consumeCode(code);
  if (!stored) {
    return jsonError(400, 'invalid_grant', 'Code is invalid, expired, or already used');
  }

  if (stored.client_id !== clientId) {
    return jsonError(400, 'invalid_grant', 'client_id mismatch');
  }

  if (stored.redirect_uri !== redirectUri) {
    return jsonError(400, 'invalid_grant', 'redirect_uri mismatch');
  }

  const pkceOk = await verifyPkce(codeVerifier, stored.code_challenge, stored.code_challenge_method);
  if (!pkceOk) {
    return jsonError(400, 'invalid_grant', 'PKCE verification failed');
  }

  const client = await resolveOAuthClient(stored.client_id);
  if (!client) {
    return jsonError(400, 'invalid_client', 'Client no longer exists');
  }

  try {
    const pair = await createOAuthToken({
      user_id: stored.user_id,
      oauth_client_id: stored.client_id,
      name: client.client_name,
    });
    return jsonTokens(pair);
  } catch (error) {
    console.error('[oauth/token] createOAuthToken failed:', error);
    return jsonError(
      500,
      'server_error',
      error instanceof Error ? error.message : 'Failed to issue token',
    );
  }
}

async function handleRefreshToken(body: FormBody): Promise<Response> {
  const { refresh_token: refreshToken, client_id: clientId } = body;

  if (!refreshToken) {
    return jsonError(400, 'invalid_request', 'refresh_token is required');
  }

  if (!clientId) {
    return jsonError(400, 'invalid_request', 'client_id is required');
  }

  const pair = await rotateRefreshToken(refreshToken, clientId);
  if (!pair) {
    return jsonError(400, 'invalid_grant', 'Refresh token is invalid, expired, revoked, or issued to another client');
  }

  return jsonTokens(pair);
}

async function handleAccountGrant(body: FormBody): Promise<Response> {
  if (Math.random() < 0.1) cleanupAccountGrants().catch(() => {});

  if (body.grant_type === 'refresh_token') {
    if (!body.refresh_token || !body.client_id) {
      return jsonError(400, 'invalid_request', 'refresh_token and client_id are required');
    }
    const pair = await rotateAccountRefreshToken(body.refresh_token, body.client_id);
    return pair
      ? jsonTokens(pair)
      : jsonError(400, 'invalid_grant', 'Refresh token is invalid, expired, revoked, or issued to another client');
  }

  const { code, redirect_uri: redirectUri, client_id: clientId, code_verifier: codeVerifier } = body;
  if (!code || !redirectUri || !clientId || !codeVerifier) {
    return jsonError(400, 'invalid_request', 'authorization_code grant requires code, redirect_uri, client_id, code_verifier');
  }
  const stored = await consumeAccountCode(code);
  if (!stored) return jsonError(400, 'invalid_grant', 'Code is invalid, expired, or already used');
  if (stored.clientId !== clientId) return jsonError(400, 'invalid_grant', 'client_id mismatch');
  if (stored.redirectUri !== redirectUri) return jsonError(400, 'invalid_grant', 'redirect_uri mismatch');
  if (!await verifyPkce(codeVerifier, stored.codeChallenge, stored.codeChallengeMethod)) {
    return jsonError(400, 'invalid_grant', 'PKCE verification failed');
  }
  const client = await resolveOAuthClient(stored.clientId);
  if (!client) return jsonError(400, 'invalid_client', 'Client no longer exists');

  return jsonTokens(await issueAccountToken({ userId: stored.userId, clientId: stored.clientId, name: client.client_name }));
}

export async function OPTIONS() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    },
  });
}
