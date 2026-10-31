import { noCache } from '@/lib/api-response';
import { isMultiTenant } from '@/lib/database/tenancy';
import { isPlatformAuth } from '@/lib/platform/config';
import { handleInvitationAccept } from '@/lib/platform/team';

export const dynamic = 'force-dynamic';

/**
 * POST /ycode/api/platform/invitations/accept  { invitationId }
 *
 * Join the site the signed-in user was invited to, and make it active.
 */
export async function POST(request: Request) {
  if (!isPlatformAuth() || !isMultiTenant()) {
    return noCache({ error: 'Not found' }, 404);
  }
  return handleInvitationAccept(request);
}
