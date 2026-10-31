import { isMultiTenant } from '@/lib/database/tenancy';
import { UMAMI_SITE_PATH } from '@/lib/platform/config';

/**
 * Umami tracker for a published page on the multi-tenant platform. Loaded
 * from the site's own host and reporting there (Caddy forwards both).
 */
export default async function SiteAnalytics() {
  if (!isMultiTenant()) return null;

  // Loaded only on the platform: they pull in its auth and database
  const [{ getTenantIdFromHeaders }, { getSiteAnalyticsId }] = await Promise.all([
    import('@/lib/supabase-server'),
    import('@/lib/platform/analytics'),
  ]);
  const tenantId = await getTenantIdFromHeaders();
  const websiteId = tenantId ? await getSiteAnalyticsId(tenantId).catch(() => null) : null;
  if (!websiteId) return null;

  return <script
    defer src={`${UMAMI_SITE_PATH}/script.js`}
    data-website-id={websiteId}
         />;
}
