/**
 * Shared CMS field-binding logic for the single `bind_layer_field` tool and the
 * `bind_field` batch operation: resolves which collection a layer binds to and
 * produces the layer variables that render the field.
 */

import type { CollectionField, Layer } from '@/types';
import { getFieldsByCollectionId } from '@/lib/repositories/collectionFieldRepository';
import { getPageById } from '@/lib/repositories/pageRepository';
import { getDefaultLocale } from '@/lib/repositories/localeRepository';
import { applyFieldBinding, buildFieldData, getFieldFormatError } from '@/lib/mcp/field-binding-core';
import type { BindingSource, BindingTarget } from '@/lib/mcp/field-binding-core';
import { findParentCollectionLayer } from '@/lib/layer-utils';

export * from '@/lib/mcp/field-binding-core';

/**
 * Resolve the collection a binding should pull from: the nearest ancestor
 * Collection List (source "collection") or the dynamic page's own collection
 * (source "page"). Returns the collection id plus, for the collection source,
 * the ancestor list layer id stamped onto the FieldVariable.
 */
export async function resolveBindingContext(
  layers: Layer[],
  layerId: string,
  pageId: string,
  source: BindingSource,
): Promise<{ collectionId: string; collectionLayerId?: string } | { error: string }> {
  if (source === 'collection') {
    const parent = findParentCollectionLayer(layers, layerId);
    if (!parent) {
      return { error: 'Layer is not inside a Collection List. Place it inside a bound "collection" element, or use source "page".' };
    }
    const collectionId = parent.variables?.collection?.id;
    if (!collectionId) {
      return { error: 'The ancestor Collection List is not bound yet. Call bind_collection_layer first.' };
    }
    return { collectionId, collectionLayerId: parent.id };
  }

  const page = await getPageById(pageId);
  const collectionId = page?.settings?.cms?.collection_id;
  if (!collectionId) {
    return { error: 'This page is not a dynamic CMS page. Bind it to a collection (update_page_settings.cms) or use source "collection".' };
  }
  return { collectionId };
}

export interface FieldBindingInput {
  field_id: string;
  source: BindingSource;
  target: BindingTarget;
  format?: string;
  prefix?: string;
  suffix?: string;
}

/** Per-call cache so a batch binding many layers fetches each collection's fields once. */
export type FieldCache = Map<string, Promise<CollectionField[]>>;

export function getFieldsCached(collectionId: string, cache?: FieldCache): Promise<CollectionField[]> {
  if (!cache) return getFieldsByCollectionId(collectionId);
  let pending = cache.get(collectionId);
  if (!pending) {
    pending = getFieldsByCollectionId(collectionId);
    cache.set(collectionId, pending);
  }
  return pending;
}

/** getFieldFormatError with example output in the site's default language */
export async function getSiteFieldFormatError(field: CollectionField, format: string | undefined): Promise<string | null> {
  if (!getFieldFormatError(field, format)) return null;
  const locale = await getDefaultLocale();
  return getFieldFormatError(field, format, locale?.code);
}

/**
 * Resolve the field and compute the bound layer. Returns the updated layer and a
 * short summary, or an error describing why the layer cannot take the binding.
 */
export async function bindLayerToField(
  layers: Layer[],
  layer: Layer,
  pageId: string,
  input: FieldBindingInput,
  cache?: FieldCache,
): Promise<{ layer: Layer; summary: string; field: CollectionField } | { error: string }> {
  const ctx = await resolveBindingContext(layers, layer.id, pageId, input.source);
  if ('error' in ctx) return ctx;

  const fields = await getFieldsCached(ctx.collectionId, cache);
  const field = fields.find((f) => f.id === input.field_id);
  if (!field) {
    return { error: `Field "${input.field_id}" not found in the ${input.source === 'page' ? 'page' : 'list'} collection.` };
  }

  const formatError = await getSiteFieldFormatError(field, input.format);
  if (formatError) return { error: formatError };

  const fieldData = buildFieldData(field, input.source, ctx.collectionLayerId, input.format);
  return applyFieldBinding(layer, field, fieldData, input);
}
