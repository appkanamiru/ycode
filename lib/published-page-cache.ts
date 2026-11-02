import 'server-only';

import { unstable_cache } from 'next/cache';
import { buildAllPagesTag, buildRouteTag } from '@/lib/cache-tags';
import { getDocumentSlugPath } from '@/lib/document-path';
import { fetchErrorPage, fetchPageByPathForMetadata, slimPageData } from '@/lib/page-fetcher';
import { resolvePathLocaleCode } from '@/lib/resolve-html-lang';
import type { PageData } from '@/lib/page-fetcher';
import { getTenantIdFromHeaders, runInTenantContext } from '@/lib/supabase-server';

export type ErrorPageCode = 401 | 404;

/**
 * Cached lookup of the user's custom error page, invalidated on publish.
 * Shared by the 404 boundary, the page routes and their metadata so a single
 * cache entry per locale serves all of them.
 * @param slugPath - Requested path (no leading slash) whose locale the page is
 * translated into. A 404 without one uses the document path, since the
 * not-found boundary receives no route params.
 * Lookup failures resolve to null without being cached, so a transient
 * database error doesn't pin the fallback page until the next publish.
 */
export async function fetchCachedErrorPage(
  errorCode: ErrorPageCode,
  requestedTenantId?: string,
  slugPath?: string
): Promise<PageData | null> {
  try {
    const tenantId = requestedTenantId ?? (await getTenantIdFromHeaders()) ?? undefined;
    const localePath = slugPath ?? (errorCode === 404 ? getDocumentSlugPath() : undefined);
    const localeCode = localePath ? await resolvePathLocaleCode(localePath, true, tenantId) : null;

    return await unstable_cache(
      async () => runInTenantContext(tenantId, async () => {
        const data = await fetchErrorPage(errorCode, true, tenantId, localeCode ?? undefined, { throwOnError: true });
        return data ? slimPageData(data) : null;
      }),
      [`error-${errorCode}`, tenantId ?? '', localeCode ?? ''],
      { tags: [buildAllPagesTag(tenantId)], revalidate: false }
    )();
  } catch (error) {
    console.error(`Failed to fetch error page ${errorCode}:`, error);
    return null;
  }
}

/**
 * Cached metadata-only lookup of a published page (no layer resolution).
 * Shared by the published page route and its layout so both read one entry.
 */
export async function fetchCachedPageForMetadata(
  slugPath: string,
  requestedTenantId?: string
): Promise<PageData | null> {
  const tenantId = requestedTenantId ?? (await getTenantIdFromHeaders()) ?? undefined;
  return unstable_cache(
    async () => runInTenantContext(tenantId, () => fetchPageByPathForMetadata(slugPath, true, undefined, tenantId)),
    [`metadata-/${slugPath}`, tenantId ?? ''],
    { tags: [buildRouteTag(tenantId, slugPath), buildAllPagesTag(tenantId)], revalidate: false }
  )();
}
