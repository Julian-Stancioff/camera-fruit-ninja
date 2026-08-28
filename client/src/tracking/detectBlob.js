// Appearance + shape detector: find the object by what it LOOKS like, then confirm
// it by what it IS SHAPED like. Enrolment watches the object being waved and learns
// a Gaussian over its RGB; every frame after that is a Mahalanobis gate, connected
// components, and PCA. There is no hand and no anchor — the object is found anywhere
// in the frame.
//
// WHERE THIS APPROACH IS WEAK, and the whole reason a second detector exists: it
// assumes the object HAS a colour. A mirror-finish katana does not — it reflects the
// room, so as it rotates its RGB walks straight out of the enrolled Gaussian and the
// mask empties. The other failure is the mirror image of that: a wall inside the gate
// swallows the blade into one huge component (MAX_COVER catches that and returns null
// rather than tracking the wall). Enrolment inherits both: a blade that never leaves
// its background's colour never produces a component to learn from.

export const NAME = "blob";

const MIN_AREA = 24;      // px: below this a component is sensor speckle — and a 3-px
                          // sliver scores infinite elongation, so it must be cut first
const MIN_ELONG = 4;      // 4:1, the floor for calling something blade-shaped
const GATE = 12;          // Mahalanobis d² accepted as "this pixel is the object"
const MIN_VAR = 25;       // RGB variance floor (±5 units) added to the covariance
                          // diagonal — a flat-coloured object otherwise learns a
                          // near-singular Gaussian that rejects its own next frame
const MAX_COVER = 0.25;   // mask share above which the colour model is discriminating
                          // nothing and the answer is "don't know", not a guess
const SCORE_MIN = 0.18;   // below this the best candidate is not the object
const MOVE_FLOOR = 40;    // summed L1 RGB motion a pixel must show to count as moved
const MOVE_K = 6;         // how many IQRs above the still-background accumulator a
                          // pixel must sit to be called moving — the camera-scaling
                          // knob, raise it if a grainy sensor enrols its own noise
const DEV_FLOOR = 24;     // L1 RGB gap from the background that means "object is HERE"
const MED_N = 9;          // frames sampled for the per-pixel background median

const clamp01 = (v) => Math.min(1, Math.max(0, v));
const wrapPi = (a) => Math.atan2(Math.sin(a), Math.cos(a));

// One set of working buffers for the whole module. detect() runs 30x a second inside
// a frame that is already rendering Three.js — allocating four typed arrays per frame
// is how you get a GC hitch mid-swing.
let buf = null;
function scratch(n) {
  if (!buf || buf.n < n) {
    buf = { n, mask: new Uint8Array(n), label: new Int32Array(n), stack: new Int32Array(n), order: new Int32Array(n) };
  }
  return buf;
}

// 8-connected flood fill over a binary mask. Explicit stack, never recursion: one
// diagonal blade across 192x108 is a single component thousands of pixels deep.
// Returns component pixel indices packed into `order`, with [start,end) per component.
function components(mask, SW, SH, minArea) {
  const n = SW * SH, s = scratch(n), { label, stack, order } = s;
  label.fill(0, 0, n);
  const comps = [];
  let end = 0, id = 0;
  for (let seed = 0; seed < n; seed++) {
    if (!mask[seed] || label[seed]) continue;
    const start = end;
    let sp = 0;
    label[seed] = ++id;
    stack[sp++] = seed;
    while (sp) {
      const p = stack[--sp];
      order[end++] = p;
      const x = p % SW, y = (p - x) / SW;
      const x0 = x > 0 ? x - 1 : 0, x1 = x < SW - 1 ? x + 1 : SW - 1;
      const y0 = y > 0 ? y - 1 : 0, y1 = y < SH - 1 ? y + 1 : SH - 1;
      for (let ny = y0; ny <= y1; ny++) {
        for (let nx = x0; nx <= x1; nx++) {
          const q = ny * SW + nx;
          if (mask[q] && !label[q]) { label[q] = id; stack[sp++] = q; }
        }
      }
    }
    if (end - start >= minArea) comps.push({ start, end });
    else end = start; // too small to be anything: rewind and reuse the space
  }
  return { order, comps };
}

// Second-moment axis of a pixel set. Elongation comes from the eigenvalue ratio
// (robust — one stray pixel barely moves it), but length, width and the endpoints
// come from the extreme projections onto that axis, so a blade that is fatter at the
// hilt still measures tip to tip. l2 is floored at the variance of a 1-px-wide strip,
// which is what stops a hairline from reporting infinite elongation.
function axisOf(order, start, end, SW) {
  const n = end - start;
  let sx = 0, sy = 0;
  for (let k = start; k < end; k++) { const p = order[k], x = p % SW; sx += x; sy += (p - x) / SW; }
  const cx = sx / n, cy = sy / n;
  let xx = 0, xy = 0, yy = 0;
  for (let k = start; k < end; k++) {
    const p = order[k], x = p % SW, dx = x - cx, dy = (p - x) / SW - cy;
    xx += dx * dx; xy += dx * dy; yy += dy * dy;
  }
  xx /= n; xy /= n; yy /= n;
  const tr = xx + yy, disc = Math.sqrt(Math.max(0, (tr * tr) / 4 - (xx * yy - xy * xy)));
  const l1 = tr / 2 + disc, l2 = Math.max(1 / 12, tr / 2 - disc);
  const angle = 0.5 * Math.atan2(2 * xy, xx - yy);
  const ux = Math.cos(angle), uy = Math.sin(angle);
  let tMin = Infinity, tMax = -Infinity, wMin = Infinity, wMax = -Infinity;
  for (let k = start; k < end; k++) {
    const p = order[k], x = p % SW, dx = x - cx, dy = (p - x) / SW - cy;
    const t = dx * ux + dy * uy, w = dy * ux - dx * uy;
    if (t < tMin) tMin = t;
    if (t > tMax) tMax = t;
    if (w < wMin) wMin = w;
    if (w > wMax) wMax = w;
  }
  return {
    cx, cy, angle, n,
    len: tMax - tMin,
    wid: Math.max(1, wMax - wMin),
    elong: Math.sqrt(l1 / l2),
    ends: [[cx + tMin * ux, cy + tMin * uy], [cx + tMax * ux, cy + tMax * uy]],
  };
}

// Inverse of the symmetric 3x3 [a b c; b d e; c e f], packed row-major.
function inv3(a, b, c, d, e, f) {
  const A = d * f - e * e, B = c * e - b * f, C = b * e - c * d;
  const det = a * A + b * B + c * C;
  if (!(Math.abs(det) > 1e-9)) return null;
  const k = 1 / det, D = (a * f - c * c) * k, E = (b * c - a * e) * k;
  return [A * k, B * k, C * k, B * k, D, E, C * k, E, (a * d - b * b) * k];
}

const maha = (dr, dg, db, q) =>
  dr * dr * q[0] + dg * dg * q[4] + db * db * q[8] +
  2 * (dr * dg * q[1] + dr * db * q[2] + dg * db * q[5]);

// Gradient energy on the red channel, strided. Motion blur flattens gradients, so the
// sharpest frame of the wave is the one where the object was momentarily slowest.
function sharpness(px, SW, SH) {
  let e = 0;
  for (let y = 1; y < SH - 1; y += 2) {
    for (let x = 1; x < SW - 1; x += 2) {
      const i = (y * SW + x) * 4;
      e += Math.abs(px[i] - px[i + 4]) + Math.abs(px[i] - px[i + SW * 4]);
    }
  }
  return e;
}

/**
 * Learn the object from ~1s of frames in which the player waved it.
 * @param {Uint8ClampedArray[]} frames RGBA buffers, all SW x SH
 * @returns {{mean:number[], inv:number[], len:number, wid:number, elong:number}|null}
 */
export function enroll(frames, SW, SH) {
  if (!frames || frames.length < 2) return null;
  const n = SW * SH;

  // What moved over the take. Summed inter-frame L1, thresholded as an OUTLIER test
  // against the still background's own distribution: most of the frame never moves, so
  // its median is the sensor's churn and its IQR is the width of that churn. A multiple
  // of the median alone will not do — on a clean take the median is exactly 0, so any
  // multiple of it collapses to MOVE_FLOOR and the scaling is never exercised, and on a
  // grainy one the median sits high enough that a multiple lands ABOVE the object and
  // eats half the blade. It is the spread that scales with the camera, not the level.
  const acc = new Float32Array(n);
  for (let f = 1; f < frames.length; f++) {
    const cur = frames[f], prv = frames[f - 1];
    for (let p = 0, i = 0; p < n; p++, i += 4) {
      acc[p] += Math.abs(cur[i] - prv[i]) + Math.abs(cur[i + 1] - prv[i + 1]) + Math.abs(cur[i + 2] - prv[i + 2]);
    }
  }
  const samp = [];
  for (let p = 0; p < n; p += 7) samp.push(acc[p]);
  samp.sort((a, b) => a - b);
  const moveThr = Math.max(
    MOVE_FLOOR,
    samp[samp.length >> 1] + MOVE_K * (samp[(samp.length * 3) >> 2] - samp[samp.length >> 2]),
  );

  // The room, per pixel: the MEDIAN over a spread of frames, not the mean. A mean is
  // dragged bright wherever the blade passed, and then the wall itself looks like a
  // deviation in every other frame — the smear comes back as a photographic negative.
  // The median only breaks where the object covers a pixel for most of the take, which
  // is the arm, and the arm is not what we are trying to learn.
  const sel = [];
  for (let f = 0, st = Math.max(1, Math.floor(frames.length / MED_N)); f < frames.length && sel.length < MED_N; f += st) sel.push(frames[f]);
  const k = sel.length, half = k >> 1, tmp = new Float32Array(k);
  const bg = new Float32Array(n * 3);
  for (let p = 0, i = 0, j = 0; p < n; p++, i += 4, j += 3) {
    for (let ch = 0; ch < 3; ch++) {
      for (let f = 0; f < k; f++) tmp[f] = sel[f][i + ch];
      for (let a = 1; a < k; a++) {
        const v = tmp[a];
        let b = a - 1;
        while (b >= 0 && tmp[b] > v) { tmp[b + 1] = tmp[b]; b--; }
        tmp[b + 1] = v;
      }
      bg[j + ch] = tmp[half];
    }
  }

  let sharp = frames[0], bestSharp = -1;
  for (const fr of frames) {
    const e = sharpness(fr, SW, SH);
    if (e > bestSharp) { bestSharp = e; sharp = fr; }
  }

  // The motion mask is a SMEAR — every place the object passed through. Learning
  // colour or length from that would average in the wall it swept over. Intersecting
  // it with "differs from the background in the sharpest frame" cuts the smear back
  // to the object at one instant, which is the only thing worth measuring.
  const gap = new Float32Array(n);
  let gsum = 0, gn = 0;
  for (let p = 0, i = 0, j = 0; p < n; p++, i += 4, j += 3) {
    if (acc[p] < moveThr) continue;
    gap[p] = Math.abs(sharp[i] - bg[j]) + Math.abs(sharp[i + 1] - bg[j + 1]) + Math.abs(sharp[i + 2] - bg[j + 2]);
    gsum += gap[p]; gn++;
  }
  if (!gn) return null;
  const devThr = Math.max(DEV_FLOOR, (0.75 * gsum) / gn);

  const s = scratch(n);
  for (let p = 0; p < n; p++) s.mask[p] = acc[p] >= moveThr && gap[p] >= devThr ? 1 : 0;

  // The moving set is the object AND the arm AND the shoulder behind it, so take the
  // most ELONGATED component, never the biggest — the biggest is the player. When the
  // grip touches the hilt the hand fuses onto the blade and inflates the learned
  // length by a hand's worth; that only loosens the length term in detect(), and the
  // colour gate drops the hand at track time anyway, so it is not worth splitting.
  const { order, comps } = components(s.mask, SW, SH, MIN_AREA);
  let best = null;
  for (const c of comps) {
    const ax = axisOf(order, c.start, c.end, SW);
    if (!best || ax.elong > best.ax.elong) best = { ax, c };
  }
  if (!best || best.ax.elong < MIN_ELONG) return null;

  // Gaussian over the object's own pixels. For a specular object this beats a fixed
  // tolerance: the covariance learns that the blade's colour varies ALONG the grey
  // axis (glint to shadow) and hardly at all across it, so the gate stays wide where
  // steel actually moves and tight everywhere else.
  const { start, end } = best.c, cnt = end - start;
  let sr = 0, sg = 0, sb = 0;
  for (let k = start; k < end; k++) {
    const i = order[k] * 4;
    sr += sharp[i]; sg += sharp[i + 1]; sb += sharp[i + 2];
  }
  const mr = sr / cnt, mg = sg / cnt, mb = sb / cnt;
  let crr = 0, cgg = 0, cbb = 0, crg = 0, crb = 0, cgb = 0;
  for (let k = start; k < end; k++) {
    const i = order[k] * 4;
    const dr = sharp[i] - mr, dg = sharp[i + 1] - mg, db = sharp[i + 2] - mb;
    crr += dr * dr; cgg += dg * dg; cbb += db * db;
    crg += dr * dg; crb += dr * db; cgb += dg * db;
  }
  const vr = crr / cnt + MIN_VAR, vg = cgg / cnt + MIN_VAR, vb = cbb / cnt + MIN_VAR;
  const inv = inv3(vr, crg / cnt, crb / cnt, vg, cgb / cnt, vb);
  if (!inv) return null;

  return {
    mean: [mr, mg, mb], inv,
    // Exact axis-aligned bounding box of the d² < GATE ellipsoid: its extent along
    // channel c is sqrt(GATE * variance_c). detect() rejects on this box first, which
    // is three compares instead of nine multiplies for the ~99% of the frame that is
    // obviously not the object, and it cannot reject anything the full test accepts.
    rad: [Math.sqrt(GATE * vr), Math.sqrt(GATE * vg), Math.sqrt(GATE * vb)],
    len: best.ax.len, wid: best.ax.wid, elong: best.ax.elong,
  };
}

/**
 * Per frame. `prev` is the previous accepted result or null.
 * @returns {{cx,cy,angle,len,ends,quality}|null}
 */
export function detect(pixels, SW, SH, model, prev) {
  if (!pixels || !model?.inv || !model.rad) return null;
  const n = SW * SH, s = scratch(n);
  const [m0, m1, m2] = model.mean, [r0, r1, r2] = model.rad, q = model.inv;

  // Full resolution, no stride: the box pre-reject makes 20k pixels cheap enough at
  // 192x108 that subsampling would only cost accuracy on a 3-px-wide blade.
  s.mask.fill(0, 0, n);
  let cover = 0;
  for (let p = 0, i = 0; p < n; p++, i += 4) {
    const dr = pixels[i] - m0;
    if (dr < -r0 || dr > r0) continue;
    const dg = pixels[i + 1] - m1;
    if (dg < -r1 || dg > r1) continue;
    const db = pixels[i + 2] - m2;
    if (db < -r2 || db > r2 || maha(dr, dg, db, q) >= GATE) continue;
    s.mask[p] = 1;
    cover++;
  }
  // The gate has stopped discriminating — a wall inside the model, or an exposure
  // shift that dragged the whole frame in. Whatever we labelled now would be
  // arbitrary, so report nothing instead of confidently tracking the room.
  if (!cover || cover > MAX_COVER * n) return null;

  const { order, comps } = components(s.mask, SW, SH, MIN_AREA);
  let best = null, bestScore = 0;
  for (const c of comps) {
    const ax = axisOf(order, c.start, c.end, SW);
    let sd = 0;
    for (let k = c.start; k < c.end; k++) {
      const i = order[k] * 4;
      sd += maha(pixels[i] - m0, pixels[i + 1] - m1, pixels[i + 2] - m2, q);
    }
    const shape = clamp01((ax.elong - 1.5) / (MIN_ELONG - 1.5));
    const lenFit = clamp01(1 - Math.abs(ax.len - model.len) / Math.max(8, model.len));
    const colour = clamp01(1 - sd / (ax.n * GATE));
    // Continuity is a bonus, never a gate: the object can jump when the player swings
    // hard, and a first frame after a dropout has no prev to agree with.
    let cont = 1;
    if (prev) {
      const d = Math.hypot(ax.cx - prev.cx, ax.cy - prev.cy) / Math.max(8, prev.len);
      const da = Math.abs(wrapPi(ax.angle - prev.angle));
      cont = 0.6 + 0.4 * clamp01(1 - d) * clamp01(1 - Math.min(da, Math.PI - da) / (Math.PI / 4));
    }
    const score = shape * lenFit * colour * cont;
    if (score > bestScore) { bestScore = score; best = ax; }
  }
  if (!best || bestScore < SCORE_MIN) return null;

  return {
    cx: best.cx, cy: best.cy,
    angle: wrapPi(best.angle),
    len: best.len,
    ends: best.ends,
    quality: clamp01(bestScore),
  };
}
