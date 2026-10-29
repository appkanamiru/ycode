import { headers } from 'next/headers';

import { noCache } from '@/lib/api-response';
import { isPlatformAuth } from '@/lib/platform/config';
import { resolveBuilderAccess } from '@/lib/platform/tenants';
import { toAppUser } from '@/lib/platform/user';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * GET /ycode/api/platform/me
 *
 * The signed-in user (in the Supabase user shape), their role and active site.
 * 404 when platform auth is not in use, so the client falls back to Supabase.
 */
export async function GET() {
  if (!isPlatformAuth()) {
    return noCache({ error: 'Not found' }, 404);
  }

  const access = await resolveBuilderAccess(await headers());
  if (!access) {
    return noCache({ error: 'Not authenticated' }, 401);
  }

  return noCache({
    data: {
      user: toAppUser(access),
      role: access.role,
      tenantId: access.tenantId,
    },
  });
}
