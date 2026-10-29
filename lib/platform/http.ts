/**
 * HTTP helpers for platform API routes.
 */

import { isAPIError } from 'better-auth/api';

import { noCache } from '@/lib/api-response';

/** Better Auth errors carry their HTTP status and a user-facing message */
export function authErrorResponse(error: unknown, fallback: string) {
  if (isAPIError(error)) {
    const body = error.body as { message?: string } | undefined;
    return noCache({ error: body?.message || error.message || fallback }, error.statusCode);
  }
  console.error(`[platform] ${fallback}:`, error);
  return noCache({ error: fallback }, 500);
}
