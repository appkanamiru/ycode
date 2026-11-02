import assert from 'node:assert/strict';
import { test } from 'node:test';

import { getNewCollectionFields } from './collection-field-utils';

test('a new collection starts with the built-in fields in editor order', () => {
  const fields = getNewCollectionFields();
  assert.deepEqual(fields.map((f) => f.key), ['id', 'status', 'name', 'slug', 'created_at', 'updated_at']);
  assert.deepEqual(fields.map((f) => f.order), [0, 1, 2, 3, 4, 5]);
});

test('only name and slug of the built-in fields are fillable', () => {
  const fillable = getNewCollectionFields().filter((f) => f.fillable).map((f) => f.key);
  assert.deepEqual(fillable, ['name', 'slug']);
});

test('each call returns fresh field objects', () => {
  const [first] = getNewCollectionFields();
  first.name = 'Changed';
  assert.equal(getNewCollectionFields()[0].name, 'ID');
});
