/**
 * Discord Types
 */

import type { WebhookEventType } from '@/lib/repositories/webhookRepository';

/** Value of a legacy `formId` that sent every form's submissions */
export const ALL_FORMS = '*';

/** A channel that receives site events (stored in app_settings as `connections`) */
export interface DiscordConnection {
  id: string;
  /** Label shown in the settings, e.g. the channel name */
  name: string;
  /** Webhook URL from Discord: Channel settings → Integrations → Webhooks */
  webhookUrl: string;
  /** Events the channel follows */
  events: WebhookEventType[];
  /** Only this form's submissions / this collection's items; null for all */
  filters?: { form_id?: string | null; collection_id?: string | null };
  /** The channel's own message per event, with {{variables}}; events without one get the default card */
  templates?: Partial<Record<WebhookEventType, string>> | null;
  enabled: boolean;
  /** Before events could be chosen, channels followed one form (or ALL_FORMS) */
  formId?: string;
}

export interface DiscordEmbedField {
  name: string;
  value: string;
  inline?: boolean;
}

/** The subset of Discord's webhook message the app sends */
export interface DiscordMessage {
  username?: string;
  content?: string;
  embeds: Array<{
    title: string;
    url?: string;
    description?: string;
    color: number;
    fields: DiscordEmbedField[];
    footer?: { text: string };
    timestamp?: string;
  }>;
  /** Never ping anyone from text visitors typed */
  allowed_mentions: { parse: never[] };
}
