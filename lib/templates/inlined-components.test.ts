import assert from 'node:assert/strict';
import { test } from 'node:test';

import { assignInlinedComponentNames, getInlinedComponentName } from './inlined-components';

const inlined = (name: string, text: string, id: string) => ({
  id,
  name: 'div',
  _inlinedComponentName: name,
  children: [{ id: `${id}-text`, name: 'text', content: text }],
});

test('different components with the same name get distinct names', () => {
  const names = assignInlinedComponentNames({
    'nav-b': { template: { id: 's2', name: 'section', children: [inlined('Navigation', 'Centered', 'b')] } },
    'nav-a': { template: { id: 's1', name: 'section', children: [inlined('Navigation', 'Left', 'a')] } },
    'nav-c': { template: { id: 's3', name: 'section', children: [inlined('Navigation', 'Split', 'c')] } },
  });

  assert.equal(names.get('nav-a')!.get('Navigation'), 'Navigation');
  assert.equal(names.get('nav-b')!.get('Navigation'), 'Navigation 2');
  assert.equal(names.get('nav-c')!.get('Navigation'), 'Navigation 3');
});

test('identical components keep sharing one name, whatever their template ids', () => {
  const names = assignInlinedComponentNames({
    'hero-a': { template: { id: 'x', name: 'section', children: [inlined('Button', 'Buy', 'a1')] } },
    'hero-b': { template: { id: 'y', name: 'section', children: [inlined('Button', 'Buy', 'b1')] } },
    faq: { template: { id: 'z', name: 'section', children: [inlined('FAQ', 'Q', 'f1'), inlined('FAQ', 'Q', 'f2')] } },
  });

  assert.equal(names.get('hero-a')!.get('Button'), 'Button');
  assert.equal(names.get('hero-b')!.get('Button'), 'Button');
  assert.equal(names.get('faq')!.get('FAQ'), 'FAQ');
});

test('the built-in navigation layouts no longer collide', () => {
  assert.equal(getInlinedComponentName('navigation-001', 'Navigation'), 'Navigation');
  assert.equal(getInlinedComponentName('navigation-002', 'Navigation'), 'Navigation 2');
  assert.equal(getInlinedComponentName('faq-001', 'FAQ'), 'FAQ');
  assert.equal(getInlinedComponentName('unknown-layout', 'Anything'), 'Anything');
});
