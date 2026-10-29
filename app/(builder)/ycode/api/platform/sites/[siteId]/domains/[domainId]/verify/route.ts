import { noCache } from '@/lib/api-response';
import { isMultiTenant } from '@/lib/database/tenancy';
import { isPlatformAuth } from '@/lib/platform/config';
import { verifyDomain } from '@/lib/platform/domains';
import { authorizeSiteAdmin, domainErrorResponse } from '@/lib/platform/http';

export const dynamic = 'force-dynamic';

/**
 * POST /ycode/api/platform/sites/:siteId/domains/:domainId/verify
 *
 * Check the verification TXT record (and whether DNS points here yet).
 */
export async function POST(_request: Request, { params }: { params: Promise<{ siteId: string; domainId: string }> }) {
  if (!isPlatformAuth() || !isMultiTenant()) return noCache({ error: 'Not found' }, 404);

  const { siteId, domainId } = await params;
  const site = await authorizeSiteAdmin(siteId);
  if (site instanceof Response) return site;

  try {
    return noCache({ data: await verifyDomain(siteId, site.slug, domainId) });
  } catch (error) {
    return domainErrorResponse(error);
  }
}
