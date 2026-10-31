/**
 * Site Events
 *
 * Helpers the editor API, the public API and MCP call after changing content,
 * so webhooks and apps (Discord) learn about it the same way from every path.
 * Each one skips its work when nothing follows the event and never throws:
 * a notification must not fail the change it reports. Bulk paths (imports,
 * syncs, publishing copies) do not report per item.
 */

import { getCollectionById } from '@/lib/repositories/collectionRepository';
import { getFieldsByCollectionId } from '@/lib/repositories/collectionFieldRepository';
import { getItemById, getItemWithValues } from '@/lib/repositories/collectionItemRepository';
import { getPageById } from '@/lib/repositories/pageRepository';
import type { WebhookEventType } from '@/lib/repositories/webhookRepository';
import {
  dispatchAssetDeletedEvent,
  dispatchAssetUploadedEvent,
  dispatchCollectionItemCreatedEvent,
  dispatchCollectionItemDeletedEvent,
  dispatchCollectionItemUpdatedEvent,
  dispatchPageCreatedEvent,
  dispatchPageDeletedEvent,
  dispatchPagePublishedEvent,
  dispatchPageUpdatedEvent,
  dispatchSitePublishedEvent,
  hasEventSubscribers,
} from '@/lib/services/webhookService';

/** Built-in fields that say nothing about an item's content */
const HIDDEN_FIELD_KEYS = new Set(['id', 'status', 'created_at', 'updated_at']);

function report(label: string, task: () => Promise<void>): Promise<void> {
  return task().catch((error) => {
    console.error(`[events] Could not report ${label}:`, error);
  });
}

/** A CMS item as events describe it: field values by field name */
export interface CollectionItemNotice {
  collection_id: string;
  collection_name?: string;
  item_id: string;
  item_name?: string;
  values: Record<string, unknown>;
}

async function describeCollectionItem(collectionId: string, itemId: string): Promise<CollectionItemNotice> {
  const [collection, fields, item] = await Promise.all([
    getCollectionById(collectionId),
    getFieldsByCollectionId(collectionId),
    getItemWithValues(itemId),
  ]);
  const values: Record<string, unknown> = {};
  let itemName: string | undefined;
  for (const field of fields) {
    const value = item?.values?.[field.id];
    if (field.key === 'name' && value !== undefined && value !== null) itemName = String(value);
    if (field.key && HIDDEN_FIELD_KEYS.has(field.key)) continue;
    if (value !== undefined && value !== null && value !== '') values[field.name] = value;
  }
  return {
    collection_id: collectionId,
    collection_name: collection?.name,
    item_id: itemId,
    item_name: itemName,
    values,
  };
}

/** Report a CMS item that was created or edited (from its draft values) */
export function reportCollectionItemChanged(
  change: 'created' | 'updated',
  collectionId: string,
  itemId: string,
): Promise<void> {
  const type: WebhookEventType = change === 'created' ? 'collection_item.created' : 'collection_item.updated';
  return report(type, async () => {
    if (!(await hasEventSubscribers(type))) return;
    const notice = await describeCollectionItem(collectionId, itemId);
    await (change === 'created' ? dispatchCollectionItemCreatedEvent(notice) : dispatchCollectionItemUpdatedEvent(notice));
  });
}

/**
 * Describe CMS items before they are deleted (afterwards their values are
 * gone); null when nothing follows deletions
 */
export async function prepareCollectionItemsDeleted(itemIds: string[]): Promise<CollectionItemNotice[] | null> {
  try {
    if (!(await hasEventSubscribers('collection_item.deleted'))) return null;
    const items = await Promise.all(itemIds.map((itemId) => getItemById(itemId)));
    return await Promise.all(items
      .filter((item): item is NonNullable<typeof item> => Boolean(item))
      .map((item) => describeCollectionItem(item.collection_id, item.id)));
  } catch (error) {
    console.error('[events] Could not describe deleted items:', error);
    return null;
  }
}

/** Report CMS items described by prepareCollectionItemsDeleted */
export function reportCollectionItemsDeleted(notices: CollectionItemNotice[] | null): Promise<void> {
  if (!notices?.length) return Promise.resolve();
  return report('collection_item.deleted', async () => {
    await Promise.all(notices.map(({ values: _values, ...notice }) => dispatchCollectionItemDeletedEvent(notice)));
  });
}

export interface PageNotice {
  id: string;
  name?: string | null;
  slug?: string | null;
}

/** Report a page that was created, had its settings changed, was deleted or published */
export function reportPageEvent(
  change: 'created' | 'updated' | 'deleted' | 'published',
  page: PageNotice,
): Promise<void> {
  const data = { page_id: page.id, page_name: page.name ?? undefined, page_slug: page.slug ?? undefined };
  const dispatch = {
    created: dispatchPageCreatedEvent,
    updated: dispatchPageUpdatedEvent,
    deleted: dispatchPageDeletedEvent,
    published: dispatchPagePublishedEvent,
  }[change];
  return report(`page.${change}`, () => dispatch(data));
}

export interface AssetNotice {
  id: string;
  filename: string;
  mime_type?: string | null;
  file_size?: number | null;
}

/** Report a file that was uploaded or deleted */
export function reportAssetEvent(change: 'uploaded' | 'deleted', asset: AssetNotice): Promise<void> {
  return report(`asset.${change}`, async () => {
    if (change === 'uploaded') {
      await dispatchAssetUploadedEvent({
        asset_id: asset.id,
        filename: asset.filename,
        mime_type: asset.mime_type ?? '',
        file_size: asset.file_size ?? 0,
      });
    } else {
      await dispatchAssetDeletedEvent({
        asset_id: asset.id,
        filename: asset.filename,
        mime_type: asset.mime_type ?? undefined,
        file_size: asset.file_size ?? undefined,
      });
    }
  });
}

/** Report a publish: the site, and each page whose changes it published */
export function reportSitePublished(
  counts: { pages: number; collectionItems: number },
  publishedPageIds: string[] = [],
): Promise<void> {
  return report('site.published', async () => {
    const pages = publishedPageIds.length > 0 && await hasEventSubscribers('page.published')
      ? (await Promise.all(publishedPageIds.map((id) => getPageById(id, true)))).filter((page) => page !== null)
      : [];
    await Promise.all([
      dispatchSitePublishedEvent({ pages_count: counts.pages, collections_count: counts.collectionItems }),
      ...pages.map((page) => reportPageEvent('published', page)),
    ]);
  });
}
