/**
 * App Integration Service
 *
 * Processes form submissions through configured app integrations.
 * Each app that has active connections for the submitted form
 * will receive the submission data.
 *
 * This runs fire-and-forget (non-blocking) so form submission
 * response is not delayed by integration processing.
 */

import { getAppSettingValue } from '@/lib/repositories/appSettingsRepository';
import { getSettingByKey } from '@/lib/repositories/settingsRepository';
import { processFormSubmission } from '@/lib/apps/mailerlite';
import type { MailerLiteConnection } from '@/lib/apps/mailerlite/types';
import { buildFormSubmissionMessage, getConnectionsForForm, sendDiscordMessage } from '@/lib/apps/discord';
import type { DiscordConnection } from '@/lib/apps/discord/types';

export interface SubmissionContext {
  /** Page the form was sent from (reported by the browser) */
  pageUrl?: string;
  submittedAt?: string;
}

/**
 * Process a form submission through all configured app integrations.
 * This is fire-and-forget - errors are logged but don't propagate.
 */
export async function processAppIntegrations(
  formId: string,
  submissionId: string,
  payload: Record<string, unknown>,
  context: SubmissionContext = {},
): Promise<void> {
  try {
    await Promise.all([
      processMailerLiteIntegration(formId, payload),
      processDiscordIntegration(formId, payload, context),
    ]);
  } catch (error) {
    console.error('[processAppIntegrations] Unexpected error:', error);
  }
}

/**
 * Process form submission for MailerLite integration
 */
async function processMailerLiteIntegration(
  formId: string,
  payload: Record<string, unknown>
): Promise<void> {
  try {
    // Load MailerLite API key
    const apiKey = await getAppSettingValue<string>('mailerlite', 'api_key');
    if (!apiKey) return; // MailerLite not configured

    // Load connections
    const connections = await getAppSettingValue<MailerLiteConnection[]>(
      'mailerlite',
      'connections'
    );
    if (!connections || connections.length === 0) return;

    // Find active connections for this form
    const activeConnections = connections.filter(
      (c) => c.enabled && c.formId === formId
    );

    if (activeConnections.length === 0) return;

    // Process each connection in parallel
    const results = await Promise.allSettled(
      activeConnections.map((connection) =>
        processFormSubmission(apiKey, connection, payload)
      )
    );

    // Log results
    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      const connection = activeConnections[i];

      if (result.status === 'fulfilled') {
        if (!result.value.success) {
          console.error(
            `[MailerLite] Failed to process form "${formId}" -> group "${connection.groupName}":`,
            result.value.error
          );
        }
      } else {
        console.error(
          `[MailerLite] Error processing form "${formId}" -> group "${connection.groupName}":`,
          result.reason
        );
      }
    }
  } catch (error) {
    console.error('[MailerLite] Integration error:', error);
  }
}

/** Where the editor lists form submissions: the editor's own origin, else the site's */
function getSubmissionsUrl(pageUrl?: string): string | null {
  const editor = process.env.BETTER_AUTH_URL;
  try {
    const origin = editor ? new URL(editor).origin : pageUrl ? new URL(pageUrl).origin : null;
    return origin ? `${origin}/ycode/forms` : null;
  } catch {
    return null;
  }
}

/**
 * Process form submission for Discord: a message in each connected channel
 */
async function processDiscordIntegration(
  formId: string,
  payload: Record<string, unknown>,
  context: SubmissionContext,
): Promise<void> {
  try {
    const connections = await getAppSettingValue<DiscordConnection[]>('discord', 'connections');
    const targets = getConnectionsForForm(connections ?? [], formId);
    if (targets.length === 0) return;

    const siteName = await getSettingByKey('site_name').catch(() => null);
    const message = buildFormSubmissionMessage({
      formId,
      fields: payload,
      siteName: typeof siteName === 'string' ? siteName : null,
      pageUrl: context.pageUrl,
      submissionsUrl: getSubmissionsUrl(context.pageUrl),
      submittedAt: context.submittedAt,
    });

    const results = await Promise.all(targets.map((target) => sendDiscordMessage(target.webhookUrl, message)));
    results.forEach((result, index) => {
      if (!result.success) {
        console.error(`[Discord] Failed to notify "${targets[index].name}" of form "${formId}":`, result.error);
      }
    });
  } catch (error) {
    console.error('[Discord] Integration error:', error);
  }
}
