/**
 * LCP webfont preloading.
 *
 * Google Fonts CSS is inlined at render time, but the browser still only
 * discovers the woff2 it needs once it has built the render tree and matched
 * text against `@font-face` rules — after the HTML and CSS have been parsed.
 * For a text-LCP page (hero H1) that discovery gap sits directly on the
 * critical path: the heading paints in a fallback face (or not at all) until
 * the font arrives.
 *
 * These helpers pick the font the likely LCP text renders in and resolve it
 * to the single latin-subset `@font-face` URL so `PageRenderer` / the static
 * export can emit `<link rel="preload" as="font">` from `<head>`.
 */

import type { FontPreload } from '@/lib/font-utils';
import type { Layer } from '@/types';

// Text inside these ancestors is chrome (menus, logos, legal) — never the LCP.
const NON_LCP_ANCESTOR_NAMES = new Set(['header', 'footer', 'nav']);

const HEADING_TAGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6']);

const NAMED_WEIGHTS: Record<string, number> = {
  thin: 100,
  extralight: 200,
  light: 300,
  normal: 400,
  medium: 500,
  semibold: 600,
  bold: 700,
  extrabold: 800,
  black: 900,
};

// Tailwind's built-in stacks. Selecting one of these on a layer overrides an
// inherited Google family, so they must reset `family` rather than be ignored.
const BUILT_IN_FAMILIES = new Set(['sans', 'serif', 'mono']);

/** Unicode-range prefix Google uses for the basic-latin subset. */
const LATIN_RANGE = 'U+0000-00FF';

export interface TextFont {
  /** Font family as written in CSS (e.g. "Plus Jakarta Sans"); null when unset. */
  family: string | null;
  /** Numeric weight; null when unset. */
  weight: number | null;
}

export interface LcpTextFont {
  family: string;
  weight: number;
}

/** Parsed `@font-face` rule from Google's CSS response. */
export interface FontFaceRule {
  family: string;
  style: string;
  weightMin: number;
  weightMax: number;
  src: string;
  format: string | null;
  unicodeRange: string | null;
}

/** True when a class carries a breakpoint or state variant (`md:`, `hover:`). */
function hasVariantPrefix(cls: string): boolean {
  const bracket = cls.indexOf('[');
  const head = bracket === -1 ? cls : cls.slice(0, bracket);
  return head.includes(':');
}

function splitClasses(classes: string | string[] | undefined): string[] {
  if (!classes) return [];
  return Array.isArray(classes) ? classes : classes.split(/\s+/);
}

/**
 * Read font family and weight from a layer's compiled classes.
 *
 * Recognises `font-[Plus_Jakarta_Sans]` and `font-['Plus_Jakarta_Sans']`
 * (family, underscores → spaces),
 * `font-sans|serif|mono` (built-in family), `font-[700]` (numeric weight) and
 * the named weights (`font-bold`). Only desktop (unprefixed) classes count.
 * Later classes win, matching how the builder de-duplicates conflicting
 * utilities.
 */
export function getTextFontFromClasses(classes: string | string[] | undefined): TextFont {
  let family: string | null = null;
  let weight: number | null = null;

  for (const cls of splitClasses(classes)) {
    if (!cls.startsWith('font-') || hasVariantPrefix(cls)) continue;
    const value = cls.slice(5);

    if (value.startsWith('[') && value.endsWith(']')) {
      const inner = value.slice(1, -1);
      if (/^\d/.test(inner)) {
        const n = parseInt(inner, 10);
        if (!isNaN(n)) weight = n;
      } else if (inner) {
        // `font-['IBM_Plex_Mono']` (quoted, as HTML import writes it) names the same family
        family = inner.replace(/^(['"])(.*)\1$/, '$2').replace(/_/g, ' ');
      }
      continue;
    }

    if (BUILT_IN_FAMILIES.has(value)) {
      family = value;
      continue;
    }

    const named = NAMED_WEIGHTS[value];
    if (named !== undefined) weight = named;
  }

  return { family, weight };
}

function cascade(inherited: TextFont, own: TextFont): TextFont {
  return {
    family: own.family ?? inherited.family,
    weight: own.weight ?? inherited.weight,
  };
}

function getTag(layer: Layer): string {
  if (layer.settings?.tag) return String(layer.settings.tag);
  if (layer.name === 'heading') return 'h2';
  if (layer.name === 'text') return 'p';
  return layer.name;
}

type TextKind = 'h1' | 'heading' | 'text';

function classifyText(layer: Layer): TextKind | null {
  if (layer.name !== 'text' && layer.name !== 'heading' && layer.name !== 'richText') return null;
  const tag = getTag(layer);
  if (tag === 'h1') return 'h1';
  if (HEADING_TAGS.has(tag)) return 'heading';
  return 'text';
}

/**
 * Find the font the page's likely LCP text renders in.
 *
 * Walks the tree in render order, cascading `font-*` classes from ancestors
 * the way the browser inherits `font-family` / `font-weight`, and skips text
 * under header / nav / footer. Preference order: first `<h1>`, then the first
 * other heading, then the first paragraph — the largest text on a page is
 * almost always its first heading.
 *
 * `bodyClasses` seeds the cascade (the `body` layer is usually extracted
 * before the tree reaches the renderer). Weight defaults to 400 because
 * Tailwind's preflight resets headings to `font-weight: inherit`.
 *
 * Returns null when the chosen text has no explicit Google/custom family —
 * built-in stacks (`font-sans`) never need a preload.
 */
export function findLcpTextFont(layers: Layer[], bodyClasses?: string | string[]): LcpTextFont | null {
  const found: Partial<Record<TextKind, TextFont>> = {};

  const visit = (layer: Layer, inherited: TextFont, inChrome: boolean): boolean => {
    if (layer.hidden) return false;
    const chrome = inChrome || NON_LCP_ANCESTOR_NAMES.has(layer.name);
    const font = cascade(inherited, getTextFontFromClasses(layer.classes));

    if (!chrome) {
      const kind = classifyText(layer);
      if (kind && !found[kind]) {
        found[kind] = font;
        if (kind === 'h1') return true;
      }
    }

    for (const child of layer.children ?? []) {
      if (visit(child, font, chrome)) return true;
    }
    return false;
  };

  const root: TextFont = { family: null, weight: null };
  const seeded = cascade(root, getTextFontFromClasses(bodyClasses));
  for (const layer of layers) {
    if (visit(layer, seeded, false)) break;
  }

  const pick = found.h1 ?? found.heading ?? found.text;
  if (!pick?.family || BUILT_IN_FAMILIES.has(pick.family)) return null;

  return { family: pick.family, weight: pick.weight ?? 400 };
}

function readDeclaration(block: string, property: string): string | null {
  const match = block.match(new RegExp(`${property}\\s*:\\s*([^;]+);`, 'i'));
  return match ? match[1].trim() : null;
}

function stripQuotes(value: string): string {
  return value.replace(/^['"]|['"]$/g, '');
}

/**
 * Parse `@font-face` rules out of a Google Fonts CSS response. Tolerates the
 * variable-font weight range form (`font-weight: 200 800`) and multiple
 * `src` candidates (first `url(...)` wins).
 */
export function parseFontFaceRules(css: string): FontFaceRule[] {
  const rules: FontFaceRule[] = [];
  const blockRe = /@font-face\s*\{([^}]*)\}/gi;
  let match: RegExpExecArray | null;

  while ((match = blockRe.exec(css)) !== null) {
    const block = match[1];
    const family = readDeclaration(block, 'font-family');
    const src = readDeclaration(block, 'src');
    if (!family || !src) continue;

    const url = src.match(/url\(\s*['"]?([^'")]+)['"]?\s*\)/i);
    if (!url) continue;
    const format = src.match(/format\(\s*['"]?([^'")]+)['"]?\s*\)/i);

    const weightRaw = readDeclaration(block, 'font-weight') ?? '400';
    const weights = weightRaw.split(/\s+/).map((w) => parseInt(w, 10)).filter((w) => !isNaN(w));
    const weightMin = weights[0] ?? 400;
    const weightMax = weights[1] ?? weightMin;

    rules.push({
      family: stripQuotes(family),
      style: readDeclaration(block, 'font-style') ?? 'normal',
      weightMin,
      weightMax,
      src: url[1],
      format: format ? format[1] : null,
      unicodeRange: readDeclaration(block, 'unicode-range'),
    });
  }

  return rules;
}

function formatToMimeType(format: string | null): string {
  switch ((format || 'woff2').toLowerCase()) {
    case 'woff': return 'font/woff';
    case 'truetype': return 'font/ttf';
    case 'opentype': return 'font/otf';
    default: return 'font/woff2';
  }
}

/**
 * Resolve the LCP text font to the one latin-subset file worth preloading.
 *
 * Matches on family (case-insensitive), upright style and a weight that falls
 * inside the rule's range, then keeps only the basic-latin subset — Google
 * splits each face into ~8 `unicode-range` files and preloading all of them
 * would waste bandwidth on glyphs the page never renders. Rules without a
 * `unicode-range` (single-file faces) also qualify.
 *
 * Returns at most one preload; an empty array when nothing matches.
 */
export function getLcpFontPreloads(css: string, target: LcpTextFont | null): FontPreload[] {
  if (!css || !target) return [];
  const family = target.family.toLowerCase();

  const rule = parseFontFaceRules(css).find((r) =>
    r.family.toLowerCase() === family
    && r.style.toLowerCase() === 'normal'
    && target.weight >= r.weightMin
    && target.weight <= r.weightMax
    && (!r.unicodeRange || r.unicodeRange.toUpperCase().includes(LATIN_RANGE)),
  );

  if (!rule) return [];
  return [{ href: rule.src, type: formatToMimeType(rule.format) }];
}
