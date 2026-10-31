/**
 * Inlined Components in Layouts
 *
 * A few layouts carry a component inline: a layer marked with
 * `_inlinedComponentName` whose first child is the component's root, plus the
 * component's variables and this instance's overrides. Layouts are inserted as
 * plain layers instead (users can turn any part into a component themselves),
 * so each inlined instance is flattened the way it would render: the instance
 * layer merged with the component root, with the instance's values written
 * into the layers.
 */

import { applyComponentOverrides } from '@/lib/resolve-components';
import type { ComponentVariable, Layer } from '@/types';

type InlinedLayer = Layer & {
  _inlinedComponentName?: string;
  _inlinedComponentVariables?: ComponentVariable[];
};

/** Render-time markers that applyComponentOverrides leaves on layers */
const OVERRIDE_MARKERS = ['_textFromOverride', '_imageFromOverride'];
const MEDIA_VARIABLES = ['image', 'icon', 'video', 'audio'] as const;

/** Drop override markers and links to the (now gone) component's variables */
function cleanLayer(layer: Layer, variableIds: Set<string>): Layer {
  const cleaned = { ...layer } as Layer & Record<string, unknown>;
  for (const marker of OVERRIDE_MARKERS) delete cleaned[marker];

  if (cleaned.variables) {
    const variables = { ...cleaned.variables } as Record<string, any>;
    for (const key of MEDIA_VARIABLES) {
      const src = variables[key]?.src;
      if (src && typeof src === 'object' && variableIds.has(src.id)) {
        const { id: _linkedVariable, ...value } = src;
        variables[key] = { ...variables[key], src: value };
      }
    }
    cleaned.variables = variables as Layer['variables'];
  }

  if (cleaned.children) {
    cleaned.children = cleaned.children.map((child) => cleanLayer(child, variableIds));
  }
  return cleaned;
}

function flattenInstance(layer: InlinedLayer): Layer {
  const {
    _inlinedComponentName: _name,
    _inlinedComponentVariables: variables = [],
    componentOverrides: overrides,
    componentId: _componentId,
    componentVariantId: _variantId,
    ...instance
  } = layer;

  const root = layer.children?.[0];
  if (!root) return instance as Layer;

  const [resolvedRoot] = applyComponentOverrides([{ ...root, children: undefined }], overrides, variables);
  const children = applyComponentOverrides(root.children ?? [], overrides, variables);

  // The rendered instance keeps the instance layer's id; the root's own
  // interactions targeted the root, so they now target the instance layer
  const interactions = resolvedRoot.interactions?.map((interaction) => ({
    ...interaction,
    tweens: interaction.tweens.map((tween) => (
      tween.layer_id === root.id ? { ...tween, layer_id: layer.id } : tween
    )),
  }));

  const variableIds = new Set(variables.map((variable) => variable.id));
  return cleanLayer({
    ...instance,
    ...resolvedRoot,
    id: layer.id,
    ...(interactions ? { interactions } : {}),
    children: children.map(flattenInlinedComponents),
  } as Layer, variableIds);
}

/** Turn every inlined component instance in a layout's layer tree into plain layers */
export function flattenInlinedComponents(layer: Layer): Layer {
  if ((layer as InlinedLayer)._inlinedComponentName) {
    return flattenInstance(layer as InlinedLayer);
  }
  if (!layer.children?.length) return layer;
  return { ...layer, children: layer.children.map(flattenInlinedComponents) };
}
