/* eslint-disable @typescript-eslint/no-require-imports */
import assert from 'node:assert/strict';
import Module from 'node:module';
import { test } from 'node:test';

// domains.ts reaches modules guarded by `server-only` through the auth setup
const originalLoad = (Module as any)._load;
(Module as any)._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'server-only') return {};
  return originalLoad.call(this, request, parent, isMain);
};

process.env.PLATFORM_SITES_DOMAIN = 'appkanamiru.cz';
process.env.BETTER_AUTH_URL = 'https://app.example.org';

const { normalizeCustomHostname } = require('./domains') as typeof import('./domains');

test('custom domains are normalized', () => {
  assert.equal(normalizeCustomHostname('www.Example.com'), 'www.example.com');
  assert.equal(normalizeCustomHostname(' https://example.com/about?x=1 '), 'example.com');
  assert.equal(normalizeCustomHostname('example.com.'), 'example.com');
  assert.equal(normalizeCustomHostname('kavárna.cz'), 'xn--kavrna-rta.cz');
});

test('invalid custom domains are rejected', () => {
  for (const input of ['', 'localhost', 'example', 'exa mple.com', '-bad.com', 'example.com:8080', '192.168.0.1', 'a'.repeat(64) + '.com', 42]) {
    assert.throws(() => normalizeCustomHostname(input), String(input));
  }
});

test('platform domains cannot be claimed', () => {
  assert.throws(() => normalizeCustomHostname('appkanamiru.cz'), /assigned to sites automatically/);
  assert.throws(() => normalizeCustomHostname('someone-else.appkanamiru.cz'), /assigned to sites automatically/);
  assert.throws(() => normalizeCustomHostname('app.example.org'), /reserved/);
});
