import { headers } from 'next/headers';

import { noCache } from '@/lib/api-response';
import { isMultiTenant } from '@/lib/database/tenancy';
import { getPlatformAuth } from '@/lib/platform/auth';
import { getSitesDomain, getUmamiConfig, isPlatformAdmin, isPlatformAuth } from '@/lib/platform/config';
import { authErrorResponse } from '@/lib/platform/http';
import { countOwnedSites, DEFAULT_SITE_LIMIT, listSites, validateSiteSlug } from '@/lib/platform/sites';
import { getSiteGenerator } from '@/lib/ycode-html-comment';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * GET /ycode/api/platform/sites
 *
 * The signed-in user's sites, which one is active, and how many more they
 * may create. 404 unless running multi-tenant on plain Postgres.
 */
export async function GET() {
  if (!isPlatformAuth() || !isMultiTenant()) {
    return noCache({ error: 'Not found' }, 404);
  }

  const requestHeaders = await headers();
  const session = await getPlatformAuth().api.getSession({ headers: requestHeaders });
  if (!session) {
    return noCache({ error: 'Not authenticated' }, 401);
  }

  const [sites, owned] = await Promise.all([
    listSites(session.user.id, session.session.activeOrganizationId ?? null),
    countOwnedSites(session.user.id),
  ]);
  const limit = Number((session.user as { siteLimit?: number }).siteLimit) || DEFAULT_SITE_LIMIT;

  return noCache({
    data: {
      sites,
      owned,
      limit,
      canCreate: owned < limit,
      sitesDomain: getSitesDomain(),
      generatorName: getSiteGenerator().name,
      // Platform admins can open the visitor statistics (/ycode/api/platform/stats)
      stats: Boolean(getUmamiConfig()) && isPlatformAdmin(session.user.email),
    },
  });
}

/**
 * POST /ycode/api/platform/sites  { name, slug }
 *
 * Create a site: an organization owned by the user, filled with the default
 * content and made the active site.
 */
export async function POST(request: Request) {
  if (!isPlatformAuth() || !isMultiTenant()) {
    return noCache({ error: 'Not found' }, 404);
  }

  const body = await request.json().catch(() => null) as { name?: unknown; slug?: unknown } | null;
  const name = typeof body?.name === 'string' ? body.name.trim() : '';
  if (!name || name.length > 100) {
    return noCache({ error: 'Name is required (up to 100 characters)' }, 400);
  }
  const slugProblem = validateSiteSlug(body?.slug);
  if (slugProblem) {
    return noCache({ error: slugProblem }, 400);
  }

  try {
    const site = await getPlatformAuth().api.createOrganization({
      headers: await headers(),
      body: { name, slug: body!.slug as string },
    });
    return noCache({ data: site }, 201);
  } catch (error) {
    return authErrorResponse(error, 'Failed to create the site');
  }
}
