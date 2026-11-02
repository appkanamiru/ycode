/**
 * Discord channels following site events (see dispatchWebhookEvent)
 */

import { getAppSettingValue } from '@/lib/repositories/appSettingsRepository';
import { getSettingsByKeys } from '@/lib/repositories/settingsRepository';
import type { WebhookEventType } from '@/lib/repositories/webhookRepository';
import { isMultiTenant } from '@/lib/database/tenancy';
import { getConnectionsForEvent, sendDiscordMessage, type EventResource } from './index';
import { buildEventMessage, type SiteEvent, type SiteInfo } from './messages';
import type { DiscordConnection } from './types';

async function loadConnections(): Promise<DiscordConnection[]> {
  return (await getAppSettingValue<DiscordConnection[]>('discord', 'connections')) ?? [];
}

/** Whether any channel follows the event (so callers can skip preparing it) */
export async function discordFollows(type: WebhookEventType): Promise<boolean> {
  return getConnectionsForEvent(await loadConnections(), type).length > 0;
}

/** The current site's name and addresses, for messages */
export async function getSiteInfo(): Promise<SiteInfo> {
  const settings = await getSettingsByKeys(['site_name', 'global_canonical_url']).catch(() => ({} as Record<string, unknown>));
  let url = typeof settings.global_canonical_url === 'string' && settings.global_canonical_url
    ? settings.global_canonical_url
    : null;

  if (!url && isMultiTenant()) {
    // Loaded only on the platform: they pull in its auth and database
    const [{ getTenantIdFromHeaders }, { getSiteAddressById }] = await Promise.all([
      import('@/lib/supabase-server'),
      import('@/lib/platform/sites'),
    ]);
    const tenantId = await getTenantIdFromHeaders();
    url = tenantId ? await getSiteAddressById(tenantId).catch(() => null) : null;
  }

  const editor = process.env.BETTER_AUTH_URL;
  return {
    name: typeof settings.site_name === 'string' && settings.site_name ? settings.site_name : null,
    url: url ? url.replace(/\/+$/, '') : null,
    editorUrl: editor ? `${new URL(editor).origin}/ycode` : null,
  };
}

/** Post an event to every channel that follows it; failures are logged */
export async function deliverDiscordEvent(event: SiteEvent, resource?: EventResource): Promise<void> {
  try {
    const targets = getConnectionsForEvent(await loadConnections(), event.type, resource);
    if (targets.length === 0) return;

    const site = await getSiteInfo();
    const results = await Promise.all(targets.map((target) => sendDiscordMessage(
      target.webhookUrl,
      buildEventMessage(event, site, target.templates?.[event.type]),
    )));
    results.forEach((result, index) => {
      if (!result.success) {
        console.error(`[Discord] Failed to post ${event.type} to "${targets[index].name}":`, result.error);
      }
    });
  } catch (error) {
    console.error('[Discord] Integration error:', error);
  }
}
