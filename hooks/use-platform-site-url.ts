'use client';

/**
 * Public address of the active site on the multi-tenant platform: its
 * verified custom domain if it has one, else its free subdomain. Null when
 * not multi-tenant, where sites are served from the editor's own host.
 */

import { useEffect, useState } from 'react';

import { fetchPlatformSites } from '@/lib/platform/browser-sites';

export function usePlatformSiteUrl(): string | null {
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchPlatformSites()
      .then((data) => {
        const site = data?.sites.find((candidate) => candidate.active);
        if (cancelled || !site) return;
        setUrl(site.domains[0] ? `https://${site.domains[0]}` : site.url);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  return url;
}
