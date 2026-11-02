/**
 * Discord Messages
 *
 * Turns site events into Discord messages: a default card per event, or the
 * channel's own text with {{variables}} filled in from the event.
 */

import type { WebhookEventType } from '@/lib/repositories/webhookRepository';
import type { DiscordEmbedField, DiscordMessage } from './types';

/** Event as delivered to apps (see dispatchWebhookEvent) */
export interface SiteEvent {
  type: WebhookEventType;
  timestamp: string;
  data: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

/** The site an event happened on */
export interface SiteInfo {
  name: string | null;
  /** Public address, without a trailing slash */
  url: string | null;
  /** The editor, e.g. https://builder.example.com/ycode */
  editorUrl: string | null;
}

export interface EventVariable {
  name: string;
  description: string;
}

export interface DiscordEventDefinition {
  type: WebhookEventType;
  label: string;
  /** Variables its messages can use, besides the common ones */
  variables: EventVariable[];
}

export const COMMON_VARIABLES: EventVariable[] = [
  { name: 'site.name', description: 'Site name' },
  { name: 'site.url', description: 'Site address' },
  { name: 'editor.url', description: 'Editor address' },
  { name: 'event', description: 'Event, e.g. site.published' },
  { name: 'time', description: 'When it happened (UTC)' },
];

const ITEM_VARIABLES: EventVariable[] = [
  { name: 'collection', description: 'Collection name' },
  { name: 'item.name', description: 'Item name' },
  { name: 'item.id', description: 'Item ID' },
  { name: 'values.<field name>', description: 'A field of the item, e.g. {{values.Title}}' },
];

const PAGE_VARIABLES: EventVariable[] = [
  { name: 'page.name', description: 'Page name' },
  { name: 'page.slug', description: 'Page slug' },
  { name: 'page.url', description: 'Page address' },
];

const ASSET_VARIABLES: EventVariable[] = [
  { name: 'asset.name', description: 'File name' },
  { name: 'asset.type', description: 'File type' },
  { name: 'asset.size', description: 'File size' },
];

/** Events a Discord channel can follow, in the order the settings show them */
export const DISCORD_EVENTS: DiscordEventDefinition[] = [
  {
    type: 'form.submitted',
    label: 'Form submitted',
    variables: [
      { name: 'form', description: 'Form name' },
      { name: 'page_url', description: 'Page the form was sent from' },
      { name: 'fields', description: 'All fields, one per line' },
      { name: 'fields.<field name>', description: 'One field, e.g. {{fields.email}}' },
    ],
  },
  {
    type: 'site.published',
    label: 'Site published',
    variables: [
      { name: 'pages_count', description: 'Pages published' },
      { name: 'items_count', description: 'CMS items published' },
    ],
  },
  { type: 'collection_item.created', label: 'CMS item created', variables: ITEM_VARIABLES },
  { type: 'collection_item.updated', label: 'CMS item updated', variables: ITEM_VARIABLES },
  { type: 'collection_item.deleted', label: 'CMS item deleted', variables: ITEM_VARIABLES },
  { type: 'page.created', label: 'Page created', variables: PAGE_VARIABLES },
  { type: 'page.updated', label: 'Page settings updated', variables: PAGE_VARIABLES },
  { type: 'page.deleted', label: 'Page deleted', variables: PAGE_VARIABLES },
  { type: 'page.published', label: 'Page published', variables: PAGE_VARIABLES },
  { type: 'asset.uploaded', label: 'File uploaded', variables: ASSET_VARIABLES },
  { type: 'asset.deleted', label: 'File deleted', variables: ASSET_VARIABLES },
];

const EVENT_LABELS = new Map(DISCORD_EVENTS.map((definition) => [definition.type, definition.label]));

// Discord's limits
const MAX_CONTENT = 2000;
const MAX_FIELDS = 25;
const MAX_FIELD_NAME = 256;
const MAX_FIELD_VALUE = 1024;
const MAX_TITLE = 256;
const MAX_DESCRIPTION = 4096;
const MAX_FOOTER = 2048;
const MAX_EMBED_TOTAL = 6000;
/** Discord's blurple */
const EMBED_COLOR = 0x5865f2;

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** A value as text: lists comma separated, empty as a dash */
export function formatValue(value: unknown): string {
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

function formatSize(bytes: unknown): string {
  const size = Number(bytes);
  if (!Number.isFinite(size) || size <= 0) return '';
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(0)} kB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value);
}

function pageUrl(site: SiteInfo, slug: unknown): string {
  if (!site.url) return '';
  const path = text(slug).replace(/^\/+/, '');
  return path ? `${site.url}/${path}` : site.url;
}

/**
 * Template variables of an event. Groups (`site`, `fields`, `values`, …) are
 * maps, read as `{{group.key}}` where the key may contain spaces.
 */
export function getEventVariables(event: SiteEvent, site: SiteInfo): Record<string, unknown> {
  const data = event.data;
  const variables: Record<string, unknown> = {
    event: event.type,
    time: event.timestamp,
    site: { name: site.name ?? '', url: site.url ?? '' },
    editor: { url: site.editorUrl ?? '' },
  };

  switch (event.type) {
    case 'form.submitted': {
      const fields = asRecord(data.fields);
      variables.form = text(data.form_id);
      variables.page_url = text(event.metadata?.page_url);
      variables.fields = fields;
      break;
    }
    case 'site.published':
      variables.pages_count = data.pages_count ?? 0;
      variables.items_count = data.collections_count ?? 0;
      break;
    case 'collection_item.created':
    case 'collection_item.updated':
    case 'collection_item.deleted':
      variables.collection = text(data.collection_name);
      variables.item = { name: text(data.item_name), id: text(data.item_id) };
      variables.values = asRecord(data.values);
      break;
    case 'page.created':
    case 'page.updated':
    case 'page.deleted':
    case 'page.published':
      variables.page = { name: text(data.page_name), slug: text(data.page_slug), url: pageUrl(site, data.page_slug) };
      break;
    case 'asset.uploaded':
    case 'asset.deleted':
      variables.asset = { name: text(data.filename), type: text(data.mime_type), size: formatSize(data.file_size) };
      break;
  }
  return variables;
}

/** Text of a template variable: a value, or a map as `key: value` lines */
function variableText(value: unknown): string {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return Object.entries(value).map(([key, item]) => `${formatFieldName(key)}: ${formatValue(item)}`).join('\n');
  }
  if (Array.isArray(value)) return value.map((item) => formatValue(item)).join(', ');
  return value === undefined || value === null ? '' : String(value);
}

/** Fill `{{name}}` and `{{group.key}}` placeholders; unknown ones become empty */
export function renderTemplate(template: string, variables: Record<string, unknown>): string {
  return template.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (_match, path: string) => {
    if (path in variables) return variableText(variables[path]);
    const dot = path.indexOf('.');
    if (dot === -1) return '';
    const group = asRecord(variables[path.slice(0, dot)]);
    const key = path.slice(dot + 1);
    if (key in group) return variableText(group[key]);
    // Field keys and names are matched case-insensitively
    const match = Object.keys(group).find((candidate) => candidate.toLowerCase() === key.toLowerCase());
    return match ? variableText(group[match]) : '';
  });
}

interface Card {
  title: string;
  description?: string;
  url?: string;
  fields: DiscordEmbedField[];
}

function fieldsFrom(record: Record<string, unknown>, humanize: boolean): DiscordEmbedField[] {
  return Object.entries(record).map(([key, value]) => ({
    name: humanize ? formatFieldName(key) : key,
    value: formatValue(value),
  }));
}

/** The default card for an event */
function describeEvent(event: SiteEvent, site: SiteInfo): Card {
  const data = event.data;
  const label = EVENT_LABELS.get(event.type) ?? event.type;
  switch (event.type) {
    case 'form.submitted':
      return {
        title: `New submission: ${text(data.form_id)}`,
        url: site.editorUrl ? `${site.editorUrl}/forms` : undefined,
        fields: fieldsFrom(asRecord(data.fields), true),
      };
    case 'site.published':
      return {
        title: 'Site published',
        description: `${Number(data.pages_count ?? 0)} page(s) and ${Number(data.collections_count ?? 0)} CMS item(s) published.`,
        url: site.url ?? undefined,
        fields: [],
      };
    case 'collection_item.created':
    case 'collection_item.updated':
    case 'collection_item.deleted': {
      const name = text(data.item_name) || text(data.item_id);
      return {
        title: `${label}: ${name}`,
        description: data.collection_name ? `Collection: ${text(data.collection_name)}` : undefined,
        url: site.editorUrl && event.type !== 'collection_item.deleted' ? `${site.editorUrl}/collections` : undefined,
        fields: event.type === 'collection_item.deleted' ? [] : fieldsFrom(asRecord(data.values), false),
      };
    }
    case 'page.created':
    case 'page.updated':
    case 'page.deleted':
    case 'page.published': {
      const url = pageUrl(site, data.page_slug);
      return {
        title: `${label}: ${text(data.page_name) || text(data.page_id)}`,
        description: url && event.type !== 'page.deleted' ? url : undefined,
        url: url && event.type === 'page.published' ? url : undefined,
        fields: [],
      };
    }
    case 'asset.uploaded':
    case 'asset.deleted':
      return {
        title: `${label}: ${text(data.filename)}`,
        description: [text(data.mime_type), formatSize(data.file_size)].filter(Boolean).join(' · ') || undefined,
        fields: [],
      };
    default:
      return { title: label, fields: fieldsFrom(data, true) };
  }
}

/**
 * The Discord message for an event: the channel's own text when it has one,
 * else the default card. Kept within Discord's limits, never pinging anyone.
 */
export function buildEventMessage(event: SiteEvent, site: SiteInfo, template?: string | null): DiscordMessage {
  const username = site.name ? truncate(site.name, 80) : undefined;

  if (template?.trim()) {
    const content = renderTemplate(template, getEventVariables(event, site)).trim();
    return {
      username,
      content: truncate(content || EVENT_LABELS.get(event.type) || event.type, MAX_CONTENT),
      embeds: [],
      allowed_mentions: { parse: [] },
    };
  }

  const card = describeEvent(event, site);
  const title = truncate(card.title, MAX_TITLE);
  const description = card.description ? truncate(card.description, MAX_DESCRIPTION) : undefined;
  const fields: DiscordEmbedField[] = [];
  let total = title.length + (description?.length ?? 0);
  for (const field of card.fields.slice(0, MAX_FIELDS)) {
    const entry = { name: truncate(field.name, MAX_FIELD_NAME), value: truncate(field.value, MAX_FIELD_VALUE) };
    if (total + entry.name.length + entry.value.length > MAX_EMBED_TOTAL - MAX_FOOTER) break;
    total += entry.name.length + entry.value.length;
    fields.push(entry);
  }

  const pageFrom = event.type === 'form.submitted' ? text(event.metadata?.page_url) : '';
  const footerParts = [
    site.name,
    pageFrom,
    fields.length < card.fields.length ? `${card.fields.length - fields.length} more field(s) in the editor` : null,
  ].filter(Boolean);

  return {
    username,
    embeds: [{
      title,
      description,
      url: card.url,
      color: EMBED_COLOR,
      fields,
      footer: footerParts.length ? { text: truncate(footerParts.join(' · '), MAX_FOOTER) } : undefined,
      timestamp: event.timestamp,
    }],
    allowed_mentions: { parse: [] },
  };
}

/** Example event of a type, for test messages and previews */
export function getSampleEvent(type: WebhookEventType): SiteEvent {
  const timestamp = new Date().toISOString();
  const item = {
    collection_id: 'sample', collection_name: 'Blog', item_id: 'sample',
    item_name: 'Hello world', values: { Name: 'Hello world', Slug: 'hello-world', Summary: 'An example item.' },
  };
  const page = { page_id: 'sample', page_name: 'About us', page_slug: 'about' };
  const asset = { asset_id: 'sample', filename: 'photo.jpg', mime_type: 'image/jpeg', file_size: 245_000 };
  const samples: Record<WebhookEventType, SiteEvent['data']> = {
    'form.submitted': { form_id: 'contact', fields: { name: 'Jana Nováková', email: 'jana@example.com', message: 'This is how form submissions will look.' } },
    'site.published': { pages_count: 3, collections_count: 2 },
    'collection_item.created': item,
    'collection_item.updated': item,
    'collection_item.deleted': item,
    'page.created': page,
    'page.updated': page,
    'page.deleted': page,
    'page.published': page,
    'asset.uploaded': asset,
    'asset.deleted': asset,
  };
  return {
    type,
    timestamp,
    data: samples[type],
    metadata: type === 'form.submitted' ? { page_url: 'https://example.com/contact' } : undefined,
  };
}
