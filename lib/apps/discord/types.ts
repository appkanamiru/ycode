/**
 * Discord Types
 */

/** Value of `formId` that sends every form's submissions */
export const ALL_FORMS = '*';

/** A channel that receives form submissions (stored in app_settings as `connections`) */
export interface DiscordConnection {
  id: string;
  /** Label shown in the settings, e.g. the channel name */
  name: string;
  /** Webhook URL from Discord: Channel settings → Integrations → Webhooks */
  webhookUrl: string;
  /** Form whose submissions are sent, or ALL_FORMS */
  formId: string;
  enabled: boolean;
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
