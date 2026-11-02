import assert from 'node:assert/strict';
import { test } from 'node:test';

import { applyCustomAttributes, applyCustomAttributesToHtml } from './layer-utils';

test('appends custom attributes with escaped values', () => {
  const { attrs } = applyCustomAttributesToHtml(['data-layer-id="box"'], { 'data-test': '1', 'aria-label': 'Box "one"' });

  assert.deepEqual(attrs, ['data-layer-id="box"', 'data-test="1"', 'aria-label="Box &quot;one&quot;"']);
});

test('replaces same-named attributes, including bare ones', () => {
  const { attrs } = applyCustomAttributesToHtml(['id="original"', 'class="p-4"', 'allowfullscreen'], {
    ID: 'custom',
    allowfullscreen: 'false',
  });

  assert.deepEqual(attrs, ['class="p-4"', 'ID="custom"', 'allowfullscreen="false"']);
});

test('returns a custom style for merging instead of a second style attribute', () => {
  const { attrs, styles } = applyCustomAttributesToHtml([], { style: 'pointer-events: none; --tint: red' });

  assert.deepEqual(attrs, []);
  assert.deepEqual(styles, { pointerEvents: 'none', '--tint': 'red' });
});

test('adds a custom class to the layer classes instead of replacing them', () => {
  const { attrs } = applyCustomAttributesToHtml(['class="p-4 border-b"', 'id="a"'], { class: 'article-body "x"' });

  assert.deepEqual(attrs, ['id="a"', 'class="p-4 border-b article-body &quot;x&quot;"']);
});

test('sets a custom class on a layer without classes', () => {
  assert.deepEqual(applyCustomAttributesToHtml([], { CLASS: 'prose' }).attrs, ['class="prose"']);
});

test('adds a custom class to the React className', () => {
  const props: Record<string, unknown> = { className: 'p-4 border-b' };
  applyCustomAttributes(props, { class: 'article-body', 'data-x': '1' });

  assert.deepEqual(props, { className: 'p-4 border-b article-body', 'data-x': '1' });
});

test('skips attribute names that would break the markup', () => {
  const { attrs } = applyCustomAttributesToHtml([], { 'onload="x" a': '1', 'a>b': '1', 'data-ok': '2' });

  assert.deepEqual(attrs, ['data-ok="2"']);
});

test('does not mutate the input array', () => {
  const input = ['id="a"'];
  applyCustomAttributesToHtml(input, { id: 'b' });

  assert.deepEqual(input, ['id="a"']);
});
