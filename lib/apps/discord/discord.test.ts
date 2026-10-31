import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import { buildFormSubmissionMessage, getConnectionsForForm, isDiscordWebhookUrl, sendDiscordMessage } from './index';
import { ALL_FORMS, type DiscordConnection } from './types';

const WEBHOOK = 'https://discord.com/api/webhooks/123456789/abc_DEF-123';
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

test('a submission becomes an embed with readable fields', () => {
  const message = buildFormSubmissionMessage({
    formId: 'contact',
    fields: { first_name: 'Jana', topics: ['web', 'app'], note: '  ', newsletter: true },
    siteName: 'Mizora',
    pageUrl: 'https://mizora.cz/kontakt',
    submissionsUrl: 'https://builder.example/ycode/forms',
    submittedAt: '2026-10-31T12:00:00.000Z',
  });
  const [embed] = message.embeds;
  assert.equal(embed.title, 'New submission: contact');
  assert.equal(embed.url, 'https://builder.example/ycode/forms');
  assert.deepEqual(embed.fields, [
    { name: 'First name', value: 'Jana' },
    { name: 'Topics', value: 'web, app' },
    { name: 'Note', value: '—' },
    { name: 'Newsletter', value: 'true' },
  ]);
  assert.equal(embed.footer?.text, 'Mizora · https://mizora.cz/kontakt');
  assert.equal(message.username, 'Mizora');
  assert.deepEqual(message.allowed_mentions, { parse: [] });
});

test('messages stay within Discord limits', () => {
  const fields = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`field_${i}`, 'x'.repeat(2000)]));
  const [embed] = buildFormSubmissionMessage({ formId: 'big', fields }).embeds;
  assert.ok(embed.fields.length <= 25);
  assert.ok(embed.fields.every((field) => field.value.length <= 1024));
  const total = embed.title.length + embed.fields.reduce((sum, f) => sum + f.name.length + f.value.length, 0)
    + (embed.footer?.text.length ?? 0);
  assert.ok(total <= 6000, `embed has ${total} characters`);
  assert.match(embed.footer?.text ?? '', /more field\(s\) in the editor/);
});

test('connections are picked by form, enabled ones only', () => {
  const connections: DiscordConnection[] = [
    { id: '1', name: 'all', webhookUrl: WEBHOOK, formId: ALL_FORMS, enabled: true },
    { id: '2', name: 'contact', webhookUrl: WEBHOOK, formId: 'contact', enabled: true },
    { id: '3', name: 'off', webhookUrl: WEBHOOK, formId: 'contact', enabled: false },
    { id: '4', name: 'other', webhookUrl: WEBHOOK, formId: 'newsletter', enabled: true },
  ];
  assert.deepEqual(getConnectionsForForm(connections, 'contact').map((c) => c.id), ['1', '2']);
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

  const result = await sendDiscordMessage(WEBHOOK, buildFormSubmissionMessage({ formId: 'contact', fields: { a: 1 } }));
  assert.deepEqual(result, { success: true });
  assert.equal(calls.length, 2);
  assert.equal(JSON.parse(String(calls[0].body)).embeds[0].title, 'New submission: contact');
});

test('a deleted webhook is reported, and other hosts are never called', async () => {
  let called = 0;
  globalThis.fetch = (async () => {
    called++;
    return new Response(JSON.stringify({ message: 'Unknown Webhook' }), { status: 404 });
  }) as typeof fetch;

  const deleted = await sendDiscordMessage(WEBHOOK, buildFormSubmissionMessage({ formId: 'f', fields: {} }));
  assert.equal(deleted.success, false);
  assert.match(deleted.error ?? '', /does not know this webhook/);

  const elsewhere = await sendDiscordMessage('https://example.com/hook', buildFormSubmissionMessage({ formId: 'f', fields: {} }));
  assert.equal(elsewhere.success, false);
  assert.equal(called, 1);
});
