// Pure image helpers for the art import pipeline (no I/O). Pixels are tightly packed 8-bit RGB / RGBA.

export interface KeyResult {
  rgba: Uint8Array;
  bg: [number, number, number];
  bbox: { x: number; y: number; w: number; h: number } | null;
  bgUniform: boolean;
  components: number;
  removedSpeckles: number;
}
export interface KeyOptions {
  /** background colour; auto-detected from the four corners when omitted */
  bg?: [number, number, number];
  /** colour distance below which a pixel is fully background / above which it is fully subject */
  low?: number;
  high?: number;
  /** clear the corner where image generators stamp their sparkle mark (fractions of width/height) */
  clearMark?: { x: number; y: number } | null;
  /** drop disconnected specks smaller than this many pixels */
  minComponent?: number;
  /** solve the ~2px boundary band for true coverage instead of trusting colour distance (default on) */
  matte?: boolean;
  /** 0 = off, 1 = full despill of edge pixels (default 1) */
  despill?: number;
}

const median = (v: number[]) => [...v].sort((a, b) => a - b)[v.length >> 1];

/** Median colour of the four 16x16 corner patches, plus whether they agree (i.e. a flat background). */
export function detectBackground(rgb: Uint8Array, w: number, h: number): { bg: [number, number, number]; uniform: boolean } {
  const patch = 16,
    corners = [
      [0, 0],
      [w - patch, 0],
      [0, h - patch],
      [w - patch, h - patch],
    ];
  const cols = corners.map(([cx, cy]) => {
    const r: number[] = [],
      g: number[] = [],
      b: number[] = [];
    for (let y = cy; y < cy + patch; y++)
      for (let x = cx; x < cx + patch; x++) {
        const i = (y * w + x) * 3;
        r.push(rgb[i]);
        g.push(rgb[i + 1]);
        b.push(rgb[i + 2]);
      }
    return [median(r), median(g), median(b)] as [number, number, number];
  });
  const bg: [number, number, number] = [median(cols.map((c) => c[0])), median(cols.map((c) => c[1])), median(cols.map((c) => c[2]))];
  // the bottom-right corner may hold a watermark, so require agreement of at least three corners
  const agree = cols.filter((c) => Math.hypot(c[0] - bg[0], c[1] - bg[1], c[2] - bg[2]) < 40).length;
  return { bg, uniform: agree >= 3 };
}

/**
 * Chroma-key `rgb` against a flat background colour. Alpha ramps smoothly with colour distance; edge pixels are
 * "un-premultiplied" (bg colour subtracted back out) so anti-aliased edges carry no magenta fringe.
 */
export function keyOut(rgb: Uint8Array, w: number, h: number, o: KeyOptions = {}): KeyResult {
  const det = o.bg ? { bg: o.bg, uniform: true } : detectBackground(rgb, w, h);
  const [kr, kg, kb] = det.bg;
  const low = o.low ?? 45,
    high = o.high ?? 125,
    minComp = o.minComponent ?? 60;
  const mark = o.clearMark === undefined ? { x: 0.92, y: 0.87 } : o.clearMark;
  const rgba = new Uint8Array(w * h * 4);
  for (let i = 0, p = 0; i < w * h; i++, p += 3) {
    const x = i % w,
      y = (i / w) | 0;
    if (mark && x >= w * mark.x && y >= h * mark.y) continue; // watermark corner stays transparent
    const pr = rgb[p],
      pg = rgb[p + 1],
      pb = rgb[p + 2];
    const dr = pr - kr,
      dg = pg - kg,
      db = pb - kb;
    // Model 1 (distance): alpha grows with colour distance from the background.
    let a = smooth((Math.hypot(dr, dg, db) - low) / (high - low));
    let px: [number, number, number] = [kr + dr / Math.max(a, 1e-3), kg + dg / Math.max(a, 1e-3), kb + db / Math.max(a, 1e-3)];
    // Model 2 (smoke): a pixel lying on the line black -> background colour (P ~ t*K) is dark smoke blended with the
    // backdrop: alpha ~ 1-t and the underlying colour is near black. Distance alone would call it a solid dark-magenta pixel.
    // The line test is tight (real art has more green/other hue), and t is capped so a shaded backdrop never turns into haze.
    const kk = kr * kr + kg * kg + kb * kb,
      t = (pr * kr + pg * kg + pb * kb) / kk;
    const resid = Math.hypot(pr - t * kr, pg - t * kg, pb - t * kb);
    const wRay = smooth((t - 0.25) / 0.15) * (1 - smooth((resid - 14) / 10));
    if (wRay > 0) {
      const aRay = Math.min(1, Math.max(0, 1 - t / 0.9));
      const sRay = [(pr - t * kr) / Math.max(aRay, 0.05), (pg - t * kg) / Math.max(aRay, 0.05), (pb - t * kb) / Math.max(aRay, 0.05)];
      a = wRay * aRay + (1 - wRay) * a;
      px = [0, 1, 2].map((c) => wRay * sRay[c] + (1 - wRay) * px[c]) as [number, number, number];
    }
    if (a < 0.04) continue;
    const q = i * 4;
    // Despill: semi-transparent edge pixels (smoke, glows, anti-aliasing) still lean towards the key colour. Remove that
    // component in proportion to how transparent the pixel is. Fully opaque pixels are never touched.
    if (a < 1) px = despill(px, det.bg, (1 - a) * (o.despill ?? 1));
    rgba[q] = clamp(px[0]);
    rgba[q + 1] = clamp(px[1]);
    rgba[q + 2] = clamp(px[2]);
    rgba[q + 3] = Math.round(a * 255);
  }
  if (o.matte ?? true) matteEdges(rgb, rgba, w, h, det.bg);
  // keep only connected blobs that are big enough (removes JPEG speckle and stray marks)
  const label = new Int32Array(w * h).fill(-1);
  const sizes: number[] = [];
  const stack: number[] = [];
  for (let s = 0; s < w * h; s++) {
    if (label[s] !== -1 || rgba[s * 4 + 3] < 40) continue;
    const id = sizes.length;
    let n = 0;
    stack.push(s);
    label[s] = id;
    while (stack.length) {
      const c = stack.pop()!;
      n++;
      const cx = c % w,
        cy = (c / w) | 0;
      for (const [nx, ny] of [
        [cx + 1, cy],
        [cx - 1, cy],
        [cx, cy + 1],
        [cx, cy - 1],
      ]) {
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const ni = ny * w + nx;
        if (label[ni] === -1 && rgba[ni * 4 + 3] >= 40) {
          label[ni] = id;
          stack.push(ni);
        }
      }
    }
    sizes.push(n);
  }
  let removed = 0,
    minX = w,
    minY = h,
    maxX = -1,
    maxY = -1;
  for (let i = 0; i < w * h; i++) {
    const keep = label[i] >= 0 && sizes[label[i]] >= minComp;
    if (!keep) {
      if (rgba[i * 4 + 3]) {
        rgba[i * 4 + 3] = 0;
        removed++;
      }
      continue;
    }
    const x = i % w,
      y = (i / w) | 0;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return {
    rgba,
    bg: det.bg,
    bgUniform: det.uniform,
    components: sizes.filter((n) => n >= minComp).length,
    removedSpeckles: removed,
    bbox: maxX < 0 ? null : { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 },
  };
}
/**
 * Generic despill. The key's dominant channels ("high": magenta -> R,B; green -> G) must not exceed the strongest of the
 * other channels in a neutral pixel; whatever exceeds it is spill and is subtracted from the high channels.
 */
export function despill(px: [number, number, number], key: [number, number, number], amount: number): [number, number, number] {
  const top = Math.max(...key),
    high = key.map((c) => c > top / 2),
    low = key.map((c) => c <= top / 2);
  if (!low.some(Boolean)) return px; // white/grey key: nothing to despill
  const spill = Math.min(...px.filter((_, i) => high[i])) - Math.max(...px.filter((_, i) => low[i]));
  if (spill <= 0) return px;
  return px.map((c, i) => (high[i] ? c - spill * amount : c)) as [number, number, number];
}
/**
 * Edge matting. Colour distance calls any pixel that is more than ~40 % subject "fully opaque", so anti-aliased outlines
 * keep a tint of the backdrop. For pixels within ~2 px of transparency we instead look up the solid colour S just inside
 * the shape and solve  pixel = a*S + (1-a)*K  for a. The result replaces the pixel only when the model fits well.
 */
function matteEdges(rgb: Uint8Array, rgba: Uint8Array, w: number, h: number, key: [number, number, number]) {
  const n = w * h,
    INF = 1e9;
  const dist = new Float32Array(n);
  for (let i = 0; i < n; i++) dist[i] = rgba[i * 4 + 3] < 10 ? 0 : INF;
  const D2 = Math.SQRT2;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      // forward chamfer pass
      const i = y * w + x;
      let d = dist[i];
      if (d === 0) continue;
      if (x > 0) d = Math.min(d, dist[i - 1] + 1);
      if (y > 0) {
        d = Math.min(d, dist[i - w] + 1);
        if (x > 0) d = Math.min(d, dist[i - w - 1] + D2);
        if (x < w - 1) d = Math.min(d, dist[i - w + 1] + D2);
      }
      dist[i] = d;
    }
  for (let y = h - 1; y >= 0; y--)
    for (let x = w - 1; x >= 0; x--) {
      // backward pass
      const i = y * w + x;
      let d = dist[i];
      if (d === 0) continue;
      if (x < w - 1) d = Math.min(d, dist[i + 1] + 1);
      if (y < h - 1) {
        d = Math.min(d, dist[i + w] + 1);
        if (x < w - 1) d = Math.min(d, dist[i + w + 1] + D2);
        if (x > 0) d = Math.min(d, dist[i + w - 1] + D2);
      }
      dist[i] = d;
    }
  const R = 5;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (dist[i] === 0 || dist[i] > 2.5) continue;
      // average the solid interior colour nearby (opaque and >= 3 px from any transparent pixel)
      let sr = 0,
        sg = 0,
        sb = 0,
        c = 0;
      for (let yy = Math.max(0, y - R); yy <= Math.min(h - 1, y + R); yy++)
        for (let xx = Math.max(0, x - R); xx <= Math.min(w - 1, x + R); xx++) {
          const j = yy * w + xx;
          if (dist[j] >= 3 && dist[j] < INF && rgba[j * 4 + 3] >= 250) {
            sr += rgba[j * 4];
            sg += rgba[j * 4 + 1];
            sb += rgba[j * 4 + 2];
            c++;
          }
        }
      if (c < 6) continue; // thin feature: no reliable interior colour
      const S = [sr / c, sg / c, sb / c],
        v = [S[0] - key[0], S[1] - key[1], S[2] - key[2]];
      const vv = v[0] * v[0] + v[1] * v[1] + v[2] * v[2];
      if (vv < 2500) continue; // subject colour too close to the key to separate
      const P = [rgb[i * 3] - key[0], rgb[i * 3 + 1] - key[1], rgb[i * 3 + 2] - key[2]];
      const a = Math.min(1, Math.max(0, (P[0] * v[0] + P[1] * v[1] + P[2] * v[2]) / vv));
      const resid = Math.hypot(P[0] - a * v[0], P[1] - a * v[1], P[2] - a * v[2]);
      if (resid > 40 || a > 0.97) continue; // not a clean subject/backdrop mix (or already solid): keep the first estimate
      // Interior samples need dist >= 3 while edited pixels have dist <= 2.5, so updating in place cannot disturb later sampling.
      const q = i * 4;
      rgba[q] = clamp(S[0]);
      rgba[q + 1] = clamp(S[1]);
      rgba[q + 2] = clamp(S[2]);
      rgba[q + 3] = Math.round(a * 255);
    }
}
const smooth = (x: number) => {
  const v = x <= 0 ? 0 : x >= 1 ? 1 : x;
  return v * v * (3 - 2 * v);
};
const clamp = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v));

/** Largest centered crop of a w x h image with the target aspect ratio. */
export function coverCrop(w: number, h: number, targetW: number, targetH: number) {
  const target = targetW / targetH;
  return w / h > target
    ? { x: Math.round((w - h * target) / 2), y: 0, w: Math.round(h * target), h }
    : { x: 0, y: Math.round((h - w / target) / 2), w, h: Math.round(w / target) };
}
