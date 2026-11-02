import { unstable_noStore } from 'next/cache';
import type { Metadata } from 'next';
import { fetchHomepage, fetchErrorPage } from '@/lib/page-fetcher';
import PageRenderer from '@/components/PageRenderer';
import SiteWelcome, { generateSiteWelcomeMetadata } from '@/components/SiteWelcome';
import PaginationSeoLinks from '@/components/PaginationSeoLinks';
import PasswordForm from '@/components/PasswordForm';
import { fetchGlobalPageSettings, generateErrorPageMetadata, generatePageMetadata } from '@/lib/generate-page-metadata';
import { fetchCachedErrorPage } from '@/lib/published-page-cache';
import { parseAuthCookie, getPasswordProtection, fetchFoldersForAuth } from '@/lib/page-auth';
import { getPaginationContext, toQueryString } from '@/lib/pagination-context';
import { buildCanonicalPaginationQueryString } from '@/lib/pagination-url-utils';
import { getSettingByKey } from '@/lib/repositories/settingsRepository';
import { generateColorVariablesCss } from '@/lib/repositories/colorVariableRepository';
import { getTenantIdFromHeaders } from '@/lib/supabase-server';
import { getSiteBaseUrl } from '@/lib/url-utils';

// Internal pagination path: always dynamic/no-store.
export const dynamic = 'force-dynamic';
export const revalidate = 0;

interface DynamicHomeProps {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}

export default async function DynamicHome({ searchParams }: DynamicHomeProps) {
  const resolvedSearchParams = await searchParams;

  unstable_noStore();

  const queryString = toQueryString(resolvedSearchParams);
  const paginationContext = getPaginationContext('/', queryString);

  const data = await fetchHomepage(true, paginationContext);

  if (!data || !data.pageLayers) {
    return <SiteWelcome />;
  }

  const folders = await fetchFoldersForAuth(true);
  const protectionCheck = getPasswordProtection(data.page, folders, null);

  if (protectionCheck.isProtected) {
    const authCookie = await parseAuthCookie();
    const protection = getPasswordProtection(data.page, folders, authCookie);

    if (!protection.isUnlocked) {
      const errorPageData = await fetchErrorPage(401, true);
      const [publishedCSS, colorVariablesCss] = await Promise.all([
        getSettingByKey('published_css'),
        generateColorVariablesCss(),
      ]);

      if (errorPageData) {
        const { page: errorPage, pageLayers: errorPageLayers, components: errorComponents } = errorPageData;

        return (
          <PageRenderer
            page={errorPage}
            layers={errorPageLayers.layers || []}
            components={errorComponents}
            generatedCss={publishedCSS}
            colorVariablesCss={colorVariablesCss || undefined}
            availableLocales={errorPageData.availableLocales}
            passwordProtection={{
              pageId: protection.protectedBy === 'page' ? protection.protectedById : undefined,
              folderId: protection.protectedBy === 'folder' ? protection.protectedById : undefined,
              redirectUrl: '/',
              isPublished: true,
            }}
            localeSwitchTarget={{ page: data.page }}
          />
        );
      }

      return (
        <div className="min-h-screen flex items-center justify-center bg-white">
          <div className="text-center max-w-md px-4">
            <h1 className="text-6xl font-bold text-gray-900 mb-4">401</h1>
            <h2 className="text-2xl font-semibold text-gray-800 mb-4">Password Protected</h2>
            <p className="text-gray-600 mb-8">Enter the password to continue.</p>
            <PasswordForm
              pageId={protection.protectedBy === 'page' ? protection.protectedById : undefined}
              folderId={protection.protectedBy === 'folder' ? protection.protectedById : undefined}
              redirectUrl="/"
              isPublished={true}
            />
          </div>
        </div>
      );
    }
  }

  const globalSettings = await fetchGlobalPageSettings();

  return (
    <>
      <PaginationSeoLinks
        layers={data.pageLayers.layers || []}
        basePath="/"
        queryString={queryString}
        baseUrl={getSiteBaseUrl({ globalCanonicalUrl: globalSettings.globalCanonicalUrl })}
      />
      <PageRenderer
        page={data.page}
        layers={data.pageLayers.layers || []}
        components={[]}
        generatedCss={globalSettings.publishedCss || undefined}
        colorVariablesCss={globalSettings.colorVariablesCss || undefined}
        locale={data.locale}
        availableLocales={data.availableLocales}
        translations={data.translations}
        gaMeasurementId={globalSettings.gaMeasurementId}
        globalCustomCodeHead={globalSettings.globalCustomCodeHead}
        globalCustomCodeBody={globalSettings.globalCustomCodeBody}
        ycodeBadge={globalSettings.ycodeBadge}
      />
    </>
  );
}

/**
 * Paginated homepages are served from this route, so they need the same
 * metadata as the statically rendered first page — without it pages 2+ fall
 * back to the layout's generic title and carry no canonical. The canonical
 * keeps the `p_*` params so each page self-canonicalizes.
 */
export async function generateMetadata({ searchParams }: DynamicHomeProps): Promise<Metadata> {
  const resolvedSearchParams = await searchParams;
  const queryString = toQueryString(resolvedSearchParams);
  const paginationContext = getPaginationContext('/', queryString);

  const [data, globalSettings, resolvedTenantId] = await Promise.all([
    fetchHomepage(true, paginationContext),
    fetchGlobalPageSettings(),
    getTenantIdFromHeaders(),
  ]);
  const tenantId = resolvedTenantId ?? undefined;

  if (!data) {
    return generateSiteWelcomeMetadata();
  }

  // Don't leak metadata for protected pages — the page component gates access.
  const folders = await fetchFoldersForAuth(true);
  if (getPasswordProtection(data.page, folders, null).isProtected) {
    const errorPageData = await fetchCachedErrorPage(401, tenantId);
    return generateErrorPageMetadata(401, errorPageData?.page ?? null, {
      globalSeoSettings: globalSettings,
      tenantId,
    });
  }

  const metadata = await generatePageMetadata(data.page, {
    fallbackTitle: 'Home',
    pagePath: '/',
    pageQuery: buildCanonicalPaginationQueryString(data.pageLayers?.layers || [], queryString),
    globalSeoSettings: globalSettings,
    translations: data.translations,
  });

  const baseUrl = getSiteBaseUrl({ globalCanonicalUrl: globalSettings.globalCanonicalUrl });
  if (baseUrl) {
    try { metadata.metadataBase = new URL(baseUrl); } catch { /* invalid URL */ }
  }

  return metadata;
}
