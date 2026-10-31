/**
 * Whether published pages show the "Made in …" badge.
 *
 * A single site follows its `ycode_badge` setting (on by default). On the
 * multi-tenant platform the badge is not a setting: a site shows it until it
 * is served on its own address (see hasOwnAddress).
 */

import { isMultiTenant } from '@/lib/database/tenancy';

export async function shouldShowSiteBadge(setting: unknown): Promise<boolean> {
  if (!isMultiTenant()) return setting !== false;
  // Loaded only on the platform: they pull in its auth and database
  const [{ getTenantIdFromHeaders }, { resolveSiteBadge }] = await Promise.all([
    import('@/lib/supabase-server'),
    import('@/lib/platform/tenants'),
  ]);
  const tenantId = await getTenantIdFromHeaders();
  return tenantId ? resolveSiteBadge(tenantId) : false;
}
