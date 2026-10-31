import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Translation } from '@/types';
import { getTranslationValue } from './locale-runtime';

function translation(content_value: string, is_completed = false): Translation {
  return { content_value, is_completed } as Translation;
}

const EMPTY_DOC = '{"type":"doc","content":[{"type":"paragraph"}]}';
const TEXT_DOC = '{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"Hello"}]}]}';
const VARIABLE_DOC = '{"type":"doc","content":[{"type":"paragraph","content":[{"type":"dynamicVariable","attrs":{"id":"x"}}]}]}';

test('an empty rich-text translation falls back to the original text', () => {
  // The editor shows translations in progress; an empty one must not blank the text
  assert.equal(getTranslationValue(translation(EMPTY_DOC), { includeIncomplete: true }), undefined);
  assert.equal(getTranslationValue(translation(EMPTY_DOC, true)), undefined);
  assert.equal(getTranslationValue(translation('  ', true)), undefined);
});

test('translations with content are used', () => {
  assert.equal(getTranslationValue(translation(TEXT_DOC), { includeIncomplete: true }), TEXT_DOC);
  assert.equal(getTranslationValue(translation(TEXT_DOC, true)), TEXT_DOC);
  assert.equal(getTranslationValue(translation(VARIABLE_DOC, true)), VARIABLE_DOC);
  assert.equal(getTranslationValue(translation('about-us', true)), 'about-us');
  // Incomplete translations stay off the published site
  assert.equal(getTranslationValue(translation(TEXT_DOC)), undefined);
});
