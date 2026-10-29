/**
 * Inlined Components in Layouts
 *
 * A layout can carry a component inline (`_inlinedComponentName` plus its
 * layers). Inserting the layout reuses the site's component with that name,
 * or creates it — so a navigation stays one shared component across pages.
 *
 * Different layouts may inline different components under the same name
 * (e.g. two navigation designs both called "Navigation"). Matching by name
 * alone would then insert the first design for the second layout, so names
 * are made unique per distinct component: later ones (by layout key) become
 * "Navigation 2", "Navigation 3"... Layouts whose inlined components are
 * identical keep sharing one name.
 */

import { layoutTemplates } from './layouts';

type TemplateNode = Record<string, unknown> & { children?: TemplateNode[] };

/** Component content without ids, which are placeholders in templates */
function fingerprint(node: TemplateNode): string {
  return JSON.stringify(node.children ?? [], (key, value) => (key === 'id' ? undefined : value));
}

function collectInlined(node: TemplateNode, found: Array<{ name: string; fingerprint: string }>): void {
  if (typeof node._inlinedComponentName === 'string') {
    found.push({ name: node._inlinedComponentName, fingerprint: fingerprint(node) });
    return;
  }
  node.children?.forEach((child) => collectInlined(child, found));
}

/**
 * Map of `layoutKey` -> (inlined name -> component name to use on the site).
 */
export function assignInlinedComponentNames(
  templates: Record<string, { template: unknown }>,
): Map<string, Map<string, string>> {
  // name -> distinct fingerprints, in layout key order
  const variants = new Map<string, string[]>();
  const perLayout = new Map<string, Array<{ name: string; fingerprint: string }>>();

  for (const layoutKey of Object.keys(templates).sort()) {
    const found: Array<{ name: string; fingerprint: string }> = [];
    collectInlined(templates[layoutKey].template as TemplateNode, found);
    perLayout.set(layoutKey, found);

    for (const { name, fingerprint: print } of found) {
      const known = variants.get(name) ?? [];
      if (!known.includes(print)) known.push(print);
      variants.set(name, known);
    }
  }

  const names = new Map<string, Map<string, string>>();
  for (const [layoutKey, found] of perLayout) {
    const layoutNames = new Map<string, string>();
    for (const { name, fingerprint: print } of found) {
      const index = variants.get(name)!.indexOf(print);
      layoutNames.set(name, index === 0 ? name : `${name} ${index + 1}`);
    }
    names.set(layoutKey, layoutNames);
  }
  return names;
}

let libraryNames: Map<string, Map<string, string>> | null = null;

/** Site component name for a component inlined in one of the built-in layouts */
export function getInlinedComponentName(layoutKey: string, inlinedName: string): string {
  libraryNames ??= assignInlinedComponentNames(layoutTemplates);
  return libraryNames.get(layoutKey)?.get(inlinedName) ?? inlinedName;
}
