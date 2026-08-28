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

const OFFS = [3, 5];        // perpendicular probe distances (px at 192 wide): a blade is thin
const MIN_RESP = 16;        // luminance a bar must stand clear of both flanks by
const MIN_LEN = 18;         // shortest thing we will call a blade, in px
const MIN_ELONG = 3.0;      // length:width — rejects blobs
const MOTION_BOOST = 0.9;   // how much recent movement favours a component
const NBR = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];

// 8 orientations over 180 deg. The perpendicular is what we probe along.
const DIRS = [];
for (let i = 0; i < 8; i++) {
  const a = (i * Math.PI) / 8;
  DIRS.push([Math.round(Math.cos(a + Math.PI / 2) * 100) / 100, Math.round(Math.sin(a + Math.PI / 2) * 100) / 100]);
}

/** Scratch buffers live on the model so nothing is allocated per frame. */
function buffers(model, SW, SH) {
  const n = SW * SH;
  if (!model._n || model._n !== n) {
    model._n = n;
    model.lum = new Float32Array(n);
    model.resp = new Float32Array(n);
    model.label = new Int32Array(n);
    model.stack = new Int32Array(n);
    model.prevLum = null;
  }
  return model;
}

export function enroll(frames, SW, SH) {
  // Nothing to learn — the filter is universal. A model object still exists so the
  // scratch buffers and the previous frame have somewhere to live.
  return buffers({}, SW, SH);
}

export function detect(pixels, SW, SH, model, prev) {
  if (!model) return null;
  buffers(model, SW, SH);
  const { lum, resp, label, stack } = model;
  const n = SW * SH;

  for (let i = 0, p = 0; i < n; i++, p += 4) {
    lum[i] = 0.299 * pixels[p] + 0.587 * pixels[p + 1] + 0.114 * pixels[p + 2];
  }

  // Valley/ridge response: strongest "this is a thin bar" score over all orientations.
  resp.fill(0);
  const M = Math.max(...OFFS) + 1;
  for (let y = M; y < SH - M; y++) {
    for (let x = M; x < SW - M; x++) {
      const i = y * SW + x, c = lum[i];
      let best = 0;
      for (const [nx, ny] of DIRS) {
        for (const d of OFFS) {
          const ax = Math.round(x + nx * d), ay = Math.round(y + ny * d);
          const bx = Math.round(x - nx * d), by = Math.round(y - ny * d);
          if (ax < 0 || ay < 0 || bx < 0 || by < 0 || ax >= SW || ay >= SH || bx >= SW || by >= SH) continue;
          const a = lum[ay * SW + ax], b = lum[by * SW + bx];
          // dark bar: both flanks brighter. bright bar: both flanks darker.
          const dark = Math.min(a, b) - c;
          const bright = c - Math.max(a, b);
          const s = Math.max(dark, bright);
          if (s > best) best = s;
        }
      }
      if (best > MIN_RESP) resp[i] = best;
    }
  }

  // Movement since the previous frame, used only to break ties — a swung blade beats a
  // picture frame that happens to also be a thin bar.
  const prevLum = model.prevLum;
  const motion = (i) => (prevLum ? Math.abs(lum[i] - prevLum[i]) : 0);

  label.fill(0);
  let best = null, id = 0;
  for (let s = 0; s < n; s++) {
    if (!resp[s] || label[s]) continue;
    id++;
    let top = 0, count = 0;
    let sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0, mot = 0;
    stack[top++] = s;
    label[s] = id;
    const px = [];
    while (top) {
      const i = stack[--top];
      const x = i % SW, y = (i / SW) | 0;
      count++; px.push(i);
      sx += x; sy += y; sxx += x * x; syy += y * y; sxy += x * y;
      mot += motion(i);
      for (const [dx, dy] of NBR) {
        const nx2 = x + dx, ny2 = y + dy;
        if (nx2 < 0 || ny2 < 0 || nx2 >= SW || ny2 >= SH) continue;
        const j = ny2 * SW + nx2;
        if (resp[j] && !label[j]) { label[j] = id; stack[top++] = j; }
      }
    }
    if (count < 12) continue;

    const mx = sx / count, my = sy / count;
    const cxx = sxx / count - mx * mx, cyy = syy / count - my * my, cxy = sxy / count - mx * my;
    const tr = cxx + cyy, det = cxx * cyy - cxy * cxy;
    const disc = Math.sqrt(Math.max(0, (tr * tr) / 4 - det));
    const l1 = tr / 2 + disc, l2 = Math.max(1e-3, tr / 2 - disc);
    const elong = Math.sqrt(l1 / l2);
    if (elong < MIN_ELONG) continue;

    // Principal axis, then the extreme projections onto it are the two ends.
    const angle = 0.5 * Math.atan2(2 * cxy, cxx - cyy);
    const ux = Math.cos(angle), uy = Math.sin(angle);
    let lo = Infinity, hi = -Infinity, loI = px[0], hiI = px[0];
    for (const i of px) {
      const t = ((i % SW) - mx) * ux + (((i / SW) | 0) - my) * uy;
      if (t < lo) { lo = t; loI = i; }
      if (t > hi) { hi = t; hiI = i; }
    }
    const len = hi - lo;
    if (len < MIN_LEN) continue;

    let score = len * Math.min(elong, 8) * (1 + MOTION_BOOST * Math.min(1, mot / count / 12));
    // Stay on what we were already tracking rather than hopping to a rival bar.
    if (prev) {
      const d = Math.hypot(mx - prev.cx, my - prev.cy);
      if (d < 30) score *= 1.6;
    }
    if (!best || score > best.score) {
      best = {
        score, cx: mx, cy: my, angle, len,
        ends: [[loI % SW, (loI / SW) | 0], [hiI % SW, (hiI / SW) | 0]],
        quality: Math.min(1, (len / 60) * Math.min(1, elong / 6)),
      };
    }
  }

  model.prevLum = Float32Array.from(lum);
  if (!best) return null;
  return { cx: best.cx, cy: best.cy, angle: best.angle, len: best.len, ends: best.ends, quality: best.quality };
}
