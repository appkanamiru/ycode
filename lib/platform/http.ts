/**
 * HTTP helpers for platform API routes.
 */

import { headers } from 'next/headers';
import { isAPIError } from 'better-auth/api';

import { noCache } from '@/lib/api-response';
import { DomainError } from './domains';
import { getSiteMembership } from './sites';
import { resolveBuilderAccess } from './tenants';

/** Better Auth errors carry their HTTP status and a user-facing message */
export function authErrorResponse(error: unknown, fallback: string) {
  if (isAPIError(error)) {
    const body = error.body as { message?: string } | undefined;
    return noCache({ error: body?.message || error.message || fallback }, error.statusCode);
  }
  console.error(`[platform] ${fallback}:`, error);
  return noCache({ error: fallback }, 500);
}

/** The signed-in user must own or administer the site; other sites look nonexistent */
export async function authorizeSiteAdmin(siteId: string): Promise<{ slug: string } | Response> {
  const access = await resolveBuilderAccess(await headers());
  if (!access) return noCache({ error: 'Not authenticated' }, 401);

  const membership = await getSiteMembership(access.user.id, siteId);
  if (!membership || !['owner', 'admin'].includes(membership.role)) {
    return noCache({ error: 'Site not found' }, 404);
  }
  return membership;
}

export function domainErrorResponse(error: unknown) {
  if (error instanceof DomainError) return noCache({ error: error.message }, error.status);
  console.error('[platform/domains]', error);
  return noCache({ error: 'Domain request failed' }, 500);
}
