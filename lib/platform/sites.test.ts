import assert from 'node:assert/strict';
import { test } from 'node:test';

import { slugifySiteName } from './browser-sites';
import { validateSiteSlug } from './sites';

test('valid site slugs', () => {
  for (const slug of ['petr-novak', 'abc', 'firma2026', 'a1b', 'x'.repeat(40)]) {
    assert.equal(validateSiteSlug(slug), null, slug);
  }
});

test('invalid site slugs', () => {
  for (const slug of ['ab', 'x'.repeat(41), 'Petr', 'petr_novak', '-petr', 'petr-', 'petr--novak', 'petr.novak', '', 42, null]) {
    assert.ok(validateSiteSlug(slug), String(slug));
  }
});

test('platform subdomains are reserved', () => {
  for (const slug of ['app', 'www', 'api', 'mail', 'admin']) {
    assert.equal(validateSiteSlug(slug), 'This address is reserved', slug);
  }
});

test('site names become subdomain suggestions', () => {
  assert.equal(slugifySiteName('Petr Novák'), 'petr-novak');
  assert.equal(slugifySiteName('  Kavárna Č. 1 & Co.  '), 'kavarna-c-1-co');
  assert.equal(slugifySiteName('Žluťoučký kůň'), 'zlutoucky-kun');
  assert.equal(slugifySiteName('---'), '');
  assert.equal(slugifySiteName('a'.repeat(39) + ' b'), 'a'.repeat(39));
});
