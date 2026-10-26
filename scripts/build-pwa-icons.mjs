// Home-Screen icons: the Plannote glyph (four rounded squares, two of them softer) in white on orange. Keep in step with public/favicon.svg. Run: node scripts/build-pwa-icons.mjs
import { deflateSync, crc32 } from "node:zlib";
import { writeFileSync } from "node:fs";
const png = (n) => {
  const SS = 3, rows = Buffer.alloc(n * (n * 3 + 1)), s = n / 512; // drawn on a 512 grid, any size
  const inSq = (x, y, x0, y0, w, r) => { const dx = Math.max(x0 - x, 0, x - (x0 + w)), dy = Math.max(y0 - y, 0, y - (y0 + w)); if (dx || dy) return false; const cx = Math.min(Math.max(x, x0 + r), x0 + w - r), cy = Math.min(Math.max(y, y0 + r), y0 + w - r); return Math.hypot(x - cx, y - cy) <= r; };
  for (let y = 0; y < n; y++) {
    rows[y * (n * 3 + 1)] = 0;
    for (let x = 0; x < n; x++) {
      let hit = 0;
      for (let j = 0; j < SS; j++) for (let i = 0; i < SS; i++) {
        const X = (x + (i + 0.5) / SS) / s, Y = (y + (j + 0.5) / SS) / s;
        for (const [a, b, w] of [[136, 136, 1], [264, 136, 0.6], [136, 264, 0.6], [264, 264, 1]]) if (inSq(X, Y, a, b, 112, 28)) hit += w; // w: the softer squares
      }
      const t = hit / (SS * SS), o = y * (n * 3 + 1) + 1 + x * 3;
      [239, 108, 26].forEach((c, k) => (rows[o + k] = Math.round(c + (255 - c) * t)));
    }
  }
  const chunk = (t, d) => { const b = Buffer.concat([Buffer.from(t), d]), l = Buffer.alloc(4), c = Buffer.alloc(4); l.writeUInt32BE(d.length); c.writeUInt32BE(crc32(b)); return Buffer.concat([l, b, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(n, 0); ihdr.writeUInt32BE(n, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(rows)), chunk("IEND", Buffer.alloc(0))]);
};
for (const [name, n] of [["icon-192", 192], ["icon-512", 512], ["apple-touch-icon", 180]]) writeFileSync(`public/${name}.png`, png(n));
