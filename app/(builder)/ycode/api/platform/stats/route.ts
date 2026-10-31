import { headers } from 'next/headers';
import { NextResponse } from 'next/server';

import { noCache } from '@/lib/api-response';
import { isMultiTenant } from '@/lib/database/tenancy';
import { getStatsSignInUrl } from '@/lib/platform/analytics';
import { getPlatformAuth } from '@/lib/platform/auth';
import { getUmamiConfig, isPlatformAdmin, isPlatformAuth } from '@/lib/platform/config';

export const dynamic = 'force-dynamic';

/**
 * GET /ycode/api/platform/stats
 *
 * Opens the visitor statistics (Umami) signed in, for platform admins only:
 * the editor session stands in for a separate Umami login.
 */
export async function GET() {
  if (!isPlatformAuth() || !isMultiTenant() || !getUmamiConfig()) {
    return noCache({ error: 'Not found' }, 404);
  }

  const session = await getPlatformAuth().api.getSession({ headers: await headers() });
  if (!session) return noCache({ error: 'Not authenticated' }, 401);
  if (!isPlatformAdmin(session.user.email)) return noCache({ error: 'Forbidden' }, 403);

  try {
    const url = await getStatsSignInUrl();
    if (!url) return noCache({ error: 'Not found' }, 404);
    const response = NextResponse.redirect(url, 303);
    response.headers.set('Cache-Control', 'no-store');
    response.headers.set('Referrer-Policy', 'no-referrer');
    return response;
  } catch (error) {
    console.error('[analytics] Could not open the statistics:', error);
    return noCache({ error: 'Statistics are unavailable' }, 502);
  }
}
