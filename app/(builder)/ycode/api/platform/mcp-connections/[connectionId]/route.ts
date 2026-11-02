import { headers } from 'next/headers';

import { noCache } from '@/lib/api-response';
import { isMultiTenant } from '@/lib/database/tenancy';
import { isPlatformAuth } from '@/lib/platform/config';
import { revokeAccountConnection } from '@/lib/platform/mcp-account';
import { resolveBuilderAccess } from '@/lib/platform/tenants';

export const dynamic = 'force-dynamic';

/** DELETE /ycode/api/platform/mcp-connections/:connectionId — revoke an account-wide connection */
export async function DELETE(_request: Request, { params }: { params: Promise<{ connectionId: string }> }) {
  if (!isPlatformAuth() || !isMultiTenant()) return noCache({ error: 'Not found' }, 404);

  const access = await resolveBuilderAccess(await headers());
  if (!access) return noCache({ error: 'Not authenticated' }, 401);

  const { connectionId } = await params;
  if (!await revokeAccountConnection(access.user.id, connectionId)) {
    return noCache({ error: 'Connection not found' }, 404);
  }
  return new Response(null, { status: 204 });
}
