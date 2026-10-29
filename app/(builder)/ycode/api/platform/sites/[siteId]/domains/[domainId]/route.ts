import { noCache } from '@/lib/api-response';
import { isMultiTenant } from '@/lib/database/tenancy';
import { isPlatformAuth } from '@/lib/platform/config';
import { removeDomain } from '@/lib/platform/domains';
import { authorizeSiteAdmin, domainErrorResponse } from '@/lib/platform/http';

export const dynamic = 'force-dynamic';

/** DELETE /ycode/api/platform/sites/:siteId/domains/:domainId */
export async function DELETE(_request: Request, { params }: { params: Promise<{ siteId: string; domainId: string }> }) {
  if (!isPlatformAuth() || !isMultiTenant()) return noCache({ error: 'Not found' }, 404);

  const { siteId, domainId } = await params;
  const site = await authorizeSiteAdmin(siteId);
  if (site instanceof Response) return site;

  try {
    await removeDomain(siteId, domainId);
    return new Response(null, { status: 204 });
  } catch (error) {
    return domainErrorResponse(error);
  }
}
