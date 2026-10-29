import { headers } from 'next/headers';

import { noCache } from '@/lib/api-response';
import { isMultiTenant } from '@/lib/database/tenancy';
import { getPlatformAuth } from '@/lib/platform/auth';
import { isPlatformAuth } from '@/lib/platform/config';
import { authErrorResponse } from '@/lib/platform/http';

export const dynamic = 'force-dynamic';

/**
 * POST /ycode/api/platform/sites/activate  { slug }
 *
 * Switch the editor to another of the user's sites.
 */
export async function POST(request: Request) {
  if (!isPlatformAuth() || !isMultiTenant()) {
    return noCache({ error: 'Not found' }, 404);
  }

  const body = await request.json().catch(() => null) as { slug?: unknown } | null;
  if (typeof body?.slug !== 'string' || !body.slug) {
    return noCache({ error: 'slug is required' }, 400);
  }

  try {
    // Fails unless the user is a member of the site
    await getPlatformAuth().api.setActiveOrganization({
      headers: await headers(),
      body: { organizationSlug: body.slug },
    });
    return noCache({ data: { slug: body.slug } });
  } catch (error) {
    return authErrorResponse(error, 'Failed to switch site');
  }
}
