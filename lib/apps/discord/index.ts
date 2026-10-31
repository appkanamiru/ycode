/**
 * Discord Integration
 *
 * Posts a message to a Discord channel through its webhook when a form is
 * submitted. Discord only accepts its own message format, so the generic
 * webhooks (Integrations → Webhooks) cannot reach it.
 */

import type { DiscordConnection, DiscordEmbedField, DiscordMessage } from './types';
import { ALL_FORMS } from './types';

const WEBHOOK_HOSTS = new Set(['discord.com', 'discordapp.com', 'ptb.discord.com', 'canary.discord.com']);
const WEBHOOK_PATH = /^\/api\/webhooks\/\d+\/[\w-]+\/?$/;

// Discord's limits for embeds
const MAX_FIELDS = 25;
const MAX_FIELD_NAME = 256;
const MAX_FIELD_VALUE = 1024;
const MAX_TITLE = 256;
const MAX_FOOTER = 2048;
const MAX_EMBED_TOTAL = 6000;

/** Discord's blurple */
const EMBED_COLOR = 0x5865f2;
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

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** A submitted value as text: lists comma separated, empty as a dash */
function formatValue(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (Array.isArray(value)) return value.length ? value.map((item) => formatValue(item)).join(', ') : '—';
  if (typeof value === 'object') return JSON.stringify(value);
  const text = String(value).trim();
  return text || '—';
}

/** Form field keys as labels: `first_name` → `First name` */
function formatFieldName(key: string): string {
  const spaced = key.replace(/[_-]+/g, ' ').trim();
  return spaced ? spaced.charAt(0).toUpperCase() + spaced.slice(1) : key;
}

export interface FormSubmissionNotice {
  formId: string;
  fields: Record<string, unknown>;
  siteName?: string | null;
  /** Page the form was sent from */
  pageUrl?: string | null;
  /** Where the submissions are read in the editor */
  submissionsUrl?: string | null;
  submittedAt?: string;
}

/** The Discord message for a form submission, within Discord's limits */
export function buildFormSubmissionMessage(notice: FormSubmissionNotice): DiscordMessage {
  const title = truncate(`New submission: ${notice.formId}`, MAX_TITLE);
  const entries = Object.entries(notice.fields);
  const fields: DiscordEmbedField[] = [];
  let total = title.length;

  for (const [key, value] of entries.slice(0, MAX_FIELDS)) {
    const field = {
      name: truncate(formatFieldName(key), MAX_FIELD_NAME),
      value: truncate(formatValue(value), MAX_FIELD_VALUE),
    };
    if (total + field.name.length + field.value.length > MAX_EMBED_TOTAL - MAX_FOOTER) break;
    total += field.name.length + field.value.length;
    fields.push(field);
  }

  const footerParts = [
    notice.siteName,
    notice.pageUrl,
    fields.length < entries.length ? `${entries.length - fields.length} more field(s) in the editor` : null,
  ].filter(Boolean);

  return {
    username: notice.siteName ? truncate(notice.siteName, 80) : undefined,
    embeds: [{
      title,
      url: notice.submissionsUrl || undefined,
      color: EMBED_COLOR,
      fields,
      footer: footerParts.length ? { text: truncate(footerParts.join(' · '), MAX_FOOTER) } : undefined,
      timestamp: notice.submittedAt ?? new Date().toISOString(),
    }],
    allowed_mentions: { parse: [] },
  };
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

/** Connections that receive a form's submissions */
export function getConnectionsForForm(connections: DiscordConnection[], formId: string): DiscordConnection[] {
  return connections.filter((connection) => connection.enabled
    && (connection.formId === ALL_FORMS || connection.formId === formId));
}
