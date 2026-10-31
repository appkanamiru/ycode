/**
 * /favicon.ico
 *
 * Browsers and crawlers ask for it even when pages link their icon. Points
 * to the site's favicon from its settings; 404 when it has none.
 */

import { fetchGlobalPageSettings } from '@/lib/generate-page-metadata';

export const dynamic = 'force-dynamic';

export async function GET() {
  const settings = await fetchGlobalPageSettings().catch(() => null);
  if (!settings?.faviconUrl) {
    return new Response('Not found', { status: 404 });
  }
  return new Response(null, {
    status: 302,
    headers: { Location: settings.faviconUrl, 'Cache-Control': 'public, max-age=3600' },
  });
}
