import assert from 'node:assert/strict';
import { test } from 'node:test';

import { getUmamiConfig, isPlatformAdmin } from './config';

function withEnv(values: Record<string, string | undefined>, fn: () => void): void {
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('platform admins are listed by email, case-insensitively', () => {
  withEnv({ PLATFORM_ADMIN_EMAILS: ' Admin@Example.com , other@example.com' }, () => {
    assert.equal(isPlatformAdmin('admin@example.com'), true);
    assert.equal(isPlatformAdmin('OTHER@example.com'), true);
    assert.equal(isPlatformAdmin('someone@example.com'), false);
    assert.equal(isPlatformAdmin(null), false);
  });
  withEnv({ PLATFORM_ADMIN_EMAILS: undefined }, () => {
    assert.equal(isPlatformAdmin('admin@example.com'), false);
  });
});

test('statistics need the Umami address, public address and admin password', () => {
  withEnv({ UMAMI_URL: 'http://umami:3000/', UMAMI_PUBLIC_URL: 'https://stats.example.com', UMAMI_ADMIN_PASSWORD: 'secret' }, () => {
    assert.deepEqual(getUmamiConfig(), { url: 'http://umami:3000', publicUrl: 'https://stats.example.com', adminPassword: 'secret' });
  });
  withEnv({ UMAMI_URL: 'http://umami:3000', UMAMI_PUBLIC_URL: 'https://stats.example.com', UMAMI_ADMIN_PASSWORD: undefined }, () => {
    assert.equal(getUmamiConfig(), null);
  });
});
