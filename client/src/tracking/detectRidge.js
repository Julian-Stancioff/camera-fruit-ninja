// Katana mode, STRUCTURE detector. No hand, no anchor, no colour.
//
// A mirror-finish blade reflects the room: its average colour can sit two RGB units
// from the wall behind it and change as it rotates, so any appearance model is dead on
// arrival. What polish cannot take away is GEOMETRY — the blade is a long straight bar,
// and a bar draws TWO parallel high-gradient edges. So this detector reads the
// luminance gradient field and nothing else.
//
// Cost: a textbook Hough votes every edge pixel into every angle bin — 90 votes each.
// Here each edge pixel votes for the ONE axis angle perpendicular to its own gradient
// (plus ±1 bin for noise), so 3 votes, and only the few percent of pixels that clear an
// adaptive magnitude threshold vote at all. That is what makes atan2 affordable and
// keeps the whole pass at ~0.36ms at 192x108, an order under the 4ms budget.
//
// Motion blur: a fast swing smears the blade over 10-20px, which both WEAKENS its edges
// and WIDENS it — and that is the exact moment the player needs the blade tracked. Four
// things keep it alive rather than one loose threshold: the vote cut is a PERCENTILE of
// this frame's own gradients, so when everything softens the strongest structure still
// gets through; the flank probes run from the enrolled half-width OUT to +2px; the walk
// accepts a flank at 35% of the enrolled edge strength; and a soft edge keeps 40% of its
// quality outright. Quality drops on a swing, the blade does not disappear.

export const NAME = "ridge";

const NA = 90;          // axis-angle bins over [0,π): 2° each, refined sub-bin below
const KEEP = 0.06;      // share of pixels kept as "edge" — a percentile, not a constant
const MAG_FLOOR = 16;   // sobel L1 of a ~4-level step; under this it is sensor noise
const WALK_FRAC = 0.35; // flank strength a blurred blade must still show (see above)
const MISS = 6;         // px of gap a supported run may bridge (a glint, a hand, a knot)
const H_MAX = 6;        // widest half-width tried at enrolment (12px bar at 192 wide)
const MIN_LEN = 18;     // px: shorter than this is not a sword, it is a pen
const MOVE_T = 7;       // luma deviation from a pixel's own temporal mean = "it moved"
const SCAN_FRAMES = 10; // enrolment frames actually used — ~1s of camera is 30, and the
                        // extra 20 buy nothing but a linear enrol cost
const CONT_GAIN = 0.6;  // how much continuity with prev may outrank raw evidence
const PEAK_FLOOR = 0.1; // fraction of the best response a candidate must reach
const MIN_Q = 0.15;
const CANDS = 12;

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
// Axis angles are unordered (the caller decides which end is the hilt), so differences
// live mod π, not mod 2π.
const wrapHalf = (a) => {
  const t = ((a % Math.PI) + Math.PI) % Math.PI;
  return t > Math.PI / 2 ? t - Math.PI : t;
};

// One set of scratch buffers, reused for the life of the page. Nothing here is
// allocated per frame. ponytail: module-level, so one camera loop at a time.
let S = null;
function scratch(SW, SH) {
  if (S && S.SW === SW && S.SH === SH) return S;
  // ρ = y·cosθ − x·sinθ with θ in [0,π), so sinθ ≥ 0 and the −x·sinθ term only ever
  // subtracts: ρ runs from −hypot(SW,SH) up to +SH, NOT the symmetric range it looks
  // like. Sizing the row to SW+SH sent bottom-right votes at θ≈120° to a negative index,
  // which silently landed in the PREVIOUS angle row — hundreds of corrupted votes a
  // frame. RHO0 must clear the full diagonal; the margin covers the ±hHi flank probes.
  const N = SW * SH, RHO0 = Math.ceil(Math.hypot(SW, SH)) + H_MAX + 3;
  const NR = RHO0 + SH + H_MAX + 3;
  const cos = new Float32Array(NA), sin = new Float32Array(NA);
  for (let a = 0; a < NA; a++) {
    const t = (a * Math.PI) / NA;
    cos[a] = Math.cos(t); sin[a] = Math.sin(t);
  }
  S = {
    SW, SH, NR, RHO0, cos, sin,
    lum: new Uint8Array(N), gx: new Int16Array(N), gy: new Int16Array(N),
    mag: new Uint16Array(N), hist: new Uint32Array(64),
    acc: new Float32Array(NA * NR), sm: new Float32Array(NA * NR), resp: new Float32Array(NA * NR),
  };
  return S;
}

function luma(px, lum, N) {
  for (let i = 0, j = 0; i < N; i++, j += 4) lum[i] = (px[j] * 77 + px[j + 1] * 150 + px[j + 2] * 29) >> 8;
}

// Sobel + a 64-bucket magnitude histogram in the same pass, so the adaptive threshold
// is free. Borders stay 0 from allocation and are never read as evidence.
function sobel(s) {
  const { SW, SH, lum, gx, gy, mag, hist } = s;
  hist.fill(0);
  for (let y = 1; y < SH - 1; y++) {
    let i = y * SW + 1;
    for (let x = 1; x < SW - 1; x++, i++) {
      const a = lum[i - SW - 1], b = lum[i - SW], c = lum[i - SW + 1];
      const d = lum[i - 1], e = lum[i + 1];
      const f = lum[i + SW - 1], g = lum[i + SW], h = lum[i + SW + 1];
      const X = c + 2 * e + h - (a + 2 * d + f);
      const Y = f + 2 * g + h - (a + 2 * b + c);
      gx[i] = X; gy[i] = Y;
      const m = (X < 0 ? -X : X) + (Y < 0 ? -Y : Y); // L1: thresholding does not need hypot
      mag[i] = m;
      hist[m >> 5]++;
    }
  }
}

function cutoff(hist, total, keep) {
  let want = total * keep, run = 0, b = 63;
  for (; b > 0; b--) { run += hist[b]; if (run >= want) break; }
  return Math.max(MAG_FLOOR, b << 5);
}

// Directed vote. mask (enrolment only) restricts voting to pixels that moved.
function vote(s, cut, mask) {
  const { SW, SH, gx, gy, mag, acc, cos, sin, NR, RHO0 } = s;
  acc.fill(0);
  let n = 0;
  for (let y = 1; y < SH - 1; y++) {
    let i = y * SW + 1;
    for (let x = 1; x < SW - 1; x++, i++) {
      const m = mag[i];
      if (m < cut || (mask && !mask[i])) continue;
      n++;
      let t = Math.atan2(gy[i], gx[i]) + Math.PI / 2; // structure axis ⟂ gradient
      t -= Math.PI * Math.floor(t / Math.PI);
      const a0 = Math.round((t * NA) / Math.PI) % NA;
      for (let k = -1; k <= 1; k++) {
        const a = (a0 + k + NA) % NA;
        // ρ is recomputed from the target bin's OWN axis, so wrapping across θ=0/π —
        // where the normal flips sign, i.e. every near-horizontal blade — needs no case.
        const ri = Math.round(y * cos[a] - x * sin[a]) + RHO0;
        acc[a * NR + ri] += m;
      }
    }
  }
  return n;
}

// 3-tap blur along ρ. A 64px line one angle bin off is displaced ~2px, so its votes
// smear across neighbouring ρ; without this the true peak loses to a short crisp one.
function smooth(s) {
  const { acc, sm, NR } = s;
  for (let a = 0; a < NA; a++) {
    const o = a * NR;
    sm[o] = 0; sm[o + NR - 1] = 0;
    for (let r = 1; r < NR - 1; r++) sm[o + r] = acc[o + r - 1] + acc[o + r] + acc[o + r + 1];
  }
}

// THE test that separates a bar from a shadow: score a line by its WEAKER flank. A door
// frame, a shadow boundary or a table edge has one strong side and nothing at ±h on the
// other, so min() puts it near zero however bright it is.
function respond(s, hLo, hHi) {
  const { sm, resp, NR } = s;
  resp.fill(0);
  let max = 0;
  for (let a = 0; a < NA; a++) {
    const o = a * NR;
    for (let r = hHi; r < NR - hHi; r++) {
      let v = 0;
      for (let h = hLo; h <= hHi; h++) {
        const lo = sm[o + r - h], hi = sm[o + r + h];
        const m = lo < hi ? lo : hi;
        if (m > v) v = m;
      }
      resp[o + r] = v;
      if (v > max) max = v;
    }
  }
  return max;
}

// Local maxima along ρ, then NMS on the actual LINES (ρ is not comparable across angle
// bins, so peaks cannot be compared in accumulator space).
function peaks(s, max) {
  const { resp, NR, RHO0, cos, sin, SW, SH } = s;
  // A long bright background line outvotes a short blade by its length alone, so the
  // floor is deliberately low and the ranking is left to the walk, which knows the
  // model's width and length. Cheap: a rejected candidate costs one line walk.
  const floor = PEAK_FLOOR * max, cx0 = SW / 2, cy0 = SH / 2, all = [];
  for (let a = 0; a < NA; a++) {
    const o = a * NR;
    for (let r = 2; r < NR - 2; r++) {
      const v = resp[o + r];
      if (v < floor || v < resp[o + r - 1] || v < resp[o + r + 1]) continue;
      all.push({ a, r, v, dc: r - RHO0 - (cy0 * cos[a] - cx0 * sin[a]) });
    }
  }
  all.sort((p, q) => q.v - p.v);
  const out = [];
  for (const p of all) {
    if (out.length >= CANDS) break;
    let dup = false;
    for (const k of out) {
      const raw = Math.abs(p.a - k.a), wrapped = raw > NA / 2;
      const da = wrapped ? NA - raw : raw;
      // Across the θ=0/π seam the normal flips, so the same line reports opposite dc.
      const dd = wrapped ? Math.abs(p.dc + k.dc) : Math.abs(p.dc - k.dc);
      if (da <= 3 && dd <= 6) { dup = true; break; }
    }
    if (!dup) out.push(p);
  }
  return out;
}

// Walk the candidate line and report the extent over which BOTH flanks hold up. That
// extent is the object's endpoints — not the infinite line, not the accumulator peak.
function walk(s, a, rho, hLo, hHi, thr) {
  const { SW, SH, mag, cos, sin } = s;
  const c = cos[a], sn = sin[a];
  const ox = -rho * sn, oy = rho * c, nx = -sn, ny = c;
  const at = (x, y) => (x < 0 || y < 0 || x > SW - 1 || y > SH - 1 ? 0 : mag[((y + 0.5) | 0) * SW + ((x + 0.5) | 0)]);
  const tMax = Math.ceil(Math.hypot(SW, SH));
  // Slack runs OUTWARD only. Probing inside hLo lets a 1px background line — a cable, a
  // shelf edge — satisfy both flanks off its own single ridge and pass as a bar.
  const h1 = hHi + 1;
  let run0 = 0, last = null, sum = 0, cnt = 0;
  let bT0 = 0, bT1 = -1, bSum = 0, bCnt = 0;
  const close = () => {
    if (last !== null && last - run0 > bT1 - bT0) { bT0 = run0; bT1 = last; bSum = sum; bCnt = cnt; }
  };
  for (let t = -tMax; t <= tMax; t++) {
    const px = ox + t * c, py = oy + t * sn;
    if (px < 1 || py < 1 || px > SW - 2 || py > SH - 2) continue;
    let A = 0, B = 0;
    for (let h = hLo; h <= h1; h++) {
      const u = at(px + h * nx, py + h * ny); if (u > A) A = u;
      const w = at(px - h * nx, py - h * ny); if (w > B) B = w;
    }
    const m = A < B ? A : B;
    if (m < thr) continue;
    if (last === null || t - last > MISS) { close(); run0 = t; sum = 0; cnt = 0; }
    last = t; sum += m; cnt++;
  }
  close();
  const len = bT1 - bT0;
  if (len < 1 || !bCnt) return null;
  const tc = (bT0 + bT1) / 2;
  return { len, frac: bCnt / (len + 1), mag: bSum / bCnt, cx: ox + tc * c, cy: oy + tc * sn, angle: Math.atan2(sn, c) };
}

/**
 * Motion is used for exactly one thing: deciding WHICH straight line is the object.
 * A door frame, a shelf edge and a poster all sit on their own temporal mean forever;
 * a swung blade does not. Nothing about colour is kept — that is this detector's point.
 */
export function enroll(frames, SW, SH) {
  if (!frames || frames.length < 2) return null;
  const N = SW * SH, s = scratch(SW, SH);
  const step = Math.max(1, Math.floor(frames.length / SCAN_FRAMES));
  const use = [];
  for (let k = 0; k < frames.length; k += step) use.push(frames[k]);
  if (use.length < 2) return null;

  const mean = new Float32Array(N);
  for (const f of use) {
    for (let i = 0, j = 0; i < N; i++, j += 4) mean[i] += (f[j] * 77 + f[j + 1] * 150 + f[j + 2] * 29) >> 8;
  }
  for (let i = 0; i < N; i++) mean[i] /= use.length;

  const mask = new Uint8Array(N), total = (SW - 2) * (SH - 2);
  let best = null;
  for (const frame of use) {
    luma(frame, s.lum, N);
    let moving = 0;
    for (let i = 0; i < N; i++) {
      const d = s.lum[i] - mean[i];
      mask[i] = d > MOVE_T || d < -MOVE_T ? 1 : 0;
      moving += mask[i];
    }
    if (moving < 60) continue; // object held still in this frame — no way to single it out
    sobel(s);
    const cut = cutoff(s.hist, total, KEEP);
    if (!vote(s, cut, mask)) continue;
    smooth(s);
    // Sweep the half-width. A wrong h puts the flank probes off the real edges, so the
    // supported fraction collapses — the width falls out of the same score as the line.
    for (let h = 1; h <= H_MAX; h++) {
      const max = respond(s, h, h);
      if (max <= 0) continue;
      for (const p of peaks(s, max)) {
        const g = walk(s, p.a, p.r - s.RHO0, h, h, Math.max(MAG_FLOOR, 0.5 * cut));
        if (!g || g.len < MIN_LEN) continue;
        const sc = g.frac * g.len;
        if (!best || sc > best.sc) best = { sc, len: g.len, h, mag: g.mag };
      }
    }
  }
  if (!best) return null;
  return { len: best.len, halfW: best.h, edgeMag: best.mag, sw: SW, sh: SH };
}

/** @returns {{cx,cy,angle,len,ends,quality}|null} */
export function detect(pixels, SW, SH, model, prev) {
  if (!model) return null;
  const s = scratch(SW, SH);
  const scale = model.sw ? Math.hypot(SW, SH) / Math.hypot(model.sw, model.sh) : 1;
  const L = model.len * scale;
  const hLo = Math.max(1, Math.round(model.halfW * scale)), hHi = hLo + 1;
  luma(pixels, s.lum, SW * SH);
  sobel(s);
  if (!vote(s, cutoff(s.hist, (SW - 2) * (SH - 2), KEEP), null)) return null;
  smooth(s);
  const max = respond(s, hLo, hHi);
  if (max <= 0) return null;

  const thr = Math.max(MAG_FLOOR, WALK_FRAC * model.edgeMag);
  let best = null;
  for (const p of peaks(s, max)) {
    const g = walk(s, p.a, p.r - s.RHO0, hLo, hHi, thr);
    if (!g || g.len < 0.3 * L) continue;
    // Asymmetric length fit: a blade pointed at the camera foreshortens and is still the
    // blade, but a line twice as long as the sword is the edge of a table.
    const lenFit = g.len <= L ? 0.4 + 0.6 * (g.len / L) : Math.max(0, 1 - (g.len - L) / L);
    // Edge strength counts, but a blurred swing keeps 40% of its credit outright —
    // losing the blade mid-swing is worse than trusting a soft one.
    const q = clamp01(g.frac * lenFit * (0.4 + 0.6 * Math.min(1, g.mag / model.edgeMag)));
    let sc = q;
    if (prev) {
      // Continuity is a BONUS, never a gate: a real swing turns 40°/frame and a hard
      // search window would drop the blade exactly when the player is using it.
      const dA = wrapHalf(g.angle - prev.angle) / 0.5;
      const dP = Math.hypot(g.cx - prev.cx, g.cy - prev.cy) / 30;
      sc *= 1 + CONT_GAIN * Math.exp(-dA * dA - dP * dP);
    }
    if (!best || sc > best.sc) best = { sc, q, g, a: p.a };
  }
  if (!best || best.q < MIN_Q) return null;

  // Sub-bin angle: 2° bins would stair-step a sword visibly. Re-read the two neighbouring
  // angle bins at the ρ the SAME physical line has there, then fit a parabola.
  const { g, a } = best, { NR, RHO0, cos, sin, resp } = s;
  const rAt = (i) => Math.round(g.cy * cos[i] - g.cx * sin[i]) + RHO0;
  const am = (a + NA - 1) % NA, ap = (a + 1) % NA;
  const v0 = resp[a * NR + rAt(a)], vm = resp[am * NR + rAt(am)], vp = resp[ap * NR + rAt(ap)];
  const den = vm - 2 * v0 + vp;
  const d = den < 0 ? Math.max(-1, Math.min(1, (0.5 * (vm - vp)) / den)) : 0;
  const angle = ((a + d) * Math.PI) / NA;

  const hl = g.len / 2, ex = Math.cos(angle) * hl, ey = Math.sin(angle) * hl;
  return {
    cx: g.cx, cy: g.cy, angle, len: g.len,
    ends: [[g.cx - ex, g.cy - ey], [g.cx + ex, g.cy + ey]],
    quality: best.q,
  };
}
