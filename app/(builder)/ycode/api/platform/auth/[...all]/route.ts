import { isPlatformAuth } from '@/lib/platform/config';
import { getPlatformAuth } from '@/lib/platform/auth';

export const dynamic = 'force-dynamic';

/**
 * /ycode/api/platform/auth/*
 *
 * Better Auth endpoints (sign up/in/out, session, organizations).
 * Only available when running on plain Postgres.
 */
async function handler(request: Request): Promise<Response> {
  if (!isPlatformAuth()) {
    return new Response('Not found', { status: 404 });
  }

  return getPlatformAuth().handler(request);
}

export { handler as GET, handler as POST };
