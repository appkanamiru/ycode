/**
 * Discord Integration
 *
 * Posts a message to Discord channels through their webhooks when site events
 * happen (form submissions, publishing, CMS items, …). Discord only accepts
 * its own message format, so the generic webhooks cannot reach it.
 */

import type { WebhookEventType } from '@/lib/repositories/webhookRepository';
import type { DiscordConnection, DiscordMessage } from './types';
import { ALL_FORMS } from './types';

const WEBHOOK_HOSTS = new Set(['discord.com', 'discordapp.com', 'ptb.discord.com', 'canary.discord.com']);
const WEBHOOK_PATH = /^\/api\/webhooks\/\d+\/[\w-]+\/?$/;

const REQUEST_TIMEOUT_MS = 10_000;
/** A rate-limited message is retried once if Discord asks to wait at most this long */
const MAX_RETRY_WAIT_MS = 5_000;

/** Whether a URL is a Discord channel webhook (so the app never posts elsewhere) */
export function isDiscordWebhookUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value.trim());
    return url.protocol === 'https:' && WEBHOOK_HOSTS.has(url.hostname) && WEBHOOK_PATH.test(url.pathname);
  } catch {
    return false;
  }
}

export interface SendResult {
  success: boolean;
  error?: string;
}

/** Post a message to a Discord webhook; retries once when briefly rate limited */
export async function sendDiscordMessage(webhookUrl: string, message: DiscordMessage): Promise<SendResult> {
  if (!isDiscordWebhookUrl(webhookUrl)) return { success: false, error: 'Not a Discord webhook URL' };

  const post = () => fetch(webhookUrl.trim(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(message),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  try {
    let response = await post();
    if (response.status === 429) {
      const body = await response.json().catch(() => ({}));
      const waitMs = Math.ceil(Number(body.retry_after ?? 1) * 1000);
      if (waitMs <= MAX_RETRY_WAIT_MS) {
        await new Promise((resolve) => setTimeout(resolve, waitMs));
        response = await post();
      }
    }
    if (response.ok) return { success: true };

    const body = await response.json().catch(() => null);
    const reason = body?.message ? `: ${body.message}` : '';
    if (response.status === 401 || response.status === 404) {
      return { success: false, error: `Discord does not know this webhook (it may have been deleted)${reason}` };
    }
    return { success: false, error: `Discord answered ${response.status}${reason}` };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Could not reach Discord' };
  }
}

/** A stored channel in the current shape: older ones followed one form's submissions */
export function normalizeConnection(connection: DiscordConnection): DiscordConnection {
  if (Array.isArray(connection.events)) return connection;
  const formId = connection.formId && connection.formId !== ALL_FORMS ? connection.formId : null;
  return { ...connection, events: ['form.submitted'], filters: { form_id: formId } };
}

/** What an event is about, for the channels' form / collection filters */
export interface EventResource {
  type: 'form' | 'collection';
  id: string;
}

/** Enabled channels that follow an event (and whose filter, if any, matches it) */
export function getConnectionsForEvent(
  connections: DiscordConnection[],
  type: WebhookEventType,
  resource?: EventResource,
): DiscordConnection[] {
  return connections.map(normalizeConnection).filter((connection) => {
    if (!connection.enabled || !connection.events.includes(type)) return false;
    if (resource?.type === 'form' && connection.filters?.form_id) return connection.filters.form_id === resource.id;
    if (resource?.type === 'collection' && connection.filters?.collection_id) {
      return connection.filters.collection_id === resource.id;
    }
    return true;
  });
}
