import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseColumnPath, parseOrFilter, parseSelect, splitTopLevel } from './postgrest-syntax';

test('select lists with embedded resources', () => {
  assert.deepEqual(parseSelect('id, content_hash, page_folder_id, page_layers!inner(content_hash)'), [
    { type: 'column', name: 'id' },
    { type: 'column', name: 'content_hash' },
    { type: 'column', name: 'page_folder_id' },
    { type: 'embed', relation: 'page_layers', inner: true, items: [{ type: 'column', name: 'content_hash' }] },
  ]);
  assert.deepEqual(parseSelect('*'), [{ type: 'star' }]);
  assert.deepEqual(parseSelect('*, collection_fields(*)')[1], {
    type: 'embed', relation: 'collection_fields', inner: false, items: [{ type: 'star' }],
  });
});

test('unsupported select syntax throws', () => {
  assert.throws(() => parseSelect('title:name'));
  assert.throws(() => parseSelect('id::text'));
  assert.throws(() => parseSelect('a!inner(b!inner(c))'));
});

test('or filters with nested groups', () => {
  assert.deepEqual(
    parseOrFilter('refresh_expires_at.lt.2024-01-01T00:00:00Z,and(is_active.eq.false,refresh_grace_until.lt.2024-01-01T00:00:00Z)'),
    {
      type: 'or',
      negate: false,
      conditions: [
        { type: 'filter', column: 'refresh_expires_at', operator: 'lt', value: '2024-01-01T00:00:00Z', negate: false },
        {
          type: 'and',
          negate: false,
          conditions: [
            { type: 'filter', column: 'is_active', operator: 'eq', value: 'false', negate: false },
            { type: 'filter', column: 'refresh_grace_until', operator: 'lt', value: '2024-01-01T00:00:00Z', negate: false },
          ],
        },
      ],
    },
  );
});

test('or filters with is, in, negation and quoted like patterns', () => {
  const { conditions } = parseOrFilter('asset_folder_id.is.null,asset_folder_id.in.(a,"b,c"),content_hash.not.eq.x,value.like.%"id-1"%');
  assert.deepEqual(conditions, [
    { type: 'filter', column: 'asset_folder_id', operator: 'is', value: null, negate: false },
    { type: 'filter', column: 'asset_folder_id', operator: 'in', value: ['a', 'b,c'], negate: false },
    { type: 'filter', column: 'content_hash', operator: 'eq', value: 'x', negate: true },
    { type: 'filter', column: 'value', operator: 'like', value: '%"id-1"%', negate: false },
  ]);
});

test('values may contain dots', () => {
  const { conditions } = parseOrFilter('version.eq.1.2.3');
  assert.deepEqual(conditions[0], { type: 'filter', column: 'version', operator: 'eq', value: '1.2.3', negate: false });
});

test('unbalanced input throws', () => {
  assert.throws(() => splitTopLevel('a,(b'));
  assert.throws(() => parseOrFilter('a.cs.{1}'));
});

test('JSON column paths', () => {
  assert.deepEqual(parseColumnPath('metadata->>ip'), { column: 'metadata', json: [{ arrow: '->>', key: 'ip' }] });
  assert.deepEqual(parseColumnPath('settings->seo->>title'), {
    column: 'settings',
    json: [{ arrow: '->', key: 'seo' }, { arrow: '->>', key: 'title' }],
  });
  assert.throws(() => parseColumnPath('bad column'));
});
