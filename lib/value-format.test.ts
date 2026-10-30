import assert from 'node:assert/strict';
import { test } from 'node:test';

import { formatFieldValue } from './cms-variables-utils';
import { formatDateFieldsInItemValues, formatDateInTimezone, formatDateOnly } from './date-format-utils';
import {
  DATE_FORMAT_SECTIONS,
  formatDateWithPreset,
  formatNumberWithPreset,
  getDateFormatPreview,
  NUMBER_FORMAT_SECTIONS,
} from './variable-format-utils';
import { resolveFormatLocale, toIntlLocale } from './value-format';
import type { CollectionField } from '@/types';

/** Intl separates some parts with (narrow) no-break spaces */
const plain = (text: string) => text.replace(/[\u00a0\u202f]/g, ' ');

const DATE = '2026-03-26T08:38:00.000Z';
const TZ = 'Europe/Prague';

test('locale codes become Intl locales, invalid ones fall back to English', () => {
  assert.equal(toIntlLocale('cs'), 'cs');
  assert.equal(toIntlLocale('zh-cn'), 'zh-CN');
  assert.equal(toIntlLocale(''), 'en-US');
  assert.equal(toIntlLocale(null), 'en-US');
  assert.equal(toIntlLocale('not a locale!'), 'en-US');
});

test('the page locale wins, else the default locale', () => {
  const locales = [{ code: 'en', is_default: false }, { code: 'cs', is_default: true }];
  assert.equal(resolveFormatLocale({ code: 'en' }, locales), 'en');
  assert.equal(resolveFormatLocale(null, locales), 'cs');
  assert.equal(resolveFormatLocale(null, []), undefined);
});

test('date presets follow the locale', () => {
  assert.equal(formatDateWithPreset(DATE, 'date-long', TZ, 'cs'), '26. března 2026');
  assert.equal(formatDateWithPreset(DATE, 'part-month-long', TZ, 'cs'), 'březen');
  assert.equal(formatDateWithPreset(DATE, 'date-long', TZ, 'en'), 'March 26, 2026');
});

test('without a locale the output is the English one, as before', () => {
  assert.equal(formatDateWithPreset(DATE, 'date-long', TZ), 'March 26, 2026');
  assert.equal(formatDateWithPreset(DATE, 'date-long', TZ, 'not a locale!'), 'March 26, 2026');
  assert.equal(plain(formatDateWithPreset(DATE, 'datetime-long', TZ)), 'March 26, 2026 at 9:38 AM');
  assert.equal(formatNumberWithPreset(12345, 'number-decimal'), '12,345.00');
  assert.equal(formatDateInTimezone(DATE, TZ, 'display'), formatDateInTimezone(DATE, TZ, 'display', undefined));
});

test('presets with a fixed pattern ignore the locale', () => {
  for (const id of ['date-us', 'date-eu', 'date-eu-dot', 'date-iso']) {
    assert.equal(formatDateWithPreset(DATE, id, TZ, 'cs'), formatDateWithPreset(DATE, id, TZ), id);
  }
});

test('number presets follow the locale', () => {
  assert.equal(plain(formatNumberWithPreset(12345, 'number-decimal', 'cs')), '12 345,00');
  assert.equal(formatNumberWithPreset(12345, 'number-plain', 'cs'), '12345');
});

test('date_only values keep their calendar day in any locale', () => {
  assert.equal(formatDateWithPreset('2026-03-26', 'date-long', 'America/Los_Angeles', 'cs'), '26. března 2026');
  assert.equal(plain(formatDateOnly('2026-03-26', 'cs')), '26. 3. 2026');
});

test('formatFieldValue passes the locale to dates and numbers', () => {
  assert.equal(formatFieldValue(DATE, 'date', TZ, 'date-long', 'cs'), '26. března 2026');
  assert.equal(plain(formatFieldValue(12345, 'number', TZ, 'number-decimal', 'cs')), '12 345,00');
  assert.equal(plain(formatFieldValue(DATE, 'date', TZ, undefined, 'cs')), '26. 3. 2026 09:38');
  assert.equal(formatFieldValue(DATE, 'date', TZ, 'date-long'), 'March 26, 2026');
});

test('pre-formatted item values stay English, since they are parsed again', () => {
  const fields = [{ id: 'f', type: 'date' }] as CollectionField[];
  const formatted = formatDateFieldsInItemValues({ f: DATE }, fields, TZ);
  assert.ok(!Number.isNaN(Date.parse(formatted.f)), formatted.f);
});

test('format previews follow the locale', () => {
  const dateLong = DATE_FORMAT_SECTIONS.flatMap((section) => section.presets).find((preset) => preset.id === 'date-long')!;
  assert.equal(getDateFormatPreview(dateLong, 'cs'), '7. dubna 2026');
  assert.equal(getDateFormatPreview(dateLong), 'April 7, 2026');
  assert.ok(NUMBER_FORMAT_SECTIONS.length > 0);
});
