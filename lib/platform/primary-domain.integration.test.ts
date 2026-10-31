/**
 * Integration tests for primary domains.
 *
 * Skipped unless PG_CLIENT_TEST_DATABASE_URL points to a database with the
 * platform schema (npm run migrate:postgres). Works on its own throwaway site.
 */
/* eslint-disable @typescript-eslint/no-require-imports */

import assert from 'node:assert/strict';
import Module from 'node:module';
import { after, before, test } from 'node:test';

import type { DnsLookup } from './domains';

// domains.ts reaches modules guarded by `server-only` through the auth setup
const originalLoad = (Module as any)._load;
(Module as any)._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'server-only') return {};
  return originalLoad.call(this, request, parent, isMain);
};

const DATABASE_URL = process.env.PG_CLIENT_TEST_DATABASE_URL;
if (DATABASE_URL) process.env.DATABASE_URL = DATABASE_URL;
process.env.PLATFORM_SITES_DOMAIN = 'sites.test';
process.env.PLATFORM_DOMAIN_IPV4 = '203.0.113.10';

const SITE = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const SLUG = 'primary-domain-test';
const HOME = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';
const HOME_SLUG = 'primary-home-test';

let ready = false;
let lib: {
  domains: typeof import('./domains');
  tenants: typeof import('./tenants');
  pool: import('pg').Pool;
};

/** DNS where every routed name points to the platform, except `unrouted` hosts */
const lookup: DnsLookup = {
  resolveTxt: async () => [],
  resolveCname: async (name) => (name.startsWith('unrouted') ? [] : [`${SLUG}.sites.test`]),
  resolve4: async (name) => (name.startsWith('unrouted') ? ['198.51.100.1'] : ['203.0.113.10']),
} as DnsLookup;

async function addVerified(hostname: string): Promise<string> {
  const { rows } = await lib.pool.query(
    `insert into platform.domains (tenant_id, hostname, verification_token, verified_at)
     values ($1, $2, 'token', now()) returning id`,
    [SITE, hostname],
  );
  return rows[0].id;
}

before(async () => {
  if (!DATABASE_URL) return;
  const { getPlatformPool } = require('./db') as typeof import('./db');
  const pool = getPlatformPool();
  const { rows } = await pool.query(`select to_regclass('platform.domains') as t`);
  if (!rows[0].t) return;

  lib = { domains: require('./domains'), tenants: require('./tenants'), pool };
  await pool.query('delete from platform.organization where id = any($1)', [[SITE, HOME]]);
  await pool.query(
    `insert into platform.organization (id, name, slug, "createdAt") values ($1, 'Primary test', $2, now()), ($3, 'Home', $4, now())`,
    [SITE, SLUG, HOME, HOME_SLUG],
  );
  ready = true;
});

after(async () => {
  if (!ready) return;
  await lib.pool.query('delete from platform.organization where id = any($1)', [[SITE, HOME]]);
  await lib.pool.end();
});

test('a site has no primary domain until one is set', { skip: !DATABASE_URL }, async (t) => {
  if (!ready) return t.skip('platform schema missing');
  await addVerified('www.primary-a.test');
  assert.equal(await lib.tenants.resolvePrimaryHost(SITE), null);
});

test('only a verified domain that points here can become primary', { skip: !DATABASE_URL }, async (t) => {
  if (!ready) return t.skip('platform schema missing');
  const { rows } = await lib.pool.query(
    `insert into platform.domains (tenant_id, hostname, verification_token) values ($1, 'pending.primary.test', 'token') returning id`,
    [SITE],
  );
  await assert.rejects(lib.domains.setPrimaryDomain(SITE, SLUG, rows[0].id, true, lookup), /Verify the domain/);

  const unrouted = await addVerified('unrouted.primary.test');
  await assert.rejects(lib.domains.setPrimaryDomain(SITE, SLUG, unrouted, true, lookup), /does not point to this site/);
});

test('making a domain primary replaces the previous one', { skip: !DATABASE_URL }, async (t) => {
  if (!ready) return t.skip('platform schema missing');
  const first = await addVerified('www.primary-b.test');
  const second = await addVerified('primary-b.test');

  const status = await lib.domains.setPrimaryDomain(SITE, SLUG, first, true, lookup);
  assert.equal(status.primary, true);
  assert.equal(await lib.tenants.resolvePrimaryHost(SITE), 'www.primary-b.test');

  await lib.domains.setPrimaryDomain(SITE, SLUG, second, true, lookup);
  assert.equal(await lib.tenants.resolvePrimaryHost(SITE), 'primary-b.test');
  const primaries = (await lib.domains.listDomains(SITE, SLUG)).filter((d) => d.primary).map((d) => d.hostname);
  assert.deepEqual(primaries, ['primary-b.test']);

  await lib.domains.setPrimaryDomain(SITE, SLUG, second, false, lookup);
  assert.equal(await lib.tenants.resolvePrimaryHost(SITE), null);
});

test('removing the primary domain stops the redirects', { skip: !DATABASE_URL }, async (t) => {
  if (!ready) return t.skip('platform schema missing');
  const id = await addVerified('primary-c.test');
  await lib.domains.setPrimaryDomain(SITE, SLUG, id, true, lookup);
  assert.equal(await lib.tenants.resolvePrimaryHost(SITE), 'primary-c.test');

  await lib.domains.removeDomain(SITE, id);
  assert.equal(await lib.tenants.resolvePrimaryHost(SITE), null);
});

test('the home site is served on the sites domain, which its other addresses redirect to', { skip: !DATABASE_URL }, async (t) => {
  if (!ready) return t.skip('platform schema missing');
  process.env.PLATFORM_HOME_SITE = HOME_SLUG;
  try {
    lib.tenants.forgetHostname('sites.test');
    lib.tenants.forgetHostname('www.sites.test');
    assert.equal(await lib.tenants.resolveTenantByHost('sites.test'), HOME);
    assert.equal(await lib.tenants.resolveTenantByHost('www.sites.test'), HOME);
    assert.equal(await lib.tenants.resolvePrimaryHost(HOME), 'sites.test');
    // Other sites are unaffected
    lib.tenants.forgetPrimaryHost(SITE);
    assert.equal(await lib.tenants.resolvePrimaryHost(SITE), null);
  } finally {
    delete process.env.PLATFORM_HOME_SITE;
    lib.tenants.forgetHostname('sites.test');
    lib.tenants.forgetPrimaryHost(HOME);
  }
  assert.equal(await lib.tenants.resolveTenantByHost('sites.test'), null);
});

test('a site shows the badge until a verified domain is primary', { skip: !DATABASE_URL }, async (t) => {
  if (!ready) return t.skip('platform schema missing');
  await lib.pool.query('delete from platform.domains where tenant_id = $1', [SITE]);
  lib.tenants.forgetSiteBadge(SITE);
  assert.equal(await lib.tenants.resolveSiteBadge(SITE), true);

  const { rows } = await lib.pool.query(
    `insert into platform.domains (tenant_id, hostname, verification_token) values ($1, 'badge.test', 'badge-token') returning id`,
    [SITE],
  );
  // An unverified domain does not count
  assert.equal(await lib.tenants.resolveSiteBadge(SITE), true);

  const txt: DnsLookup = {
    ...lookup,
    resolveTxt: async () => [[`ycode-verification=badge-token`]],
  } as DnsLookup;
  await lib.domains.verifyDomain(SITE, SLUG, rows[0].id, txt);
  // Verified but not primary: still on the free subdomain
  assert.equal(await lib.tenants.resolveSiteBadge(SITE), true);

  await lib.domains.setPrimaryDomain(SITE, SLUG, rows[0].id, true, lookup);
  assert.equal(await lib.tenants.resolveSiteBadge(SITE), false);

  await lib.domains.setPrimaryDomain(SITE, SLUG, rows[0].id, false, lookup);
  assert.equal(await lib.tenants.resolveSiteBadge(SITE), true);

  await lib.domains.setPrimaryDomain(SITE, SLUG, rows[0].id, true, lookup);
  await lib.domains.removeDomain(SITE, rows[0].id);
  assert.equal(await lib.tenants.resolveSiteBadge(SITE), true);
});

test('the home site never shows the badge', { skip: !DATABASE_URL }, async (t) => {
  if (!ready) return t.skip('platform schema missing');
  process.env.PLATFORM_HOME_SITE = HOME_SLUG;
  try {
    lib.tenants.forgetSiteBadge(HOME);
    assert.equal(await lib.tenants.resolveSiteBadge(HOME), false);
  } finally {
    delete process.env.PLATFORM_HOME_SITE;
    lib.tenants.forgetSiteBadge(HOME);
  }
});
