'use client';

/**
 * Multi-tenant platform: make sure the editor has an active site before it
 * loads any data.
 * - `?site=<slug>` (from a site's own /ycode link) switches to that site
 * - without an active site, the user is sent to the site list
 */

import { useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';

import { activatePlatformSite } from '@/lib/platform/browser-sites';

/** true once the editor may load */
export function usePlatformSiteGate(enabled: boolean, signedIn: boolean): boolean {
  const router = useRouter();
  const searchParams = useSearchParams();
  const requestedSite = searchParams.get('site');
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!enabled || !signedIn) return;
    let cancelled = false;

    (async () => {
      if (requestedSite) {
        const switched = await activatePlatformSite(requestedSite);
        // Full reload: anything loaded so far belongs to the previous site
        window.location.replace(switched ? '/ycode' : '/ycode/sites');
        return;
      }

      const response = await fetch('/ycode/api/platform/me', { cache: 'no-store' });
      const tenantId = response.ok ? (await response.json()).data?.tenantId : null;
      if (cancelled) return;
      if (tenantId) {
        setReady(true);
      } else {
        router.replace('/ycode/sites');
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [enabled, signedIn, requestedSite, router]);

  return !enabled || ready;
}
