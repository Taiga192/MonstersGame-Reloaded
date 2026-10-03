// Import generated art into the game:  node scripts/import-art.ts <image> <number|id> [--keep-mark] [--pad N]
//                                      node scripts/import-art.ts --dir art-inbox        (names: 001.jpg, 001-anything.png or brand__logo.png)
// Reads docs/assets-manifest.json (run `npm run assets` first). Transparent assets are chroma-keyed (background colour is
// auto-detected), trimmed and resized to fit the target size -> public/assets/<id>.png. Full-bleed assets are cropped to the
// target aspect ratio -> .jpg. The original is kept in art-src/. Needs ImageMagick (`magick`).
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import { coverCrop, keyOut } from '../src/tools/art.ts';

interface Entry {
  id: string;
  w: number;
  h: number;
  transparent: boolean;
  kind: string;
}
const manifestPath = 'docs/assets-manifest.json';
if (!existsSync(manifestPath)) {
  console.error('Run `npm run assets` first (docs/assets-manifest.json is missing).');
  process.exit(1);
}
const manifest: Entry[] = JSON.parse(readFileSync(manifestPath, 'utf8'));

const args = process.argv.slice(2);
const flag = (n: string) => args.includes(n);
const opt = (n: string) => {
  const i = args.indexOf(n);
  return i >= 0 ? args[i + 1] : undefined;
};
const magick = (a: string[], input?: Buffer) => execFileSync('magick', a, { input, maxBuffer: 1 << 30 });

function resolve(token: string): { n: number; e: Entry } | null {
  const num = /^0*(\d+)(?:[-_. ]|$)/.exec(token);
  if (num && manifest[+num[1] - 1]) return { n: +num[1], e: manifest[+num[1] - 1] };
  const id = token.replace(/__/g, '/');
  const i = manifest.findIndex((m) => m.id === id);
  return i >= 0 ? { n: i + 1, e: manifest[i] } : null;
}

function importOne(file: string, token: string) {
  const hit = resolve(token);
  if (!hit) return console.error(`✗ ${basename(file)}: no asset matches "${token}" (use the number or the id from docs/ASSETS.md)`);
  const { n, e } = hit;
  const [w, h] = magick(['identify', '-format', '%w %h', `${file}[0]`])
    .toString()
    .trim()
    .split(' ')
    .map(Number);
  const raw = magick([`${file}[0]`, '-auto-orient', '-depth', '8', 'rgb:-']);
  const out = join('public/assets', e.id);
  mkdirSync(dirname(out), { recursive: true });
  for (const ext of ['png', 'jpg', 'jpeg', 'webp', 'avif', 'svg', 'gif']) rmSync(`${out}.${ext}`, { force: true }); // one file per asset id

  let note: string;
  if (e.transparent) {
    const k = keyOut(new Uint8Array(raw.buffer, raw.byteOffset, raw.length), w, h, { clearMark: flag('--keep-mark') ? null : undefined });
    if (!k.bbox) return console.error(`✗ ${basename(file)}: nothing left after removing the background`);
    const pad = Number(opt('--pad') ?? 4),
      b = k.bbox;
    const x0 = Math.max(0, b.x - pad),
      y0 = Math.max(0, b.y - pad),
      x1 = Math.min(w, b.x + b.w + pad),
      y1 = Math.min(h, b.y + b.h + pad);
    magick(
      ['-size', `${w}x${h}`, '-depth', '8', 'rgba:-', '-crop', `${x1 - x0}x${y1 - y0}+${x0}+${y0}`, '+repage', '-resize', `${e.w}x${e.h}>`, `PNG32:${out}.png`],
      Buffer.from(k.rgba),
    );
    note = `keyed (bg rgb ${k.bg.join(',')}${k.bgUniform ? '' : ', ⚠ background not uniform'}), ${k.components} part(s), ${k.removedSpeckles ? k.removedSpeckles + ' speck px removed, ' : ''}→ ${out}.png`;
  } else {
    // full-bleed: drop the generator mark in the bottom-right, crop to the target aspect, downscale if larger
    const trim = flag('--keep-mark') ? { r: 0, b: 0 } : { r: 0.05, b: 0.07 };
    const cw = Math.round(w * (1 - trim.r)),
      ch = Math.round(h * (1 - trim.b));
    const c = coverCrop(cw, ch, e.w, e.h);
    magick([
      `${file}[0]`,
      '-auto-orient',
      '-crop',
      `${cw}x${ch}+0+0`,
      '+repage',
      '-crop',
      `${c.w}x${c.h}+${c.x}+${c.y}`,
      '+repage',
      '-resize',
      `${e.w}x${e.h}>`,
      '-quality',
      '88',
      `${out}.jpg`,
    ]);
    note = `cropped to ${e.w}:${e.h} → ${out}.jpg`;
  }
  mkdirSync('art-src', { recursive: true });
  copyFileSync(file, join('art-src', `${String(n).padStart(3, '0')}-${e.id.replace(/\//g, '__')}${extname(file)}`));
  console.log(`✓ ${String(n).padStart(3, '0')} ${e.id}: ${note}`);
}

const dir = opt('--dir');
if (dir) {
  const files = readdirSync(dir)
    .filter((f) => /\.(png|jpe?g|webp|avif)$/i.test(f))
    .sort();
  if (!files.length) console.log(`No images in ${dir}`);
  for (const f of files) importOne(join(dir, f), basename(f, extname(f)));
} else {
  const positional = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--pad');
  if (positional.length < 2) {
    console.error('Usage: npm run art -- <image> <number|id>   or   npm run art -- --dir art-inbox');
    process.exit(1);
  }
  importOne(positional[0], positional[1]);
}
