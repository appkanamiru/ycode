import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { headers } from 'next/headers';
import SiteDocumentLayout, { generateSiteMetadata } from '@/components/site-document-layout';
import { fetchGlobalPageSettings } from '@/lib/generate-page-metadata';
import { withCustom404Metadata } from '@/lib/not-found-metadata';
import { parsePathnameForPageHead } from '@/lib/page-head-path';
import { resolveHtmlLang } from '@/lib/resolve-html-lang';
import { getTenantIdFromHeaders } from '@/lib/supabase-server';
import { getSiteBaseUrl } from '@/lib/url-utils';

export async function generateMetadata(): Promise<Metadata> {
  const [siteMetadata, headersList, resolvedTenantId] = await Promise.all([
    generateSiteMetadata(),
    headers(),
    getTenantIdFromHeaders(),
  ]);
  const { isPreview, slugPath } = parsePathnameForPageHead(headersList.get('x-pathname') || '/');

  // Preview URLs resolve against draft pages, so a missing published page there
  // isn't a 404.
  if (isPreview) {
    return siteMetadata;
  }

  return withCustom404Metadata(slugPath, siteMetadata, { tenantId: resolvedTenantId ?? undefined });
}

/**
 * Root layout for preview, pagination rewrites, and other non-published-page
 * public routes. Published pages use `(published)/[[...slug]]` so they can
 * set `<html lang>` from static params without calling headers().
 */
export default async function SiteLayout({
  children,
}: Readonly<{
  children: ReactNode;
}>) {
  const [headersList, tenantId] = await Promise.all([headers(), getTenantIdFromHeaders()]);
  const pathname = headersList.get('x-pathname') || '/';
  const { isPreview, slugPath } = parsePathnameForPageHead(pathname);

  const [lang, globalSettings] = await Promise.all([
    // The site's locales (multi-tenant: the cached lookup cannot read the request's tenant itself)
    resolveHtmlLang(slugPath, !isPreview, tenantId ?? undefined),
    fetchGlobalPageSettings(isPreview).catch(() => null),
  ]);

  const baseUrl = getSiteBaseUrl({
    globalCanonicalUrl: globalSettings?.globalCanonicalUrl ?? null,
  });

  return (
    <SiteDocumentLayout
      lang={lang}
      pathname={pathname}
      baseUrl={baseUrl}
      publishedAt={globalSettings?.publishedAt ?? null}
      globalCustomCodeHead={globalSettings?.globalCustomCodeHead ?? null}
    >
      {children}
    </SiteDocumentLayout>
  );
}
