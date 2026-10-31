import assert from 'node:assert/strict';
import { test } from 'node:test';

import { slugifySiteName } from './browser-sites';
import { hasOwnAddress, validateSiteSlug } from './sites';

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
  for (const slug of ['app', 'builder', 'www', 'api', 'mail', 'admin']) {
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

test('a site has its own address with a primary domain, or as the home site', () => {
  const homeSite = process.env.PLATFORM_HOME_SITE;
  process.env.PLATFORM_HOME_SITE = 'platform-home';
  try {
    assert.equal(hasOwnAddress('petr-novak', null), false);
    assert.equal(hasOwnAddress('petr-novak', 'petr-novak.cz'), true);
    assert.equal(hasOwnAddress('platform-home', null), true);
  } finally {
    if (homeSite === undefined) delete process.env.PLATFORM_HOME_SITE;
    else process.env.PLATFORM_HOME_SITE = homeSite;
  }
});
