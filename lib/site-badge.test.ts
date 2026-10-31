import assert from 'node:assert/strict';
import { test } from 'node:test';

import { shouldShowSiteBadge } from './site-badge';

test('a single site follows its badge setting, shown by default', async () => {
  const multiTenant = process.env.YCODE_MULTI_TENANT;
  delete process.env.YCODE_MULTI_TENANT;
  try {
    assert.equal(await shouldShowSiteBadge(undefined), true);
    assert.equal(await shouldShowSiteBadge(null), true);
    assert.equal(await shouldShowSiteBadge(true), true);
    assert.equal(await shouldShowSiteBadge(false), false);
  } finally {
    if (multiTenant !== undefined) process.env.YCODE_MULTI_TENANT = multiTenant;
  }
});
