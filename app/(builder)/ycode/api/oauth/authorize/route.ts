import { NextRequest, NextResponse } from 'next/server';
import { getAuthUser } from '@/lib/supabase-auth';
import { isRedirectUriRegistered, resolveOAuthClient } from '@/lib/oauth/resolve-client';
import { createCode } from '@/lib/repositories/mcpOAuthCodeRepository';
import { isMultiTenant } from '@/lib/database/tenancy';
import { getSiteMembership } from '@/lib/platform/sites';
import { runInTenantContext } from '@/lib/supabase-server';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * POST /ycode/api/oauth/authorize
 *
 * Called by the consent page (`/ycode/oauth/authorize`) when the user
 * approves or denies an OAuth request. Validates the session, client,
 * and PKCE parameters; on approve issues a single-use code and 302s
 * back to `redirect_uri`.
 *
 * Returns JSON for fetch() callers and uses 302 only for direct form posts.
 */

interface AuthorizeBody {
  client_id?: unknown;
  redirect_uri?: unknown;
  code_challenge?: unknown;
  code_challenge_method?: unknown;
  state?: unknown;
  scope?: unknown;
  decision?: unknown; // 'approve' | 'deny'
  site_id?: unknown; // multi-tenant: the site the client gets access to
}

function redirectWithError(
  redirectUri: string,
  error: string,
  state: string | null,
  description?: string,
): NextResponse {
  const url = new URL(redirectUri);
  url.searchParams.set('error', error);
  if (description) url.searchParams.set('error_description', description);
  if (state) url.searchParams.set('state', state);
  return NextResponse.redirect(url, { status: 302 });
}

export async function POST(request: NextRequest) {
  let body: AuthorizeBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: 'invalid_request', error_description: 'Request body must be JSON' },
      { status: 400 },
    );
  }

  const clientId = typeof body.client_id === 'string' ? body.client_id : null;
  const redirectUri = typeof body.redirect_uri === 'string' ? body.redirect_uri : null;
  const codeChallenge = typeof body.code_challenge === 'string' ? body.code_challenge : null;
  const codeChallengeMethod = typeof body.code_challenge_method === 'string'
    ? body.code_challenge_method
    : null;
  const state = typeof body.state === 'string' ? body.state : null;
  const scope = typeof body.scope === 'string' ? body.scope : null;
  const decision = typeof body.decision === 'string' ? body.decision : null;

  if (!clientId || !redirectUri || !codeChallenge || !codeChallengeMethod) {
    return NextResponse.json(
      { error: 'invalid_request', error_description: 'Missing required parameters' },
      { status: 400 },
    );
  }

  if (codeChallengeMethod !== 'S256') {
    return NextResponse.json(
      {
        error: 'invalid_request',
        error_description: 'Only S256 PKCE method is supported',
      },
      { status: 400 },
    );
  }

  if (decision !== 'approve' && decision !== 'deny') {
    return NextResponse.json(
      { error: 'invalid_request', error_description: 'decision must be approve or deny' },
      { status: 400 },
    );
  }

  const auth = await getAuthUser();
  if (!auth) {
    return NextResponse.json({ error: 'login_required' }, { status: 401 });
  }

  const client = await resolveOAuthClient(clientId);
  if (!client) {
    return NextResponse.json(
      { error: 'invalid_client', error_description: 'Unknown client_id' },
      { status: 400 },
    );
  }

  if (!isRedirectUriRegistered(client, redirectUri)) {
    return NextResponse.json(
      { error: 'invalid_request', error_description: 'redirect_uri not registered' },
      { status: 400 },
    );
  }

  if (decision === 'deny') {
    const url = redirectWithError(redirectUri, 'access_denied', state).headers.get('location')!;
    return NextResponse.json({ redirect_to: url });
  }

  // Multi-tenant: the code (and the tokens issued for it) belong to the site
  // the user picked, which they must be a member of
  let siteId: string | null = null;
  if (isMultiTenant()) {
    siteId = typeof body.site_id === 'string' ? body.site_id : null;
    if (!siteId || !(await getSiteMembership(auth.user.id, siteId))) {
      return NextResponse.json(
        { error: 'invalid_request', error_description: 'Choose one of your sites' },
        { status: 400 },
      );
    }
  }

  try {
    const code = await runInTenantContext(siteId, () => createCode({
      client_id: clientId,
      redirect_uri: redirectUri,
      code_challenge: codeChallenge,
      code_challenge_method: codeChallengeMethod,
      scope,
      user_id: auth.user.id,
    }));

    const url = new URL(redirectUri);
    url.searchParams.set('code', code);
    if (state) url.searchParams.set('state', state);

    return NextResponse.json({ redirect_to: url.toString() });
  } catch (error) {
    console.error('[oauth/authorize] Failed to issue code:', error);
    return NextResponse.json(
      {
        error: 'server_error',
        error_description: error instanceof Error ? error.message : 'Failed to issue code',
      },
      { status: 500 },
    );
  }
}
