import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Layer } from '@/types';
import { getLayerFromTemplate } from './blocks';
import { localizeTemplateTexts } from './localize';

function strings(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (value && typeof value === 'object') return Object.values(value).flatMap(strings);
  return [];
}

test('a form is inserted in Czech on a Czech site', () => {
  const form = localizeTemplateTexts(getLayerFromTemplate('form'), 'cs')!;
  const texts = strings(form);
  for (const czech of ['Jméno a příjmení', 'E-mail', 'Zpráva', 'Odeslat', 'Odesláno, děkujeme.']) {
    assert.ok(texts.includes(czech), czech);
  }
  for (const english of ['Full name', 'Submit', 'Successfully submitted.']) {
    assert.ok(!texts.includes(english), english);
  }
  // Settings and attributes that are not texts stay as they are
  assert.ok(texts.includes('POST'));
});

test('other languages keep the English texts', () => {
  const form = getLayerFromTemplate('form');
  assert.deepEqual(localizeTemplateTexts(form, 'en'), form);
  assert.deepEqual(localizeTemplateTexts(form, null), form);
  assert.ok(strings(localizeTemplateTexts(getLayerFromTemplate('form'), 'cs-CZ')).includes('Odeslat'));
});

test('only texts are translated, not names or settings with the same words', () => {
  const layer = {
    id: 'a',
    name: 'text',
    customName: 'Message',
    settings: { id: 'Search' },
    variables: { text: { type: 'dynamic_text', data: { content: 'Message' } } },
  } as unknown as Layer;
  const localized = localizeTemplateTexts(layer, 'cs') as any;
  assert.equal(localized.customName, 'Message');
  assert.equal(localized.settings.id, 'Search');
  assert.equal(localized.variables.text.data.content, 'Zpráva');
});
