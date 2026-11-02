import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Layer } from '@/types';
import {
  findLcpTextFont,
  getLcpFontPreloads,
  getTextFontFromClasses,
  parseFontFaceRules,
} from '@/lib/font-preload';

function layer(name: string, classes: string, extra: Partial<Layer> = {}): Layer {
  return { id: `${name}-${Math.random().toString(36).slice(2, 7)}`, name, classes, ...extra } as Layer;
}

function text(tag: string, classes = '', extra: Partial<Layer> = {}): Layer {
  return layer('text', classes, { settings: { tag }, ...extra } as Partial<Layer>);
}

// Shape of Google's CSS2 response for a variable font (weight range) split
// into unicode-range subsets, plus an italic face and a static second family.
const GOOGLE_CSS = `
@font-face {
  font-family: 'Plus Jakarta Sans';
  font-style: italic;
  font-weight: 200 800;
  font-display: swap;
  src: url(https://fonts.gstatic.com/s/pjs/italic-latin.woff2) format('woff2');
  unicode-range: U+0000-00FF, U+0131, U+0152-0153;
}
@font-face {
  font-family: 'Plus Jakarta Sans';
  font-style: normal;
  font-weight: 200 800;
  font-display: swap;
  src: url(https://fonts.gstatic.com/s/pjs/normal-latin-ext.woff2) format('woff2');
  unicode-range: U+0100-02BA, U+02BD-02C5;
}
@font-face {
  font-family: 'Plus Jakarta Sans';
  font-style: normal;
  font-weight: 200 800;
  font-display: swap;
  src: url(https://fonts.gstatic.com/s/pjs/normal-latin.woff2) format('woff2');
  unicode-range: U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC;
}
@font-face {
  font-family: 'Spectral';
  font-style: normal;
  font-weight: 700;
  font-display: swap;
  src: url(https://fonts.gstatic.com/s/spectral/700-latin.woff2) format('woff2');
  unicode-range: U+0000-00FF;
}
@font-face {
  font-family: 'Spectral';
  font-style: normal;
  font-weight: 400;
  font-display: swap;
  src: url(https://fonts.gstatic.com/s/spectral/400-latin.woff2) format('woff2');
  unicode-range: U+0000-00FF;
}
`;

test('getTextFontFromClasses reads arbitrary family and named / numeric weights', () => {
  assert.deepEqual(
    getTextFontFromClasses('block text-[30px] font-bold font-[Plus_Jakarta_Sans]'),
    { family: 'Plus Jakarta Sans', weight: 700 },
  );
  assert.deepEqual(getTextFontFromClasses('font-[Inter] font-[400]'), { family: 'Inter', weight: 400 });
  assert.deepEqual(getTextFontFromClasses(['font-semibold']), { family: null, weight: 600 });
  assert.deepEqual(getTextFontFromClasses(''), { family: null, weight: null });
});

test('getTextFontFromClasses reads quoted arbitrary families', () => {
  assert.deepEqual(getTextFontFromClasses("font-['IBM_Plex_Mono'] font-black"), { family: 'IBM Plex Mono', weight: 900 });
  assert.deepEqual(getTextFontFromClasses('font-["Archivo"]'), { family: 'Archivo', weight: null });
});

test('getTextFontFromClasses ignores variants and lets built-ins reset the family', () => {
  assert.deepEqual(getTextFontFromClasses('md:font-[Inter] hover:font-bold'), { family: null, weight: null });
  assert.deepEqual(getTextFontFromClasses('font-[Inter] font-sans'), { family: 'sans', weight: null });
});

test('findLcpTextFont picks the first h1 outside header/nav and cascades from ancestors', () => {
  const layers = [
    layer('header', 'font-[Inter]', { children: [text('h1', 'font-bold')] }),
    layer('section', 'font-[Plus_Jakarta_Sans]', {
      children: [
        layer('div', '', { children: [text('p', 'font-[Inter]'), text('h1', 'font-bold')] }),
      ],
    }),
  ];
  assert.deepEqual(findLcpTextFont(layers, 'font-[Inter] font-[400]'), {
    family: 'Plus Jakarta Sans',
    weight: 700,
  });
});

test('findLcpTextFont falls back to the first heading, then the first paragraph', () => {
  const heading = [layer('section', '', { children: [text('p', 'font-[Inter]'), text('h2', 'font-[Sora] font-semibold')] })];
  assert.deepEqual(findLcpTextFont(heading), { family: 'Sora', weight: 600 });

  const paragraph = [layer('section', '', { children: [text('p', 'font-[Inter]')] })];
  assert.deepEqual(findLcpTextFont(paragraph), { family: 'Inter', weight: 400 });
});

test('findLcpTextFont inherits the body font and defaults weight to 400', () => {
  const layers = [layer('section', '', { children: [text('h1')] })];
  assert.deepEqual(findLcpTextFont(layers, 'font-[DM_Sans]'), { family: 'DM Sans', weight: 400 });
});

test('findLcpTextFont honours the heading template default tag', () => {
  const layers = [layer('section', '', { children: [layer('heading', 'font-[Sora] font-bold')] })];
  assert.deepEqual(findLcpTextFont(layers), { family: 'Sora', weight: 700 });
});

test('findLcpTextFont returns null for built-in stacks, hidden text and empty pages', () => {
  assert.equal(findLcpTextFont([layer('section', '', { children: [text('h1', 'font-sans font-bold')] })]), null);
  assert.equal(findLcpTextFont([layer('section', '', { children: [text('h1', 'font-[Sora]', { hidden: true })] })]), null);
  assert.equal(findLcpTextFont([]), null);
});

test('parseFontFaceRules handles weight ranges, styles and unicode-range', () => {
  const rules = parseFontFaceRules(GOOGLE_CSS);
  assert.equal(rules.length, 5);
  assert.deepEqual(rules[2], {
    family: 'Plus Jakarta Sans',
    style: 'normal',
    weightMin: 200,
    weightMax: 800,
    src: 'https://fonts.gstatic.com/s/pjs/normal-latin.woff2',
    format: 'woff2',
    unicodeRange: 'U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC',
  });
  assert.equal(rules[3].weightMin, 700);
  assert.equal(rules[3].weightMax, 700);
});

test('getLcpFontPreloads returns only the upright latin subset inside the weight range', () => {
  assert.deepEqual(getLcpFontPreloads(GOOGLE_CSS, { family: 'Plus Jakarta Sans', weight: 700 }), [
    { href: 'https://fonts.gstatic.com/s/pjs/normal-latin.woff2', type: 'font/woff2' },
  ]);
});

test('getLcpFontPreloads matches static faces by exact weight', () => {
  assert.deepEqual(getLcpFontPreloads(GOOGLE_CSS, { family: 'spectral', weight: 700 }), [
    { href: 'https://fonts.gstatic.com/s/spectral/700-latin.woff2', type: 'font/woff2' },
  ]);
  // 600 is not served for Spectral — nothing to preload rather than a wrong file.
  assert.deepEqual(getLcpFontPreloads(GOOGLE_CSS, { family: 'Spectral', weight: 600 }), []);
});

test('getLcpFontPreloads is empty without css, target or a matching family', () => {
  assert.deepEqual(getLcpFontPreloads('', { family: 'Inter', weight: 400 }), []);
  assert.deepEqual(getLcpFontPreloads(GOOGLE_CSS, null), []);
  assert.deepEqual(getLcpFontPreloads(GOOGLE_CSS, { family: 'Inter', weight: 400 }), []);
});
