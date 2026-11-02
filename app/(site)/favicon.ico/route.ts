/**
 * /favicon.ico
 *
 * Browsers and crawlers ask for it even when pages link their icon, and
 * expect an ICO file: it is built from the site's favicon (any format), or
 * from the platform's icon when the site has none.
 */

import { readFile } from 'fs/promises';
import { join } from 'path';

import { buildFaviconIco } from '@/lib/favicon-ico';
import { getAssetById } from '@/lib/repositories/assetRepository';
import { getSettingByKey } from '@/lib/repositories/settingsRepository';
import { getSupabaseStorage } from '@/lib/supabase-storage';
import { STORAGE_BUCKET } from '@/lib/asset-constants';
import { fetchStoredFile } from '@/lib/storage/filesystem-storage';

export const dynamic = 'force-dynamic';

/** The site's published favicon image, if it has one */
async function loadSiteFavicon(): Promise<Buffer | null> {
  const assetId = await getSettingByKey('favicon_asset_id').catch(() => null);
  if (typeof assetId !== 'string' || !assetId) return null;
  const asset = await getAssetById(assetId, true).catch(() => null);
  if (!asset) return null;

  if (!asset.storage_path) {
    return asset.mime_type === 'image/svg+xml' && asset.content ? Buffer.from(asset.content) : null;
  }
  const { data } = (await getSupabaseStorage()).from(STORAGE_BUCKET).getPublicUrl(asset.storage_path);
  const response = await fetchStoredFile(data.publicUrl);
  return response.ok ? Buffer.from(await response.arrayBuffer()) : null;
}

export async function GET() {
  try {
    const source = await loadSiteFavicon() ?? await readFile(join(process.cwd(), 'app', 'icon.svg'));
    const ico = await buildFaviconIco(source);
    return new Response(new Uint8Array(ico), {
      headers: {
        'Content-Type': 'image/x-icon',
        'Content-Length': String(ico.length),
        'Cache-Control': 'public, max-age=86400',
      },
    });
  } catch (error) {
    console.error('[favicon.ico] Could not build the icon:', error);
    return new Response('Not found', { status: 404 });
  }
}
