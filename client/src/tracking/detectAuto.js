// Thin-bar detector. No enrolment, no colour model, no hand — it finds the longest
// thin straight object in the frame and reports its axis.
//
// The key is a VALLEY/RIDGE filter rather than a gradient one. A pixel scores only if
// it is darker (or brighter) than the frame BOTH sides of it, perpendicular to some
// orientation. That one property does all the discriminating:
//   - a real blade is a thin bar -> both flanks differ -> strong response
//   - a door frame, a wall/ceiling seam, a shelf is an EDGE -> only one side differs
//     -> no response. This is why the earlier gradient detector kept locking onto
//     furniture: an edge detector cannot tell a doorway from a sword.
//   - hair, a torso, a dark cupboard are big filled regions -> the interior looks the
//     same a few px either way -> no response.
// It is polarity-agnostic, so a dark katana on a bright ceiling and a bright blade on
// a dark wall both work without being told which to expect.
export const NAME = "auto";

// Probe distances, in px at 192 wide. MULTI-SCALE on purpose: a blade held at arm's
// length is ~3px across, one held close to the camera is ~8px. Probing only narrow
// offsets makes the detector blind to a near blade, because both "flanks" land inside
// it — dark beside dark, no response.
const OFFS = [2, 4, 7, 11];
const MIN_RESP = 12;        // luminance a bar must stand clear of both flanks by
const MIN_LEN = 14;         // shortest thing we will call a blade, in px
const NTH = 90;             // line-vote angle bins (2 deg)
const GAP = 14;             // px of unsupported line we will bridge (see below)
const NEAR = 2.2;           // how close a responding pixel must sit to a line to support it

/** Scratch buffers live on the model so nothing is allocated per frame. */
function buffers(model, SW, SH) {
  const n = SW * SH;
  if (model._n !== n) {
    model._n = n;
    model.lum = new Float32Array(n);
    model.resp = new Float32Array(n);
    model.xs = new Int16Array(n);
    model.ys = new Int16Array(n);
    model.acc = new Float32Array(NTH * (2 * (SW + SH) + 8));
    model.nr = 2 * (SW + SH) + 8;
    model.rho0 = SW + SH + 4;
    model.prevLum = null;      // rho = x*cos+y*sin over theta in [0,pi) spans [-SW, SW+SH]
  }
  return model;
}

// 8 orientations over 180 deg; we probe along each one's PERPENDICULAR.
const DIRS = [];
for (let i = 0; i < 8; i++) {
  const a = (i * Math.PI) / 8 + Math.PI / 2;
  DIRS.push([Math.cos(a), Math.sin(a)]);
}

const COS = new Float32Array(NTH), SIN = new Float32Array(NTH);
for (let t = 0; t < NTH; t++) { const a = (t * Math.PI) / NTH; COS[t] = Math.cos(a); SIN[t] = Math.sin(a); }

export function enroll(frames, SW, SH) {
  // Nothing to learn — the filter is universal.
  return buffers({ _n: -1 }, SW, SH);
}

export function detect(pixels, SW, SH, model, prev) {
  if (!model) return null;
  buffers(model, SW, SH);
  const { lum, resp, xs, ys, acc, nr, rho0 } = model;
  const n = SW * SH;

  for (let i = 0, p = 0; i < n; i++, p += 4) {
    lum[i] = 0.299 * pixels[p] + 0.587 * pixels[p + 1] + 0.114 * pixels[p + 2];
  }

  // Valley/ridge response, and collect the responders so the vote below only walks
  // the handful of pixels that are actually bar-like.
  resp.fill(0);
  const M = OFFS[OFFS.length - 1] + 1;
  let cnt = 0;
  for (let y = M; y < SH - M; y++) {
    for (let x = M; x < SW - M; x++) {
      const i = y * SW + x, c = lum[i];
      let best = 0;
      for (let k = 0; k < 8; k++) {
        const nx = DIRS[k][0], ny = DIRS[k][1];
        for (let q = 0; q < OFFS.length; q++) {
          const d = OFFS[q];
          const a = lum[((y + ny * d) | 0) * SW + ((x + nx * d) | 0)];
          const b = lum[((y - ny * d) | 0) * SW + ((x - nx * d) | 0)];
          const v = Math.max(Math.min(a, b) - c, c - Math.max(a, b));
          if (v > best) best = v;
        }
      }
      if (best > MIN_RESP) { resp[i] = best; xs[cnt] = x; ys[cnt] = y; cnt++; }
    }
  }
  if (cnt < 20) return null;

  // Movement since the last frame. This is the strongest discriminator available in a
  // real room: a wall/shirt boundary, a door frame and a picture frame are all static,
  // and a swung blade is not. It boosts rather than gates, so the blade is still found
  // when held still — it just has less of an edge over the furniture.
  const prevLum = model.prevLum;

  // Vote for straight lines instead of growing connected blobs. A blade crossing a
  // dark shirt loses contrast in the middle and breaks into fragments — connected
  // components see several short stubs and reject them all, while every fragment
  // votes for the SAME line here. Occlusion stops mattering.
  acc.fill(0);
  for (let j = 0; j < cnt; j++) {
    const x = xs[j], y = ys[j], w = resp[y * SW + x];
    for (let t = 0; t < NTH; t++) {
      const r = (x * COS[t] + y * SIN[t] + rho0) | 0;
      acc[t * nr + r] += w;
    }
  }

  // Take the strongest few candidate lines, then judge each by the longest CONTIGUOUS
  // run of support along it — not by its total vote. Total vote rewards a line that
  // happens to clip lots of scattered responders (a horizontal sweep through a door
  // edge, a head and a picture frame all at once); contiguous run is what actually
  // means "a bar lies here".
  const peaks = [];
  for (let t = 0; t < NTH; t++) {
    for (let r = 1; r < nr - 1; r++) {
      const v = acc[t * nr + r];
      if (v <= 0) continue;
      if (v < acc[t * nr + r - 1] || v < acc[t * nr + r + 1]) continue; // local max in rho
      peaks.push([v, t, r]);
    }
  }
  if (!peaks.length) return null;
  peaks.sort((a, b) => b[0] - a[0]);

  const lim = SW + SH;
  let best = null;
  for (let k = 0; k < Math.min(peaks.length, 24); k++) {
    const [, bt, br] = peaks[k];
    const ct = COS[bt], st = SIN[bt];
    const rho = br - rho0;
    const px0 = rho * ct, py0 = rho * st, ux = -st, uy = ct;
    let bestA = 0, bestB = 0, bestLen = -1, runA = null, last = null, mot = 0, motN = 0;
    const motAt = (x, y) => {
      if (!prevLum) return 0;
      const i = ((y | 0) * SW + (x | 0));
      return i >= 0 && i < n ? Math.abs(lum[i] - prevLum[i]) : 0;
    };
    const close = (a, b) => { if (last - runA > bestLen) { bestLen = last - runA; bestA = runA; bestB = last; } };
    for (let t = -lim; t <= lim; t++) {
      const x = px0 + ux * t, y = py0 + uy * t;
      if (x < 0 || y < 0 || x >= SW || y >= SH) { if (runA !== null) { close(); runA = null; } continue; }
      let sup = 0;
      for (let o = -NEAR; o <= NEAR && !sup; o += 1) {
        const sx = (x - st * o) | 0, sy = (y + ct * o) | 0;
        if (sx >= 0 && sy >= 0 && sx < SW && sy < SH && resp[sy * SW + sx]) sup = 1;
      }
      if (sup) { if (runA === null) runA = t; last = t; mot += motAt(x, y); motN++; }
      else if (runA !== null && t - last > GAP) { close(); runA = null; }
    }
    if (runA !== null) close();
    if (bestLen < MIN_LEN) continue;
    let score = bestLen * (1 + 2.2 * Math.min(1, motN ? mot / motN / 10 : 0));
    if (prev && prev._t !== undefined) {
      let dt = Math.abs(bt - prev._t); dt = Math.min(dt, NTH - dt);
      if (dt < 6 && Math.abs(br - prev._r) < 14) score *= 1.4;
    }
    if (!best || score > best.score) {
      best = { score, bt, br, len: bestLen,
        e0: [px0 + ux * bestA, py0 + uy * bestA], e1: [px0 + ux * bestB, py0 + uy * bestB] };
    }
  }
  if (!prevLum) model.prevLum = new Float32Array(n);
  model.prevLum.set(lum);
  if (!best) return null;
  const { e0, e1 } = best;
  return {
    cx: (e0[0] + e1[0]) / 2, cy: (e0[1] + e1[1]) / 2,
    angle: Math.atan2(e1[1] - e0[1], e1[0] - e0[0]),
    len: best.len, ends: [e0, e1],
    quality: Math.min(1, best.len / 70),
    _t: best.bt, _r: best.br,
  };
}
