import { NextRequest, NextResponse } from 'next/server';
import { fetchErrorPage } from '@/lib/page-fetcher';
import { parsePathnameForPageHead } from '@/lib/page-head-path';
import { getSettingsByKeys } from '@/lib/repositories/settingsRepository';
import { generateColorVariablesCss } from '@/lib/repositories/colorVariableRepository';
import { resolvePathLocaleCode } from '@/lib/resolve-html-lang';
import { getTenantIdFromHeaders } from '@/lib/supabase-server';
import { shouldShowSiteBadge } from '@/lib/site-badge';
import { getSiteGenerator } from '@/lib/ycode-html-comment';

// Force dynamic rendering - no caching
export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * GET /ycode/api/error-page
 * 
 * Fetch error page data by error code
 * Query params: code (404, 401, 500), published (true/false), path (optional URL pathname for locale)
 */
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const code = searchParams.get('code');
    const published = searchParams.get('published') === 'true';

    if (!code) {
      return NextResponse.json(
        { error: 'Error code is required' },
        { status: 400 }
      );
    }

    const errorCode = parseInt(code, 10);
    if (![401, 404, 500].includes(errorCode)) {
      return NextResponse.json(
        { error: 'Invalid error code. Must be 401, 404, or 500' },
        { status: 400 }
      );
    }

    // Translate into the locale of the URL the error occurred on
    const path = searchParams.get('path');
    const tenantId = (await getTenantIdFromHeaders()) ?? undefined;
    const localeCode = path
      ? await resolvePathLocaleCode(parsePathnameForPageHead(path).slugPath, published, tenantId)
      : null;

    const pageData = await fetchErrorPage(errorCode, published, tenantId, localeCode ?? undefined);

    if (!pageData) {
      return NextResponse.json(
        { error: 'Error page not found' },
        { status: 404 }
      );
    }

    const cssKey = published ? 'published_css' : 'draft_css';
    const [settings, colorVariablesCss] = await Promise.all([
      getSettingsByKeys([cssKey, 'ycode_badge']),
      generateColorVariablesCss(),
    ]);

    return NextResponse.json({
      pageData,
      css: settings[cssKey] || null,
      colorVariablesCss,
      ycodeBadge: await shouldShowSiteBadge(settings.ycode_badge),
      generator: getSiteGenerator(),
    });
  } catch (error) {
    console.error('Failed to fetch error page:', error);
    return NextResponse.json(
      { error: 'Failed to fetch error page' },
      { status: 500 }
    );
  }
}
