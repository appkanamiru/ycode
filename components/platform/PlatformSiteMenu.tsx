'use client';

/**
 * Site switcher for the editor's user menu (multi-tenant platform only;
 * renders nothing otherwise).
 */

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';

import {
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from '@/components/ui/dropdown-menu';
import { fetchPlatformSites, openPlatformSite, type PlatformSites } from '@/lib/platform/browser-sites';

export default function PlatformSiteMenu() {
  const router = useRouter();
  const [data, setData] = useState<PlatformSites | null>(null);

  useEffect(() => {
    fetchPlatformSites().then(setData).catch(() => setData(null));
  }, []);

  if (!data) return null;
  const active = data.sites.find((site) => site.active);

  return (
    <>
      <DropdownMenuSub>
        <DropdownMenuSubTrigger>
          {active ? active.name : 'Sites'}
        </DropdownMenuSubTrigger>
        <DropdownMenuSubContent>
          <DropdownMenuRadioGroup
            value={active?.slug}
            onValueChange={(slug) => {
              if (slug !== active?.slug) openPlatformSite(slug);
            }}
          >
            {data.sites.map((site) => (
              <DropdownMenuRadioItem key={site.id} value={site.slug}>
                {site.name}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => router.push('/ycode/sites')}>
            All sites…
          </DropdownMenuItem>
        </DropdownMenuSubContent>
      </DropdownMenuSub>
      <DropdownMenuSeparator />
    </>
  );
}
