import assert from 'node:assert/strict';
import { test } from 'node:test';

import { getFieldFormatError } from './field-binding-core';
import type { CollectionField, CollectionFieldType } from '@/types';

const field = (type: CollectionFieldType) => ({ id: 'f1', name: 'Published', type }) as CollectionField;

test('accepts a missing format and preset ids that fit the field type', () => {
  assert.equal(getFieldFormatError(field('date_only'), undefined), null);
  assert.equal(getFieldFormatError(field('date_only'), 'date-short'), null);
  assert.equal(getFieldFormatError(field('date'), 'datetime-24h'), null);
  assert.equal(getFieldFormatError(field('number'), 'number-decimal'), null);
});

test('rejects a custom pattern and lists the presets of the field type', () => {
  const error = getFieldFormatError(field('date_only'), 'd. M. yyyy');
  assert.match(error ?? '', /Unknown format "d\. M\. yyyy" for date_only field "Published"/);
  assert.match(error ?? '', /date-short → [A-Z][a-z]{2} \d{1,2}, \d{4}/);
  assert.doesNotMatch(error ?? '', /number-decimal/);
});

test('shows the example output in the site language', () => {
  const error = getFieldFormatError(field('date_only'), 'd. M. yyyy', 'cs') ?? '';
  assert.match(error, /date-short → \d{1,2}\. \d{1,2}\. \d{4}/);
  assert.match(error, /date-eu-dot → \d{2}\.\d{2}\.\d{4}/);
  assert.match(getFieldFormatError(field('number'), 'x', 'cs') ?? '', /number-decimal → 12\s345,00/);
});

test('rejects a preset of another field type', () => {
  assert.match(getFieldFormatError(field('number'), 'date-long') ?? '', /number-integer/);
});

test('rejects any format on a field without formats', () => {
  assert.match(getFieldFormatError(field('text'), 'date-long') ?? '', /takes no format/);
});
