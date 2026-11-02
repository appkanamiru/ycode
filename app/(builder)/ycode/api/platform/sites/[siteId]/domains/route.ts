import { noCache } from '@/lib/api-response';
import { isMultiTenant } from '@/lib/database/tenancy';
import { isPlatformAuth } from '@/lib/platform/config';
import { addDomain, listDomains } from '@/lib/platform/domains';
import { authorizeSiteAdmin, domainErrorResponse } from '@/lib/platform/http';

export const dynamic = 'force-dynamic';

type RouteContext = { params: Promise<{ siteId: string }> };

/** GET /ycode/api/platform/sites/:siteId/domains — custom domains with their DNS records */
export async function GET(_request: Request, { params }: RouteContext) {
  if (!isPlatformAuth() || !isMultiTenant()) return noCache({ error: 'Not found' }, 404);

  const { siteId } = await params;
  const site = await authorizeSiteAdmin(siteId);
  if (site instanceof Response) return site;

  return noCache({ data: await listDomains(siteId, site.slug) });
}

/** POST /ycode/api/platform/sites/:siteId/domains  { hostname } — add a domain, pending verification */
export async function POST(request: Request, { params }: RouteContext) {
  if (!isPlatformAuth() || !isMultiTenant()) return noCache({ error: 'Not found' }, 404);

  const { siteId } = await params;
  const site = await authorizeSiteAdmin(siteId);
  if (site instanceof Response) return site;

  const body = await request.json().catch(() => null) as { hostname?: unknown } | null;
  try {
    return noCache({ data: await addDomain(siteId, site.slug, body?.hostname) }, 201);
  } catch (error) {
    return domainErrorResponse(error);
  }
}
