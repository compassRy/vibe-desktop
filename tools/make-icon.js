'use strict';
// Generates assets/icon.png and assets/icon.ico (orange rounded square with "V").
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SIZE = 256;
const OUT = path.join(__dirname, '..', 'assets');
fs.mkdirSync(OUT, { recursive: true });

function crc32(buf) {
  let table = crc32.table;
  if (!table) {
    table = crc32.table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
  }
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = (c >>> 8) ^ table[(c ^ buf[i]) & 0xff];
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

// Draw into RGBA buffer
const px = Buffer.alloc(SIZE * SIZE * 4);
function setPx(x, y, r, g, b, a) {
  const i = (y * SIZE + x) * 4;
  px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = a;
}
// rounded-rect mask
function inRoundRect(x, y, cx, cy, w, h, rad) {
  const qx = Math.max(cx + rad - x, x - (cx + w - rad), 0);
  const qy = Math.max(cy + rad - y, y - (cy + h - rad), 0);
  return qx * qx + qy * qy <= rad * rad || (x >= cx + rad && x <= cx + w - rad) || (y >= cy + rad && y <= cy + h - rad);
}
// simple 5x7 bitmap font for "V"
const FONT_V = [
  0b10000001,
  0b10000001,
  0b10000001,
  0b10000001,
  0b10000001,
  0b01000010,
  0b00111100,
];
const margin = 28;
for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    let r = 0, g = 0, b = 0, a = 0;
    if (inRoundRect(x, y, 0, 0, SIZE, SIZE, 56)) {
      // vertical gradient orange
      const t = y / SIZE;
      r = Math.round(255 - 5 * t);
      g = Math.round(112 - 60 * t);
      b = Math.round(0 + 15 * t);
      a = 255;
      // draw V
      const fw = 5, fh = 7;
      const scale = Math.floor((SIZE - 2 * margin) / fw);
      const ox = Math.floor((SIZE - fw * scale) / 2);
      const oy = Math.floor((SIZE - fh * scale) / 2);
      const lx = x - ox, ly = y - oy;
      if (lx >= 0 && ly >= 0 && lx < fw * scale && ly < fh * scale) {
        const bit = FONT_V[Math.floor(ly / scale)] & (1 << (fw - 1 - Math.floor(lx / scale)));
        if (bit) { r = 255; g = 255; b = 255; }
      }
    }
    setPx(x, y, r, g, b, a);
  }
}

// PNG encode (filter 0 per scanline)
const raw = Buffer.alloc(SIZE * (1 + SIZE * 4));
for (let y = 0; y < SIZE; y++) {
  raw[y * (1 + SIZE * 4)] = 0;
  px.copy(raw, y * (1 + SIZE * 4) + 1, y * SIZE * 4, (y + 1) * SIZE * 4);
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // color type RGBA
ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);
fs.writeFileSync(path.join(OUT, 'icon.png'), png);

// ICO wrapper (PNG-in-ICO, Vista+)
const icoHeader = Buffer.alloc(6);
icoHeader.writeUInt16LE(0, 0);
icoHeader.writeUInt16LE(1, 2);
icoHeader.writeUInt16LE(1, 4);
const entry = Buffer.alloc(16);
entry[0] = SIZE >= 256 ? 0 : SIZE;
entry[1] = SIZE >= 256 ? 0 : SIZE;
entry[2] = 0; entry[3] = 0;
entry.writeUInt16LE(1, 4);
entry.writeUInt16LE(32, 6);
entry.writeUInt32LE(png.length, 8);
entry.writeUInt32LE(22, 12);
fs.writeFileSync(path.join(OUT, 'icon.ico'), Buffer.concat([icoHeader, entry, png]));
console.log('wrote icon.png and icon.ico,', png.length, 'bytes png');
