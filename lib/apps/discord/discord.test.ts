import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import { getConnectionsForEvent, isDiscordWebhookUrl, normalizeConnection, sendDiscordMessage } from './index';
import { buildEventMessage, DISCORD_EVENTS, getSampleEvent, renderTemplate, getEventVariables, type SiteInfo } from './messages';
import type { DiscordConnection } from './types';

const WEBHOOK = 'https://discord.com/api/webhooks/123456789/abc_DEF-123';
const SITE: SiteInfo = { name: 'Mizora', url: 'https://mizora.cz', editorUrl: 'https://builder.example/ycode' };
const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

test('only Discord webhook URLs are accepted', () => {
  assert.equal(isDiscordWebhookUrl(WEBHOOK), true);
  assert.equal(isDiscordWebhookUrl('https://discordapp.com/api/webhooks/1/x'), true);
  assert.equal(isDiscordWebhookUrl('https://ptb.discord.com/api/webhooks/1/x'), true);
  assert.equal(isDiscordWebhookUrl('http://discord.com/api/webhooks/1/x'), false);
  assert.equal(isDiscordWebhookUrl('https://evil.example/api/webhooks/1/x'), false);
  assert.equal(isDiscordWebhookUrl('https://discord.com.evil.example/api/webhooks/1/x'), false);
  assert.equal(isDiscordWebhookUrl('https://discord.com/api/users/1'), false);
  assert.equal(isDiscordWebhookUrl(42), false);
});

test('a form submission becomes a card with readable fields', () => {
  const message = buildEventMessage({
    type: 'form.submitted',
    timestamp: '2026-10-31T12:00:00.000Z',
    data: { form_id: 'contact', fields: { first_name: 'Jana', topics: ['web', 'app'], note: '  ' } },
    metadata: { page_url: 'https://mizora.cz/kontakt' },
  }, SITE);
  const [embed] = message.embeds;
  assert.equal(embed.title, 'New submission: contact');
  assert.equal(embed.url, 'https://builder.example/ycode/forms');
  assert.deepEqual(embed.fields, [
    { name: 'First name', value: 'Jana' },
    { name: 'Topics', value: 'web, app' },
    { name: 'Note', value: '—' },
  ]);
  assert.equal(embed.footer?.text, 'Mizora · https://mizora.cz/kontakt');
  assert.equal(message.username, 'Mizora');
  assert.deepEqual(message.allowed_mentions, { parse: [] });
});

test('every event has a default card and a sample', () => {
  for (const { type } of DISCORD_EVENTS) {
    const [embed] = buildEventMessage(getSampleEvent(type), SITE).embeds;
    assert.ok(embed.title.length > 0, type);
  }
  const [published] = buildEventMessage(getSampleEvent('site.published'), SITE).embeds;
  assert.equal(published.title, 'Site published');
  assert.equal(published.url, 'https://mizora.cz');
  const [item] = buildEventMessage(getSampleEvent('collection_item.created'), SITE).embeds;
  assert.equal(item.title, 'CMS item created: Hello world');
  assert.equal(item.description, 'Collection: Blog');
});

test('own messages fill variables from the event', () => {
  const published = buildEventMessage(getSampleEvent('site.published'), SITE, 'Web {{site.name}} je venku: {{site.url}} ({{pages_count}} stránek)');
  assert.equal(published.content, 'Web Mizora je venku: https://mizora.cz (3 stránek)');
  assert.deepEqual(published.embeds, []);

  const item = buildEventMessage(getSampleEvent('collection_item.created'), SITE, 'Nový článek: {{ item.name }} – {{values.summary}}{{unknown}}');
  assert.equal(item.content, 'Nový článek: Hello world – An example item.');

  const form = getEventVariables(getSampleEvent('form.submitted'), SITE);
  assert.equal(renderTemplate('{{fields.email}}', form), 'jana@example.com');
  assert.equal(renderTemplate('{{fields}}', form).split('\n')[0], 'Name: Jana Nováková');
  assert.equal(renderTemplate('{{page.url}}', getEventVariables(getSampleEvent('page.published'), SITE)), 'https://mizora.cz/about');
});

test('messages stay within Discord limits', () => {
  const fields = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`field_${i}`, 'x'.repeat(2000)]));
  const [embed] = buildEventMessage({ type: 'form.submitted', timestamp: '', data: { form_id: 'big', fields } }, SITE).embeds;
  assert.ok(embed.fields.length <= 25);
  assert.ok(embed.fields.every((field) => field.value.length <= 1024));
  const total = embed.title.length + embed.fields.reduce((sum, f) => sum + f.name.length + f.value.length, 0)
    + (embed.footer?.text.length ?? 0);
  assert.ok(total <= 6000, `embed has ${total} characters`);
  assert.match(embed.footer?.text ?? '', /more field\(s\) in the editor/);

  const long = buildEventMessage(getSampleEvent('site.published'), SITE, 'x'.repeat(3000));
  assert.equal(long.content?.length, 2000);
});

test('channels are picked by event and filter, enabled ones only', () => {
  const connections: DiscordConnection[] = [
    { id: '1', name: 'all forms', webhookUrl: WEBHOOK, events: ['form.submitted'], enabled: true },
    { id: '2', name: 'contact', webhookUrl: WEBHOOK, events: ['form.submitted'], filters: { form_id: 'contact' }, enabled: true },
    { id: '3', name: 'off', webhookUrl: WEBHOOK, events: ['form.submitted'], enabled: false },
    { id: '4', name: 'blog', webhookUrl: WEBHOOK, events: ['collection_item.created', 'site.published'], filters: { collection_id: 'blog' }, enabled: true },
  ];
  assert.deepEqual(getConnectionsForEvent(connections, 'form.submitted', { type: 'form', id: 'contact' }).map((c) => c.id), ['1', '2']);
  assert.deepEqual(getConnectionsForEvent(connections, 'form.submitted', { type: 'form', id: 'other' }).map((c) => c.id), ['1']);
  assert.deepEqual(getConnectionsForEvent(connections, 'collection_item.created', { type: 'collection', id: 'blog' }).map((c) => c.id), ['4']);
  assert.deepEqual(getConnectionsForEvent(connections, 'collection_item.created', { type: 'collection', id: 'news' }).map((c) => c.id), []);
  assert.deepEqual(getConnectionsForEvent(connections, 'site.published').map((c) => c.id), ['4']);
});

test('channels saved before events could be chosen keep following their form', () => {
  const legacy = { id: 'old', name: 'old', webhookUrl: WEBHOOK, formId: 'contact', enabled: true } as unknown as DiscordConnection;
  assert.deepEqual(normalizeConnection(legacy).events, ['form.submitted']);
  assert.deepEqual(normalizeConnection(legacy).filters, { form_id: 'contact' });
  const all = { ...legacy, formId: '*' } as DiscordConnection;
  assert.deepEqual(getConnectionsForEvent([all], 'form.submitted', { type: 'form', id: 'any' }).map((c) => c.id), ['old']);
});

test('sending posts JSON and retries once when rate limited', async () => {
  const calls: RequestInit[] = [];
  const responses = [
    new Response(JSON.stringify({ retry_after: 0.01 }), { status: 429 }),
    new Response(null, { status: 204 }),
  ];
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    calls.push(init);
    return responses.shift()!;
  }) as typeof fetch;

  const result = await sendDiscordMessage(WEBHOOK, buildEventMessage(getSampleEvent('site.published'), SITE));
  assert.deepEqual(result, { success: true });
  assert.equal(calls.length, 2);
  assert.equal(JSON.parse(String(calls[0].body)).embeds[0].title, 'Site published');
});

test('a deleted webhook is reported, and other hosts are never called', async () => {
  let called = 0;
  globalThis.fetch = (async () => {
    called++;
    return new Response(JSON.stringify({ message: 'Unknown Webhook' }), { status: 404 });
  }) as typeof fetch;

  const message = buildEventMessage(getSampleEvent('site.published'), SITE);
  const deleted = await sendDiscordMessage(WEBHOOK, message);
  assert.equal(deleted.success, false);
  assert.match(deleted.error ?? '', /does not know this webhook/);

  const elsewhere = await sendDiscordMessage('https://example.com/hook', message);
  assert.equal(elsewhere.success, false);
  assert.equal(called, 1);
});
