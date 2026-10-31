import { NextRequest } from 'next/server';
import { isDiscordWebhookUrl, sendDiscordMessage } from '@/lib/apps/discord';
import { getSiteInfo } from '@/lib/apps/discord/events';
import { buildEventMessage, DISCORD_EVENTS, getSampleEvent } from '@/lib/apps/discord/messages';
import { noCache } from '@/lib/api-response';

// Disable caching for this route
export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * POST /ycode/api/apps/discord/test
 * Send an example of an event to a Discord webhook, as the channel would get it
 *
 * Body: { webhook_url: string, event?: WebhookEventType, template?: string }
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { webhook_url, template } = body;

    if (!isDiscordWebhookUrl(webhook_url)) {
      return noCache({ error: 'Paste a Discord webhook URL (https://discord.com/api/webhooks/…)' }, 400);
    }
    const definition = DISCORD_EVENTS.find((candidate) => candidate.type === body.event) ?? DISCORD_EVENTS[0];

    const message = buildEventMessage(
      getSampleEvent(definition.type),
      await getSiteInfo(),
      typeof template === 'string' ? template : null,
    );
    const result = await sendDiscordMessage(webhook_url, message);
    if (!result.success) return noCache({ error: result.error }, 400);

    return noCache({ data: { success: true } });
  } catch (error) {
    console.error('Error testing Discord webhook:', error);
    return noCache(
      { error: error instanceof Error ? error.message : 'Failed to send the test message' },
      500
    );
  }
}
