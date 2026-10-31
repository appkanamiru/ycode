import { NextRequest } from 'next/server';
import { buildFormSubmissionMessage, isDiscordWebhookUrl, sendDiscordMessage } from '@/lib/apps/discord';
import { getSettingByKey } from '@/lib/repositories/settingsRepository';
import { noCache } from '@/lib/api-response';

// Disable caching for this route
export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * POST /ycode/api/apps/discord/test
 * Send a sample form submission to a Discord webhook
 *
 * Body: { webhook_url: string }
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { webhook_url } = body;

    if (!isDiscordWebhookUrl(webhook_url)) {
      return noCache({ error: 'Paste a Discord webhook URL (https://discord.com/api/webhooks/…)' }, 400);
    }

    const siteName = await getSettingByKey('site_name').catch(() => null);
    const message = buildFormSubmissionMessage({
      formId: 'Test message',
      fields: { name: 'Jana Nováková', email: 'jana@example.com', message: 'This is how form submissions will look.' },
      siteName: typeof siteName === 'string' ? siteName : null,
    });

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
