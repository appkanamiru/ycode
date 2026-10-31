import { headers } from 'next/headers';

import { noCache } from '@/lib/api-response';
import { isMultiTenant } from '@/lib/database/tenancy';
import { isPlatformAuth } from '@/lib/platform/config';
import { listAccountConnections } from '@/lib/platform/mcp-account';
import { resolveBuilderAccess } from '@/lib/platform/tenants';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/** GET /ycode/api/platform/mcp-connections — the user's account-wide MCP connections */
export async function GET() {
  if (!isPlatformAuth() || !isMultiTenant()) return noCache({ error: 'Not found' }, 404);

  const access = await resolveBuilderAccess(await headers());
  if (!access) return noCache({ error: 'Not authenticated' }, 401);

  return noCache({ data: await listAccountConnections(access.user.id) });
}
