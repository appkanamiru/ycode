import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Layer } from '@/types';
import { getLayoutTemplate } from './blocks';
import { flattenInlinedComponents } from './inlined-components';

const COMPONENT_KEYS = ['_inlinedComponentName', '_inlinedComponentVariables', 'componentOverrides', 'componentId', '_textFromOverride'];

function walk(layer: Layer, visit: (layer: Layer) => void): void {
  visit(layer);
  layer.children?.forEach((child) => walk(child, visit));
}

function texts(layer: Layer): string[] {
  const found: string[] = [];
  walk(layer, (node) => {
    const json = JSON.stringify(node.variables?.text ?? '');
    for (const match of json.matchAll(/"text":"([^"]+)"/g)) found.push(match[1]);
  });
  return found;
}

test('layouts with inlined components become plain layers', () => {
  for (const key of ['navigation-001', 'navigation-002', 'faq-001']) {
    const layout = flattenInlinedComponents(getLayoutTemplate(key)!);
    walk(layout, (node) => {
      for (const component of COMPONENT_KEYS) {
        assert.equal(component in node, false, `${key}: ${component} left on ${node.id}`);
      }
    });
  }
});

test('each FAQ item keeps its own question and answer', () => {
  const faq = flattenInlinedComponents(getLayoutTemplate('faq-001')!);
  const content = texts(faq);

  assert.ok(content.includes('What is Ycode?'), content.join(' | '));
  const questions = content.filter((text) => text.endsWith('?'));
  assert.ok(questions.length >= 3, `expected the items' own questions: ${questions.join(' | ')}`);
  assert.equal(new Set(questions).size, questions.length, 'questions are not all the same default');

  // No layer is left bound to the component's variables
  walk(faq, (node) => {
    assert.ok(!String((node.variables?.text as { id?: string } | undefined)?.id ?? '').startsWith('cpv-'), node.id);
  });
});

test('the flattened instance looks like the rendered one: instance id, root content', () => {
  const instance = {
    id: 'instance',
    name: 'div',
    customName: 'Item',
    _inlinedComponentName: 'Card',
    _inlinedComponentVariables: [{ id: 'cpv-title', name: 'Title', default_value: { type: 'dynamic_text', data: { content: 'Default' } } }],
    componentOverrides: { text: { 'cpv-title': { type: 'dynamic_text', data: { content: 'Mine' } } } },
    children: [{
      id: 'root',
      name: 'div',
      classes: 'card',
      interactions: [{ id: 'int', trigger: 'hover', tweens: [{ id: 'tw', layer_id: 'root' }] }],
      children: [{ id: 'title', name: 'text', variables: { text: { id: 'cpv-title', type: 'dynamic_text', data: { content: 'Default' } } } }],
    }],
  } as unknown as Layer;

  const page = flattenInlinedComponents({ id: 'section', name: 'section', children: [instance] } as Layer);
  const card = page.children![0] as Layer & { interactions: Array<{ tweens: Array<{ layer_id: string }> }> };

  assert.equal(card.id, 'instance');
  assert.equal(card.classes, 'card');
  assert.equal(card.interactions[0].tweens[0].layer_id, 'instance');
  assert.deepEqual(card.children![0].variables!.text, { type: 'dynamic_text', data: { content: 'Mine' } });
});
