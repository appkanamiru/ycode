/**
 * Shown on a site's homepage until it has a published one: names the site
 * (its site_name setting, else the builder) and links to the editor.
 */

import Link from 'next/link';
import type { Metadata } from 'next';

import { getSettingByKey } from '@/lib/repositories/settingsRepository';
import { getSiteGenerator } from '@/lib/ycode-html-comment';

async function getWelcomeName(): Promise<string> {
  const siteName = await getSettingByKey('site_name').catch(() => null);
  return (typeof siteName === 'string' && siteName.trim()) || getSiteGenerator().name;
}

export async function generateSiteWelcomeMetadata(): Promise<Metadata> {
  return { title: await getWelcomeName() };
}

export default async function SiteWelcome() {
  const name = await getWelcomeName();

  return (
    <div className="min-h-screen flex items-center justify-center bg-white">
      <div className="text-center p-8 flex flex-col items-center justify-center gap-2">
        <h1 className="text-xl font-semibold text-neutral-900">
          {name}
        </h1>
        <Link
          href="/ycode"
          className=" bg-blue-500 text-white text-sm font-medium h-8 flex items-center justify-center px-3 rounded-lg transition-colors"
        >
          Get started
        </Link>
      </div>
    </div>
  );
}
