import assert from 'node:assert/strict';
import { test } from 'node:test';
import { coverCrop, despill, detectBackground, keyOut } from '../src/art.ts';

const W = 200, H = 100, KEY: [number, number, number] = [244, 17, 236];

/** Flat magenta canvas with helpers to paint pixels. */
function canvas(bg = KEY) {
  const px = new Uint8Array(W * H * 3);
  for (let i = 0; i < W * H; i++) px.set(bg, i * 3);
  const set = (x: number, y: number, c: number[]) => px.set(c, (y * W + x) * 3);
  const fill = (x0: number, y0: number, x1: number, y1: number, c: number[]) => { for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) set(x, y, c); };
  const alphaAt = (k: ReturnType<typeof keyOut>, x: number, y: number) => k.rgba[(y * W + x) * 4 + 3];
  const colorAt = (k: ReturnType<typeof keyOut>, x: number, y: number) => [...k.rgba.slice((y * W + x) * 4, (y * W + x) * 4 + 3)];
  return { px, set, fill, alphaAt, colorAt };
}

test('detectBackground finds the flat colour and tolerates a watermark in one corner', () => {
  const c = canvas();
  c.fill(W - 16, H - 16, W, H, [250, 250, 250]); // white sparkle patch in the bottom-right corner
  const d = detectBackground(c.px, W, H);
  assert.deepEqual(d.bg, KEY);
  assert.ok(d.uniform);
  const busy = canvas(); busy.fill(0, 0, 16, 16, [0, 0, 0]); busy.fill(W - 16, 0, W, 16, [255, 255, 255]);
  assert.equal(detectBackground(busy.px, W, H).uniform, false, 'half the corners differ -> not a flat background');
});

test('keyOut: background transparent, subject opaque and unchanged, bounding box tight', () => {
  const c = canvas();
  c.fill(60, 30, 140, 70, [120, 45, 40]); // solid subject
  const k = keyOut(c.px, W, H);
  assert.equal(c.alphaAt(k, 5, 5), 0);
  assert.equal(c.alphaAt(k, 100, 50), 255);
  assert.deepEqual(c.colorAt(k, 100, 50), [120, 45, 40]);
  assert.deepEqual(k.bbox, { x: 60, y: 30, w: 80, h: 40 });
  assert.equal(k.components, 1);
});

test('keyOut: edge pixels blended with the backdrop lose their magenta fringe', () => {
  const c = canvas();
  c.fill(60, 30, 140, 70, [90, 200, 60]); // green subject so any magenta tint is obvious
  // 50 % blend of subject and key on a one pixel ring
  const mix = [0, 1, 2].map((i) => Math.round(([90, 200, 60][i] + KEY[i]) / 2));
  for (let x = 59; x <= 140; x++) { c.set(x, 29, mix); c.set(x, 70, mix); }
  const k = keyOut(c.px, W, H);
  const [r, g, b] = c.colorAt(k, 100, 29);
  const a = c.alphaAt(k, 100, 29);
  assert.ok(a > 100 && a < 160, `50 % coverage should give alpha ~128, got ${a}`);
  assert.deepEqual([r, g, b], [90, 200, 60], 'edge takes the subject colour, the backdrop tint is gone');
});

test('keyOut: dark smoke blended with the backdrop becomes a dark semi-transparent pixel, not solid magenta', () => {
  const c = canvas();
  c.fill(80, 30, 120, 70, [10, 5, 10]); // solid dark core so the blob survives
  const smoke = KEY.map((v) => Math.round(v * 0.62)); // 62 % of the key colour = 38 % black over the backdrop
  c.fill(60, 30, 80, 70, smoke);
  const k = keyOut(c.px, W, H);
  const a = c.alphaAt(k, 70, 50), [r, g, b] = c.colorAt(k, 70, 50);
  assert.ok(a > 60 && a < 200, `smoke alpha should be partial, got ${a}`);
  assert.ok(r < 60 && b < 60 && g < 40, `smoke colour should be near black, got ${[r, g, b]}`);
});

test('keyOut: real dark-purple artwork stays opaque (must not be mistaken for smoke)', () => {
  const c = canvas();
  c.fill(60, 30, 140, 70, [100, 35, 85]); // dark purple wing colour
  const k = keyOut(c.px, W, H);
  assert.equal(c.alphaAt(k, 100, 50), 255);
  assert.deepEqual(c.colorAt(k, 100, 50), [100, 35, 85]);
});

test('keyOut: a slightly shaded backdrop does not leave haze', () => {
  const c = canvas();
  c.fill(0, 0, W, H, KEY.map((v) => Math.round(v * 0.93))); // 7 % darker overall (vignette)
  c.fill(0, 0, 20, 20, KEY);
  c.fill(80, 40, 120, 60, [200, 120, 30]);
  const k = keyOut(c.px, W, H);
  assert.equal(c.alphaAt(k, 150, 10), 0);
  assert.equal(c.alphaAt(k, 100, 50), 255);
});

test('keyOut: clears the generator watermark corner, keeps a speck-free result, works with a green key', () => {
  const c = canvas();
  c.fill(60, 30, 140, 70, [120, 45, 40]);
  c.fill(W - 20, H - 12, W - 6, H - 3, [255, 255, 255]); // sparkle
  c.set(10, 10, [200, 200, 200]); // one stray speck
  const k = keyOut(c.px, W, H);
  assert.equal(c.alphaAt(k, W - 10, H - 6), 0, 'sparkle removed');
  assert.equal(c.alphaAt(k, 10, 10), 0, 'speck removed');
  assert.deepEqual(k.bbox, { x: 60, y: 30, w: 80, h: 40 }, 'sparkle must not stretch the bounding box');
  const kept = keyOut(c.px, W, H, { clearMark: null, minComponent: 1 });
  assert.equal(kept.bbox!.w > 80, true, 'with the mark kept it is part of the result');

  const g = canvas([0, 177, 64]);
  g.fill(60, 30, 140, 70, [200, 60, 60]);
  const kg = keyOut(g.px, W, H);
  assert.equal(g.alphaAt(kg, 5, 5), 0); assert.equal(g.alphaAt(kg, 100, 50), 255);
});

test('despill removes only the key hue and leaves neutral colours alone', () => {
  assert.deepEqual(despill([200, 100, 200], KEY, 1), [100, 100, 100]);
  assert.deepEqual(despill([200, 100, 50], KEY, 1), [200, 100, 50], 'orange has no magenta excess');
  assert.deepEqual(despill([180, 60, 190], [255, 255, 255], 1), [180, 60, 190], 'white key: nothing to despill');
});

test('coverCrop yields the largest centered crop of the target aspect', () => {
  assert.deepEqual(coverCrop(1408, 768, 1200, 240), { x: 0, y: 243, w: 1408, h: 282 });
  assert.deepEqual(coverCrop(1000, 1000, 16, 9), { x: 0, y: 219, w: 1000, h: 563 });
  assert.deepEqual(coverCrop(1600, 900, 1, 1), { x: 350, y: 0, w: 900, h: 900 });
});
