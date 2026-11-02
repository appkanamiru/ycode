import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { uploadFile } from '@/lib/file-upload';
import { getAllAssets, getAssetById, updateAsset, deleteAsset } from '@/lib/repositories/assetRepository';
import { reportAssetEvent } from '@/lib/services/siteEvents';

export function registerAssetTools(server: McpServer) {
  server.tool(
    'list_assets',
    'List all assets in the library with their IDs, filenames, URLs, and dimensions',
    {},
    async () => {
      const assets = await getAllAssets();
      const summary = assets.map((a) => ({
        id: a.id,
        filename: a.filename,
        public_url: a.public_url,
        mime_type: a.mime_type,
        width: a.width,
        height: a.height,
      }));
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(summary) }],
      };
    },
  );

  server.tool(
    'upload_asset',
    `Upload an image to the Ycode asset library (Ycode Assets, see https://docs.ycode.com). Accepts either a public image URL or base64-encoded image data.

The url is not an API endpoint: the image file at that address is downloaded with a single HTTP GET and stored in the asset library. No other API is called.

Use url for images already on the internet.
Use base64_data for images generated locally (e.g. AI-generated images in a sandbox).

SVGs are stored inline as markup, so the response has public_url: null and stored_inline: true.
That is a successful upload — use the returned asset_id like any other image (get_asset returns
the markup in "content").`,
    {
      url: z.string().url().optional().describe('Direct public URL of an image file (e.g. https://example.com/photo.jpg), downloaded via HTTP GET'),
      base64_data: z.string().optional()
        .describe('Base64-encoded image data (without the data:... prefix). Use when the image is not publicly accessible.'),
      filename: z.string().optional().describe('Custom filename. Auto-detected from URL if omitted.'),
      mime_type: z.string().optional().describe('MIME type (e.g. "image/png", "image/jpeg"). Required for base64, auto-detected for URLs.'),
    },
    async ({ url, base64_data, filename, mime_type }) => {
      try {
        if (!url && !base64_data) {
          return {
            content: [{ type: 'text' as const, text: 'Error: Provide either url or base64_data' }],
            isError: true,
          };
        }

        let file: File;

        if (base64_data) {
          const cleanData = base64_data.replace(/^data:[^;]+;base64,/, '');
          const buffer = Buffer.from(cleanData, 'base64');
          const contentType = mime_type || 'image/png';
          const derivedFilename = filename || `image-${Date.now()}.${extensionFromMime(contentType)}`;
          const blob = new Blob([buffer], { type: contentType });
          file = new File([blob], derivedFilename, { type: contentType });
        } else {
          const res = await fetch(url!);
          if (!res.ok) {
            return {
              content: [{ type: 'text' as const, text: `Error: Failed to download image from ${url}: ${res.status}` }],
              isError: true,
            };
          }

          const contentType = mime_type || res.headers.get('content-type') || 'image/png';
          const buffer = await res.arrayBuffer();
          const blob = new Blob([buffer], { type: contentType });
          const derivedFilename = filename || url!.split('/').pop()?.split('?')[0] || 'image.png';
          file = new File([blob], derivedFilename, { type: contentType });
        }

        const asset = await uploadFile(file, 'mcp');
        if (!asset) {
          return { content: [{ type: 'text' as const, text: 'Error: Failed to upload asset' }], isError: true };
        }
        void reportAssetEvent('uploaded', asset);

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              message: `Uploaded "${asset.filename}" successfully`,
              asset_id: asset.id,
              public_url: asset.public_url,
              width: asset.width,
              height: asset.height,
              ...(!asset.public_url && asset.content ? { stored_inline: true } : {}),
            }),
          }],
        };
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: `Error uploading image: ${err instanceof Error ? err.message : 'Unknown error'}` }],
          isError: true,
        };
      }
    },
  );
  server.tool(
    'get_asset',
    'Get details of a single asset by ID',
    { asset_id: z.string().describe('The asset ID') },
    async ({ asset_id }) => {
      const asset = await getAssetById(asset_id);
      if (!asset) {
        return { content: [{ type: 'text' as const, text: `Error: Asset "${asset_id}" not found.` }], isError: true };
      }
      return { content: [{ type: 'text' as const, text: JSON.stringify(asset) }] };
    },
  );

  server.tool(
    'update_asset',
    'Update an asset (rename or move to a folder)',
    {
      asset_id: z.string().describe('The asset ID'),
      filename: z.string().optional().describe('New filename'),
      folder_id: z.string().nullable().optional().describe('Move to folder ID, or null for root'),
    },
    async ({ asset_id, filename, folder_id }) => {
      const updates: Record<string, unknown> = {};
      if (filename !== undefined) updates.filename = filename;
      if (folder_id !== undefined) updates.asset_folder_id = folder_id;

      const asset = await updateAsset(asset_id, updates);
      return { content: [{ type: 'text' as const, text: JSON.stringify({ message: `Updated asset "${asset.filename}"`, asset }) }] };
    },
  );

  server.tool(
    'delete_asset',
    'Delete an asset from the library',
    { asset_id: z.string().describe('The asset ID to delete') },
    async ({ asset_id }) => {
      const deleted = await getAssetById(asset_id).catch(() => null);
      await deleteAsset(asset_id);
      if (deleted) void reportAssetEvent('deleted', deleted);
      return { content: [{ type: 'text' as const, text: `Deleted asset ${asset_id}` }] };
    },
  );
}

function extensionFromMime(mime: string): string {
  const map: Record<string, string> = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'image/svg+xml': 'svg',
    'image/avif': 'avif',
    'image/bmp': 'bmp',
    'image/tiff': 'tiff',
  };
  return map[mime] || 'png';
}
