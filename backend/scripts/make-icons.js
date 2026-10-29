#!/usr/bin/env node
'use strict';

/**
 * Build the install icons from the brand emblem.
 *
 *   node scripts/make-icons.js
 *
 * Why a hand-written PNG codec rather than a library: the whole job is "read
 * this one RGBA image, resize it, write four copies". Adding `sharp` (a native
 * binary, ~30 MB per platform) or `jimp` for that is a poor trade on a server
 * that has to build inside a container, and the alternative in `node_modules`
 * would be a transitive dependency nobody declared.
 *
 * Input:  frontend/public/Images/Brand/wuteve-emblem.png (273x273, RGBA)
 * Output: four icons in frontend/public/icons/
 *
 *   icon-192.png            what Android and Chrome use on the home screen
 *   icon-512.png            the same, for splash screens and the store card
 *   icon-maskable-512.png   Android's adaptive icon: the emblem is scaled down
 *                           and centred on a filled square, because the launcher
 *                           crops the outer 20% to whatever shape it likes (a
 *                           circle, a squircle, a teardrop). Without the padding
 *                           a circular mask cuts the laurel wreath in half.
 *   apple-touch-icon.png    iOS never rounds or masks for you and composites on
 *                           black when the source has transparency, so this one
 *                           is 180x180 and fully opaque.
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const PUBLIC = path.join(__dirname, '..', '..', 'frontend', 'public');
const BRAND = '#0a1628';
const SOURCE = path.join(PUBLIC, 'Images', 'Brand', 'wuteve-emblem.png');
const OUT = path.join(PUBLIC, 'icons');

/* ------------------------------------------------------------------ *
 * PNG decode — only what this file needs: 8-bit RGBA, non-interlaced
 * ------------------------------------------------------------------ */

function readChunks(buffer) {
  if (buffer.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');

  const chunks = [];
  let offset = 8;

  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);

    chunks.push({ type, data });
    offset += 12 + length;

    if (type === 'IEND') break;
  }

  return chunks;
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

function decodePng(buffer) {
  const chunks = readChunks(buffer);
  const ihdr = chunks.find((chunk) => chunk.type === 'IHDR').data;

  const width = ihdr.readUInt32BE(0);
  const height = ihdr.readUInt32BE(4);
  const bitDepth = ihdr[8];
  const colorType = ihdr[9];
  const interlace = ihdr[12];

  if (bitDepth !== 8 || colorType !== 6 || interlace !== 0) {
    throw new Error(`unsupported PNG: depth ${bitDepth}, colour type ${colorType}, interlace ${interlace}`);
  }

  const compressed = Buffer.concat(
    chunks.filter((chunk) => chunk.type === 'IDAT').map((chunk) => chunk.data)
  );
  const raw = zlib.inflateSync(compressed);

  const stride = width * 4;
  const pixels = Buffer.alloc(width * height * 4);

  let position = 0;

  for (let y = 0; y < height; y += 1) {
    const filter = raw[position];
    position += 1;

    const rowStart = y * stride;
    const previousStart = (y - 1) * stride;

    for (let x = 0; x < stride; x += 1) {
      const value = raw[position + x];

      const left = x >= 4 ? pixels[rowStart + x - 4] : 0;
      const up = y > 0 ? pixels[previousStart + x] : 0;
      const upLeft = x >= 4 && y > 0 ? pixels[previousStart + x - 4] : 0;

      let restored;
      if (filter === 0) restored = value;
      else if (filter === 1) restored = value + left;
      else if (filter === 2) restored = value + up;
      else if (filter === 3) restored = value + ((left + up) >> 1);
      else if (filter === 4) restored = value + paeth(left, up, upLeft);
      else throw new Error(`unknown row filter ${filter}`);

      pixels[rowStart + x] = restored & 0xff;
    }

    position += stride;
  }

  return { width, height, pixels };
}

/* ------------------------------------------------------------------ *
 * PNG encode
 * ------------------------------------------------------------------ */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let crc = -1;
  for (let i = 0; i < buffer.length; i += 1) crc = CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);

  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);

  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));

  return Buffer.concat([length, body, crc]);
}

function encodePng(width, height, pixels) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA

  /**
   * Per-row adaptive filtering.
   *
   * A gradient emblem is the worst case for PNG's filter 0 ("none"): neighbouring
   * pixels differ by one or two, and storing the values themselves throws that
   * away. Trying all five filters per row and keeping whichever leaves the
   * smallest absolute sum is the heuristic the PNG spec itself recommends, and on
   * this artwork it takes the 512 icon from 473 KB to a fifth of that.
   */
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);

  const candidates = [Buffer.alloc(stride), Buffer.alloc(stride), Buffer.alloc(stride), Buffer.alloc(stride), Buffer.alloc(stride)];

  for (let y = 0; y < height; y += 1) {
    const rowStart = y * stride;
    const previousStart = (y - 1) * stride;

    for (let x = 0; x < stride; x += 1) {
      const value = pixels[rowStart + x];
      const left = x >= 4 ? pixels[rowStart + x - 4] : 0;
      const up = y > 0 ? pixels[previousStart + x] : 0;
      const upLeft = x >= 4 && y > 0 ? pixels[previousStart + x - 4] : 0;

      candidates[0][x] = value;
      candidates[1][x] = (value - left) & 0xff;
      candidates[2][x] = (value - up) & 0xff;
      candidates[3][x] = (value - ((left + up) >> 1)) & 0xff;
      candidates[4][x] = (value - paeth(left, up, upLeft)) & 0xff;
    }

    let best = 0;
    let bestScore = Infinity;

    for (let filter = 0; filter < 5; filter += 1) {
      let score = 0;
      for (let x = 0; x < stride; x += 1) {
        const byte = candidates[filter][x];
        score += byte < 128 ? byte : 256 - byte;
      }
      if (score < bestScore) {
        bestScore = score;
        best = filter;
      }
    }

    const target = y * (stride + 1);
    raw[target] = best;
    candidates[best].copy(raw, target + 1);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ------------------------------------------------------------------ *
 * Resize and composite
 * ------------------------------------------------------------------ */

/**
 * Bilinear resize, done in premultiplied alpha.
 *
 * Interpolating straight RGBA pulls the colour of transparent pixels into the
 * edge of the emblem and leaves a dark halo, because those pixels are usually
 * (0,0,0,0) and their black counts as much as their alpha does not. Premultiply,
 * interpolate, divide back out.
 */
function resize(source, targetWidth, targetHeight) {
  const out = Buffer.alloc(targetWidth * targetHeight * 4);

  const xRatio = source.width / targetWidth;
  const yRatio = source.height / targetHeight;

  for (let y = 0; y < targetHeight; y += 1) {
    const sourceY = Math.min((y + 0.5) * yRatio - 0.5, source.height - 1);
    const y0 = Math.max(Math.floor(sourceY), 0);
    const y1 = Math.min(y0 + 1, source.height - 1);
    const wy = sourceY - y0;

    for (let x = 0; x < targetWidth; x += 1) {
      const sourceX = Math.min((x + 0.5) * xRatio - 0.5, source.width - 1);
      const x0 = Math.max(Math.floor(sourceX), 0);
      const x1 = Math.min(x0 + 1, source.width - 1);
      const wx = sourceX - x0;

      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;

      const corners = [
        [x0, y0, (1 - wx) * (1 - wy)],
        [x1, y0, wx * (1 - wy)],
        [x0, y1, (1 - wx) * wy],
        [x1, y1, wx * wy],
      ];

      for (const [cx, cy, weight] of corners) {
        const index = (cy * source.width + cx) * 4;
        const alpha = source.pixels[index + 3] / 255;
        r += source.pixels[index] * alpha * weight;
        g += source.pixels[index + 1] * alpha * weight;
        b += source.pixels[index + 2] * alpha * weight;
        a += alpha * weight;
      }

      const outIndex = (y * targetWidth + x) * 4;

      if (a > 0) {
        out[outIndex] = Math.min(Math.round(r / a), 255);
        out[outIndex + 1] = Math.min(Math.round(g / a), 255);
        out[outIndex + 2] = Math.min(Math.round(b / a), 255);
      }

      out[outIndex + 3] = Math.round(a * 255);
    }
  }

  return { width: targetWidth, height: targetHeight, pixels: out };
}

function hexToRgb(hex) {
  return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
}

/** Draw an image centred on a filled square, scaled to `share` of the side. */
function compositeOnto(background, image, side, share) {
  const [r, g, b] = hexToRgb(background);
  const out = Buffer.alloc(side * side * 4);

  for (let i = 0; i < side * side; i += 1) {
    out[i * 4] = r;
    out[i * 4 + 1] = g;
    out[i * 4 + 2] = b;
    out[i * 4 + 3] = 255;
  }

  const inner = Math.round(side * share);
  const scaled = resize(image, inner, inner);
  const offset = Math.round((side - inner) / 2);

  for (let y = 0; y < inner; y += 1) {
    for (let x = 0; x < inner; x += 1) {
      const sourceIndex = (y * inner + x) * 4;
      const alpha = scaled.pixels[sourceIndex + 3] / 255;
      if (alpha === 0) continue;

      const targetIndex = ((y + offset) * side + (x + offset)) * 4;

      out[targetIndex] = Math.round(scaled.pixels[sourceIndex] * alpha + out[targetIndex] * (1 - alpha));
      out[targetIndex + 1] = Math.round(scaled.pixels[sourceIndex + 1] * alpha + out[targetIndex + 1] * (1 - alpha));
      out[targetIndex + 2] = Math.round(scaled.pixels[sourceIndex + 2] * alpha + out[targetIndex + 2] * (1 - alpha));
      out[targetIndex + 3] = 255;
    }
  }

  return { width: side, height: side, pixels: out };
}

/* ------------------------------------------------------------------ *
 * Entry
 * ------------------------------------------------------------------ */

function main() {
  if (!fs.existsSync(SOURCE)) {
    process.stderr.write(`\nNo emblem at ${SOURCE}\n\n`);
    process.exitCode = 1;
    return;
  }

  fs.mkdirSync(OUT, { recursive: true });

  const emblem = decodePng(fs.readFileSync(SOURCE));
  process.stdout.write(`  source  ${emblem.width}x${emblem.height}  ${path.basename(SOURCE)}\n\n`);

  const written = [];

  // The emblem on its own, at the two sizes Chrome and Android ask for.
  for (const side of [192, 512]) {
    const icon = resize(emblem, side, side);
    const file = path.join(OUT, `icon-${side}.png`);
    fs.writeFileSync(file, encodePng(side, side, icon.pixels));
    written.push([`icon-${side}.png`, side, (fs.statSync(file).size / 1024).toFixed(0)]);
  }

  // Android's safe zone: the launcher may crop to a circle of 80% of the icon.
  const maskable = compositeOnto(BRAND, emblem, 512, 0.72);
  const maskableFile = path.join(OUT, 'icon-maskable-512.png');
  fs.writeFileSync(maskableFile, encodePng(512, 512, maskable.pixels));
  written.push(['icon-maskable-512.png', 512, (fs.statSync(maskableFile).size / 1024).toFixed(0)]);

  // iOS: opaque, 180x180, and it applies its own rounding.
  const apple = compositeOnto(BRAND, emblem, 180, 0.86);
  const appleFile = path.join(OUT, 'apple-touch-icon.png');
  fs.writeFileSync(appleFile, encodePng(180, 180, apple.pixels));
  written.push(['apple-touch-icon.png', 180, (fs.statSync(appleFile).size / 1024).toFixed(0)]);

  for (const [name, size, kb] of written) {
    process.stdout.write(`  ${name.padEnd(24)} ${String(size).padStart(3)}x${size}   ${kb} KB\n`);
  }

  process.stdout.write(`\n  ${written.length} icons written to ${path.relative(process.cwd(), OUT)}\n\n`);
}

main();
