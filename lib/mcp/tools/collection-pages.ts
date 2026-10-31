import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { broadcastLayersChanged, broadcastPageCreated } from '@/lib/mcp/broadcast';
import { buildFieldData, inlineVariableTag } from '@/lib/mcp/field-binding-core';
import { getFieldsByCollectionId } from '@/lib/repositories/collectionFieldRepository';
import { getCollectionById } from '@/lib/repositories/collectionRepository';
import { createPageFolder, getAllPageFolders } from '@/lib/repositories/pageFolderRepository';
import { createPage, getAllPages, getPagesByFolder } from '@/lib/repositories/pageRepository';
import { upsertDraftLayers } from '@/lib/repositories/pageLayersRepository';
import type { CollectionField, Page, PageFolder, PageSettings } from '@/types';
import { reportPageEvent } from '@/lib/services/siteEvents';

const slugify = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

const EMPTY_BODY = [{ id: 'body', name: 'body', classes: '', children: [] }];

async function createEmptyPage(data: Parameters<typeof createPage>[0]): Promise<Page> {
  const page = await createPage(data);
  // Brand-new page guarantees no existing draft — assert it to skip the repo's pre-read.
  await upsertDraftLayers(page.id, EMPTY_BODY, undefined, null);
  broadcastPageCreated(page).catch(() => {});
  broadcastLayersChanged(page.id, EMPTY_BODY).catch(() => {});
  void reportPageEvent('created', page);
  return page;
}

async function nextOrder(folderId: string | null, folders: PageFolder[]): Promise<number> {
  const siblings = await getPagesByFolder(folderId);
  const siblingFolders = folders.filter((f) => f.page_folder_id === folderId);
  return Math.max(
    siblings.reduce((max, p) => Math.max(max, p.order ?? 0), -1),
    siblingFolders.reduce((max, f) => Math.max(max, f.order ?? 0), -1),
  ) + 1;
}

function findField(fields: CollectionField[], ref: string | undefined): CollectionField | undefined {
  if (!ref) return undefined;
  const key = ref.trim().toLowerCase();
  return fields.find((f) => f.id === ref)
    ?? fields.find((f) => f.name.toLowerCase() === key)
    ?? fields.find((f) => f.key?.toLowerCase() === key);
}

/** `<ycode-inline-variable>` for a field of the dynamic page's own item (the SEO binding syntax). */
function pageFieldTag(field: CollectionField): string {
  return inlineVariableTag(buildFieldData(field, 'page', undefined, undefined));
}

export function registerCollectionPageTools(server: McpServer) {
  server.tool(
    'create_collection_pages',
    `Scaffold the pages a collection needs in one call: a folder (e.g. /blog), an index page inside
it (/blog — build the list there with a collection layer) and the dynamic detail page
(/blog/<slug>) bound to the collection with its slug field and per-item SEO title/description.
Replaces create_page_folder + create_page ×2 + update_page_settings (cms + seo).

Defaults: folder name/slug from the collection name, slug field = the built-in "slug" field,
SEO title = the "name" field, SEO description = a field named description / excerpt / summary
when one exists. Pass field names, keys or ids to override. Existing folder with the same slug
is reused; an existing dynamic page for the collection is reported instead of duplicated.

Both pages start empty: add layouts / layers to them afterwards (the index page is where the
collection list goes; on the detail page bind fields with source "page").`,
    {
      collection_id: z.string().describe('Collection to create pages for'),
      folder_name: z.string().optional().describe('Folder name. Defaults to the collection name.'),
      folder_slug: z.string().optional().describe('Folder URL slug. Defaults to the slugified folder name.'),
      page_folder_id: z.string().nullable().optional().describe('Parent folder for the new folder, or null for root (default).'),
      create_index_page: z.boolean().optional().default(true).describe('Also create the folder\'s index (listing) page. Default true.'),
      index_page_name: z.string().optional().describe('Name of the listing page. Defaults to the folder name.'),
      detail_page_name: z.string().optional().describe('Name of the dynamic detail page. Defaults to "<Collection> item".'),
      slug_field: z.string().optional().describe('Field (name, key or id) that provides each item\'s URL slug. Defaults to the built-in slug field.'),
      seo_title_field: z.string().optional().describe('Field bound to the detail page\'s SEO title. Defaults to the name field.'),
      seo_title_suffix: z.string().optional().describe('Static text appended to the bound SEO title, e.g. " — Acme".'),
      seo_description_field: z.string().nullable().optional().describe('Field bound to the SEO description. Defaults to description / excerpt / summary when present; pass null for none.'),
    },
    async (args) => {
      const collection = await getCollectionById(args.collection_id);
      if (!collection) return { content: [{ type: 'text' as const, text: `Error: Collection "${args.collection_id}" not found.` }], isError: true };

      const [fields, pages, folders] = await Promise.all([
        getFieldsByCollectionId(collection.id),
        getAllPages({ is_published: false }),
        getAllPageFolders({ is_published: false }),
      ]);

      const existingDetail = pages.find((p) => p.is_dynamic && p.settings?.cms?.collection_id === collection.id);
      if (existingDetail) {
        return {
          content: [{ type: 'text' as const, text: `Error: "${collection.name}" already has a dynamic page "${existingDetail.name}" (${existingDetail.id}). Edit it with update_page / update_page_settings instead.` }],
          isError: true,
        };
      }

      const fieldNames = fields.map((f) => `"${f.name}"`).join(', ');
      const slugField = args.slug_field ? findField(fields, args.slug_field) : fields.find((f) => f.key === 'slug');
      if (!slugField) {
        return { content: [{ type: 'text' as const, text: `Error: slug field "${args.slug_field ?? 'slug'}" not found in "${collection.name}" (fields: ${fieldNames}).` }], isError: true };
      }

      const titleField = args.seo_title_field
        ? findField(fields, args.seo_title_field)
        : fields.find((f) => f.key === 'name') ?? fields.find((f) => f.type === 'text');
      if (args.seo_title_field && !titleField) {
        return { content: [{ type: 'text' as const, text: `Error: SEO title field "${args.seo_title_field}" not found (fields: ${fieldNames}).` }], isError: true };
      }
      let descriptionField: CollectionField | undefined;
      if (args.seo_description_field !== null) {
        descriptionField = findField(fields, args.seo_description_field ?? undefined);
        if (args.seo_description_field && !descriptionField) {
          return { content: [{ type: 'text' as const, text: `Error: SEO description field "${args.seo_description_field}" not found (fields: ${fieldNames}).` }], isError: true };
        }
        if (!descriptionField) {
          descriptionField = fields.find((f) => ['description', 'excerpt', 'summary'].includes(f.name.toLowerCase()) && ['text', 'rich_text'].includes(f.type));
        }
      }

      const parentId = args.page_folder_id ?? null;
      const parentFolder = parentId ? folders.find((f) => f.id === parentId) : null;
      if (parentId && !parentFolder) return { content: [{ type: 'text' as const, text: `Error: Parent folder "${parentId}" not found.` }], isError: true };

      const folderName = args.folder_name?.trim() || collection.name;
      const folderSlug = args.folder_slug?.trim() || slugify(folderName);
      let folder = folders.find((f) => f.page_folder_id === parentId && f.slug === folderSlug);
      let folderCreated = false;
      if (!folder) {
        folder = await createPageFolder({
          name: folderName,
          slug: folderSlug,
          page_folder_id: parentId,
          depth: parentFolder ? parentFolder.depth + 1 : 0,
          order: await nextOrder(parentId, folders),
          is_published: false,
        });
        folderCreated = true;
      }
      const depth = folder.depth + 1;

      let indexPage: Page | null = null;
      let indexCreated = false;
      if (args.create_index_page) {
        indexPage = pages.find((p) => p.is_index && p.page_folder_id === folder!.id) ?? null;
        if (!indexPage) {
          indexPage = await createEmptyPage({
            name: args.index_page_name?.trim() || folderName,
            slug: '',
            is_published: false,
            page_folder_id: folder.id,
            order: await nextOrder(folder.id, folders),
            depth,
            is_index: true,
            is_dynamic: false,
            error_page: null,
            settings: {},
          });
          indexCreated = true;
        }
      }

      const seo: NonNullable<PageSettings['seo']> = {
        title: titleField ? `${pageFieldTag(titleField)}${args.seo_title_suffix ?? ''}` : '',
        description: descriptionField ? pageFieldTag(descriptionField) : '',
        noindex: false,
        image: null,
      };
      const detailPage = await createEmptyPage({
        name: args.detail_page_name?.trim() || `${collection.name} item`,
        slug: '*',
        is_published: false,
        page_folder_id: folder.id,
        order: await nextOrder(folder.id, folders),
        depth,
        is_index: false,
        is_dynamic: true,
        error_page: null,
        settings: { cms: { collection_id: collection.id, slug_field_id: slugField.id }, seo },
      });

      const basePath = `/${[...folderPath(folder, folders), folderSlug].filter(Boolean).join('/')}`;
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            message: `Created ${[folderCreated && 'folder', indexCreated && 'index page', 'dynamic page'].filter(Boolean).join(', ')} for "${collection.name}"`,
            folder: { id: folder.id, name: folder.name, slug: folder.slug, path: basePath, created: folderCreated },
            index_page: indexPage ? { id: indexPage.id, name: indexPage.name, path: basePath, created: indexCreated } : null,
            detail_page: {
              id: detailPage.id,
              name: detailPage.name,
              path: `${basePath}/<${slugField.name}>`,
              slug_field: { id: slugField.id, name: slugField.name },
              seo_title_field: titleField ? { id: titleField.id, name: titleField.name } : null,
              seo_description_field: descriptionField ? { id: descriptionField.id, name: descriptionField.name } : null,
            },
            next_steps: [
              indexPage ? `Build the listing on index_page ${indexPage.id}: a collection layer bound to "${collection.name}" (bind_collection_layer or import_html with data-ycode-collection).` : null,
              `Build the detail layout on detail_page ${detailPage.id}: bind fields with bind_layer_field source "page" (or import_html data-ycode-field).`,
              'Link list cards to the detail page with update_layer_link (link_type "page", collection_item_id "current-collection") or data-ycode-link="item".',
            ].filter(Boolean),
          }),
        }],
      };
    },
  );
}

/** Slugs of the folder's ancestors, root first. */
function folderPath(folder: PageFolder, folders: PageFolder[]): string[] {
  const parts: string[] = [];
  let current = folder.page_folder_id ? folders.find((f) => f.id === folder.page_folder_id) : undefined;
  while (current) {
    parts.unshift(current.slug);
    current = current.page_folder_id ? folders.find((f) => f.id === current!.page_folder_id) : undefined;
  }
  return parts;
}
