/**
 * favicon.ico
 *
 * Browsers and crawlers (Google among them) fetch /favicon.ico expecting an
 * ICO file. It is built from the site's favicon, whatever its format: one
 * PNG image per size, which every current browser reads inside an ICO.
 */

import sharp from 'sharp';

export const FAVICON_ICO_SIZES = [16, 32, 48];

/** An ICO file holding PNG images (one per size) */
export function encodeIco(images: Array<{ size: number; png: Buffer }>): Buffer {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(images.length, 4);

  const entries: Buffer[] = [];
  let offset = 6 + images.length * 16;
  for (const { size, png } of images) {
    const entry = Buffer.alloc(16);
    entry.writeUInt8(size >= 256 ? 0 : size, 0); // width (0 means 256)
    entry.writeUInt8(size >= 256 ? 0 : size, 1); // height
    entry.writeUInt8(0, 2); // palette colors
    entry.writeUInt8(0, 3); // reserved
    entry.writeUInt16LE(1, 4); // color planes
    entry.writeUInt16LE(32, 6); // bits per pixel
    entry.writeUInt32LE(png.length, 8);
    entry.writeUInt32LE(offset, 12);
    offset += png.length;
    entries.push(entry);
  }
  return Buffer.concat([header, ...entries, ...images.map((image) => image.png)]);
}

/** favicon.ico from an image (SVG, PNG, WebP, …), squared on a transparent background */
export async function buildFaviconIco(source: Buffer): Promise<Buffer> {
  const images = await Promise.all(FAVICON_ICO_SIZES.map(async (size) => ({
    size,
    png: await sharp(source, { density: 384 })
      .resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png()
      .toBuffer(),
  })));
  return encodeIco(images);
}
