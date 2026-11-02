import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import sharp from 'sharp';

import { buildFaviconIco, encodeIco, FAVICON_ICO_SIZES } from './favicon-ico';

test('an ICO lists one PNG image per size', async () => {
  const ico = await buildFaviconIco(readFileSync(join(process.cwd(), 'app', 'icon.svg')));
  assert.equal(ico.readUInt16LE(0), 0);
  assert.equal(ico.readUInt16LE(2), 1);
  assert.equal(ico.readUInt16LE(4), FAVICON_ICO_SIZES.length);

  for (let i = 0; i < FAVICON_ICO_SIZES.length; i++) {
    const entry = 6 + i * 16;
    const size = FAVICON_ICO_SIZES[i];
    assert.equal(ico.readUInt8(entry), size);
    const length = ico.readUInt32LE(entry + 8);
    const offset = ico.readUInt32LE(entry + 12);
    const image = await sharp(ico.subarray(offset, offset + length)).metadata();
    assert.equal(image.format, 'png');
    assert.equal(image.width, size);
    assert.equal(image.height, size);
  }
});

test('non-square images are fitted, not cropped or stretched', async () => {
  const wide = await sharp({ create: { width: 64, height: 32, channels: 4, background: '#ff0000' } }).webp({ lossless: true }).toBuffer();
  const ico = await buildFaviconIco(wide);
  const offset = ico.readUInt32LE(6 + 2 * 16 + 12);
  const length = ico.readUInt32LE(6 + 2 * 16 + 8);
  const { data, info } = await sharp(ico.subarray(offset, offset + length)).raw().toBuffer({ resolveWithObject: true });
  assert.equal(info.width, 48);
  // Top-left corner is transparent padding, the middle is the red image
  assert.equal(data[3], 0);
  const middle = (24 * 48 + 24) * 4;
  assert.deepEqual([...data.subarray(middle, middle + 4)], [255, 0, 0, 255]);
});

test('256 px images are stored as size 0, as the format requires', () => {
  const ico = encodeIco([{ size: 256, png: Buffer.from('x') }]);
  assert.equal(ico.readUInt8(6), 0);
});
