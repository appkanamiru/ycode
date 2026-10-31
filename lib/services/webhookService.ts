/**
 * Webhook Service
 *
 * Handles dispatching webhook notifications for various events.
 * Supports HMAC signing, delivery logging, and event dispatching.
 * Apps that follow events (Discord) get every event from the same place.
 */

import { createHmac } from 'crypto';
import {
  getWebhooksForEvent,
  createWebhookDelivery,
  updateWebhookDelivery,
  markWebhookTriggered,
  type Webhook,
  type WebhookEventType,
} from '@/lib/repositories/webhookRepository';
import { deliverDiscordEvent, discordFollows } from '@/lib/apps/discord/events';

// =============================================================================
// Types
// =============================================================================

export interface WebhookEvent {
  type: WebhookEventType;
  timestamp: string;
  data: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  /** Resource ID for filter matching (e.g., form_id or collection_id) */
  resourceId?: string;
  /** Resource type for filter matching ('form' or 'collection') */
  resourceType?: 'form' | 'collection';
}

export interface WebhookPayload {
  event: string;
  timestamp: string;
  data: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

// =============================================================================
// Signature Generation
// =============================================================================

/**
 * Generate HMAC-SHA256 signature for webhook payload
 */
export function generateWebhookSignature(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('hex');
}

// =============================================================================
// Event Dispatching
// =============================================================================

/**
 * Dispatch an event to all subscribed webhooks
 *
 * This is a fire-and-forget operation that runs in the background.
 * Errors are logged but don't throw to prevent blocking the main flow.
 */
export async function dispatchWebhookEvent(event: WebhookEvent): Promise<void> {
  const resource = event.resourceType && event.resourceId
    ? { type: event.resourceType, id: event.resourceId }
    : undefined;
  await Promise.all([
    deliverToWebhooks(event),
    deliverDiscordEvent(
      { type: event.type, timestamp: event.timestamp, data: event.data, metadata: event.metadata },
      resource,
    ),
  ]);
}

/**
 * Whether anything (a webhook or an app) follows an event type, so callers
 * can skip loading the details of an event nobody receives
 */
export async function hasEventSubscribers(type: WebhookEventType): Promise<boolean> {
  try {
    const [webhooks, discord] = await Promise.all([getWebhooksForEvent(type), discordFollows(type)]);
    return webhooks.length > 0 || discord;
  } catch {
    return false;
  }
}

async function deliverToWebhooks(event: WebhookEvent): Promise<void> {
  try {
    // Get all enabled webhooks for this event type
    const webhooks = await getWebhooksForEvent(event.type);

    if (webhooks.length === 0) {
      return;
    }

    // Filter webhooks by resource if the event has a resource context
    const matchingWebhooks = webhooks.filter((webhook) => {
      if (!webhook.filters) return true; // No filters = match all

      if (event.resourceType === 'form' && webhook.filters.form_id) {
        return webhook.filters.form_id === event.resourceId;
      }

      if (event.resourceType === 'collection' && webhook.filters.collection_id) {
        return webhook.filters.collection_id === event.resourceId;
      }

      return true; // No matching filter type = match all
    });

    if (matchingWebhooks.length === 0) {
      return;
    }

    // Dispatch to all matching webhooks in parallel
    const results = await Promise.allSettled(
      matchingWebhooks.map((webhook) => deliverToWebhook(webhook, event))
    );
  } catch (error) {
    console.error('Error dispatching webhook event:', error);
  }
}

/**
 * Deliver an event to a single webhook with logging
 */
async function deliverToWebhook(webhook: Webhook, event: WebhookEvent): Promise<void> {
  const payload: WebhookPayload = {
    event: event.type,
    timestamp: event.timestamp,
    data: event.data,
    metadata: event.metadata,
  };

  const payloadString = JSON.stringify(payload);

  // Create delivery log entry
  let deliveryId: string | undefined;
  try {
    const delivery = await createWebhookDelivery({
      webhook_id: webhook.id,
      event_type: event.type,
      payload: payload as unknown as Record<string, unknown>,
      status: 'pending',
    });
    deliveryId = delivery.id;
  } catch (error) {
    console.error('Failed to create webhook delivery log:', error);
  }

  // Build headers
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'User-Agent': 'Ycode-Webhook/1.0',
    'X-Ycode-Event': event.type,
  };

  // Add delivery ID header if available
  if (deliveryId) {
    headers['X-Ycode-Delivery'] = deliveryId;
  }

  // Add HMAC signature if secret is configured
  if (webhook.secret) {
    const signature = generateWebhookSignature(payloadString, webhook.secret);
    headers['X-Ycode-Signature'] = `sha256=${signature}`;
  }

  const startTime = Date.now();

  try {
    const response = await fetch(webhook.url, {
      method: 'POST',
      headers,
      body: payloadString,
    });

    const duration = Date.now() - startTime;
    const responseBody = await response.text();

    // Update delivery log
    if (deliveryId) {
      await updateWebhookDelivery(deliveryId, {
        status: response.ok ? 'success' : 'failed',
        response_status: response.status,
        response_body: responseBody.slice(0, 1000),
        duration_ms: duration,
      }).catch((err) => {
        console.error('Failed to update webhook delivery log:', err);
      });
    }

    // Update webhook trigger status
    await markWebhookTriggered(webhook.id, response.ok);

    if (!response.ok) {
      console.error(`Webhook failed for ${webhook.name}: ${response.status}`);
    }
  } catch (error) {
    const duration = Date.now() - startTime;

    // Update delivery log with failure
    if (deliveryId) {
      await updateWebhookDelivery(deliveryId, {
        status: 'failed',
        response_body: error instanceof Error ? error.message : 'Unknown error',
        duration_ms: duration,
      }).catch((err) => {
        console.error('Failed to update webhook delivery log:', err);
      });
    }

    // Mark webhook as failed
    await markWebhookTriggered(webhook.id, false);

    console.error(`Webhook delivery failed for ${webhook.name}:`, error);
  }
}

// =============================================================================
// Event Factory Functions
// =============================================================================

/**
 * Dispatch a form.submitted event
 */
export async function dispatchFormSubmittedEvent(data: {
  form_id: string;
  submission_id: string;
  fields: Record<string, unknown>;
  metadata?: {
    page_url?: string;
    user_agent?: string;
    referrer?: string;
  };
}): Promise<void> {
  await dispatchWebhookEvent({
    type: 'form.submitted',
    timestamp: new Date().toISOString(),
    data: {
      form_id: data.form_id,
      submission_id: data.submission_id,
      fields: data.fields,
    },
    metadata: data.metadata,
    resourceType: 'form',
    resourceId: data.form_id,
  });
}

/**
 * Dispatch a site.published event
 */
export async function dispatchSitePublishedEvent(data: {
  pages_count?: number;
  collections_count?: number;
}): Promise<void> {
  await dispatchWebhookEvent({
    type: 'site.published',
    timestamp: new Date().toISOString(),
    data,
  });
}

/**
 * Dispatch a collection_item.created event
 */
export async function dispatchCollectionItemCreatedEvent(data: {
  collection_id: string;
  collection_name?: string;
  item_id: string;
  item_name?: string;
  values?: Record<string, unknown>;
}): Promise<void> {
  await dispatchWebhookEvent({
    type: 'collection_item.created',
    timestamp: new Date().toISOString(),
    data,
    resourceType: 'collection',
    resourceId: data.collection_id,
  });
}

/**
 * Dispatch a collection_item.updated event
 */
export async function dispatchCollectionItemUpdatedEvent(data: {
  collection_id: string;
  collection_name?: string;
  item_id: string;
  item_name?: string;
  values?: Record<string, unknown>;
}): Promise<void> {
  await dispatchWebhookEvent({
    type: 'collection_item.updated',
    timestamp: new Date().toISOString(),
    data,
    resourceType: 'collection',
    resourceId: data.collection_id,
  });
}

/**
 * Dispatch a collection_item.deleted event
 */
export async function dispatchCollectionItemDeletedEvent(data: {
  collection_id: string;
  collection_name?: string;
  item_id: string;
  item_name?: string;
}): Promise<void> {
  await dispatchWebhookEvent({
    type: 'collection_item.deleted',
    timestamp: new Date().toISOString(),
    data,
    resourceType: 'collection',
    resourceId: data.collection_id,
  });
}

/**
 * Dispatch a page.created event
 */
export async function dispatchPageCreatedEvent(data: {
  page_id: string;
  page_name?: string;
  page_slug?: string;
}): Promise<void> {
  await dispatchWebhookEvent({
    type: 'page.created',
    timestamp: new Date().toISOString(),
    data,
  });
}

/**
 * Dispatch a page.published event
 */
export async function dispatchPagePublishedEvent(data: {
  page_id: string;
  page_name?: string;
  page_slug?: string;
}): Promise<void> {
  await dispatchWebhookEvent({
    type: 'page.published',
    timestamp: new Date().toISOString(),
    data,
  });
}

/**
 * Dispatch an asset.uploaded event
 */
export async function dispatchAssetUploadedEvent(data: {
  asset_id: string;
  filename: string;
  mime_type: string;
  file_size: number;
}): Promise<void> {
  await dispatchWebhookEvent({
    type: 'asset.uploaded',
    timestamp: new Date().toISOString(),
    data,
  });
}

/**
 * Dispatch a page.updated event (name, slug or settings; not layer edits)
 */
export async function dispatchPageUpdatedEvent(data: {
  page_id: string;
  page_name?: string;
  page_slug?: string;
}): Promise<void> {
  await dispatchWebhookEvent({
    type: 'page.updated',
    timestamp: new Date().toISOString(),
    data,
  });
}

/**
 * Dispatch a page.deleted event
 */
export async function dispatchPageDeletedEvent(data: {
  page_id: string;
  page_name?: string;
  page_slug?: string;
}): Promise<void> {
  await dispatchWebhookEvent({
    type: 'page.deleted',
    timestamp: new Date().toISOString(),
    data,
  });
}

/**
 * Dispatch an asset.deleted event
 */
export async function dispatchAssetDeletedEvent(data: {
  asset_id: string;
  filename: string;
  mime_type?: string;
  file_size?: number;
}): Promise<void> {
  await dispatchWebhookEvent({
    type: 'asset.deleted',
    timestamp: new Date().toISOString(),
    data,
  });
}
