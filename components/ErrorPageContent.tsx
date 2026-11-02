'use client';

import { useEffect, useState } from 'react';
import ErrorFallback from '@/components/ErrorFallback';
import LayerRendererPublic from '@/components/LayerRendererPublic';
import YcodeBadge from '@/components/YcodeBadge';
import type { SiteGenerator } from '@/lib/site-generator';
import type { PageData } from '@/lib/page-fetcher';

interface ErrorPageContentProps {
  /** True for the published error boundary, false for the preview one. */
  published: boolean;
  /** Reset callback from the Next.js error boundary. */
  reset: () => void;
}

/**
 * Shared custom-500 renderer for the published and preview error boundaries.
 * Isolated in its own module so the heavy LayerRendererPublic graph is loaded
 * lazily (via a runtime import() from DeferredErrorPage) only when an error
 * renders — never shipped in every route's error-boundary chunk.
 */
export default function ErrorPageContent({ published, reset }: ErrorPageContentProps) {
  const [errorPageData, setErrorPageData] = useState<PageData | null>(null);
  const [generatedCss, setGeneratedCss] = useState<string>('');
  const [colorVariablesCss, setColorVariablesCss] = useState<string>('');
  const [showBadge, setShowBadge] = useState(false);
  const [generator, setGenerator] = useState<SiteGenerator | undefined>();
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    async function fetchErrorPage() {
      try {
        const params = new URLSearchParams({
          code: '500',
          published: String(published),
          path: window.location.pathname,
        });
        const response = await fetch(`/ycode/api/error-page?${params}`);
        if (response.ok) {
          const data = await response.json();
          setErrorPageData(data.pageData);
          setGeneratedCss(data.css || '');
          setColorVariablesCss(data.colorVariablesCss || '');
          if (published) {
            setShowBadge(data.ycodeBadge ?? true);
            setGenerator(data.generator ?? undefined);
          }
        }
      } catch (err) {
        console.error('Failed to fetch custom 500 page:', err);
      } finally {
        setIsLoading(false);
      }
    }

    fetchErrorPage();
  }, [published]);

  if (isLoading) return <ErrorFallback published={published} reset={reset} />;

  if (errorPageData) {
    const customCodeHead = errorPageData.page.settings?.custom_code?.head || '';
    const customCodeBody = errorPageData.page.settings?.custom_code?.body || '';

    return (
      <>
        {generatedCss && (
          <style
            id="ycode-styles"
            dangerouslySetInnerHTML={{ __html: generatedCss }}
          />
        )}
        {colorVariablesCss && (
          <style
            id="ycode-color-vars"
            dangerouslySetInnerHTML={{ __html: colorVariablesCss }}
          />
        )}
        {customCodeHead && (
          <div dangerouslySetInnerHTML={{ __html: customCodeHead }} />
        )}
        <div className="min-h-screen bg-white">
          <LayerRendererPublic
            layers={errorPageData.pageLayers.layers || []}
            isPublished={published}
            pageCollectionItemId={errorPageData.collectionItem?.id}
            pageCollectionItemData={errorPageData.collectionItem?.values || undefined}
            currentLocale={errorPageData.locale}
            availableLocales={errorPageData.availableLocales}
            translations={errorPageData.translations}
          />
        </div>
        {customCodeBody && (
          <div dangerouslySetInnerHTML={{ __html: customCodeBody }} />
        )}
        {showBadge && <YcodeBadge generator={generator} />}
      </>
    );
  }

  return <ErrorFallback published={published} reset={reset} />;
}
