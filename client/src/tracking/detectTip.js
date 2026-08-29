// Tip-only detector: the blade as a single moving POINT, not an axis. SPARE PART —
// built on purpose and deliberately NOT wired in; see TIP_MODE.md. Nothing imports
// this file, so Vite never bundles it into the shipped app.
//
// The bet: "find the extremity of the novel foreground" is a fundamentally easier
// problem than fitting the blade's axis. No line vote, no run walk, no polarity, no
// hilt/tip disambiguation — and it degrades more gracefully under the motion blur
// that defeats axis fitting, because a smeared blade still has a leading extremity
// even when no straight line survives in the pixels.
//
// What carries over from the axis effort (in measured order of value) and what is
// deliberately gone:
//   KEPT - a per-pixel BACKGROUND MODEL — of raw luminance here, not valley response,
//          because a point needs foreground, not bar-ness. Static furniture is out of
//          the contest after one frame; this was the single highest-value mechanism
//          of the whole katana effort (37% of the real room lit -> ~0%).
//   KEPT - moving pixels are never learned (the room is what holds still), and a
//          freeze disc around the tracked tip stops a held-still blade from absorbing
//          itself. Probation first: a warm-up mistake is learned away, never frozen.
//   KEPT - deadbanded reporting, velocity coasting through missed frames, and a
//          speed-adaptive faint-evidence window — blur thins the tip's coverage below
//          the foreground threshold exactly when the lock is moving fast.
//   KEPT - a SLOW ROOM MEMORY (bgS). Without it, the shaft the background absorbs
//          while the blade dwells becomes a ghost trench the moment the blade leaves,
//          the lock slides onto the ghost, and the freeze disc then protects it
//          forever — measured here as 52/52 hallucinated frames after the sword left.
//          A pixel returning to the level it has LONG held is occluded room
//          re-emerging, and snaps bg home — even inside the freeze disc, which is
//          safe for luminance (a blade at the room's own luma is invisible anyway).
//   GONE - the Hough vote, run walking, polarity consistency, endpoint pairing, the
//          rigid-body dead reckoning. An axis needs all of that; a point needs none.
//
// Self-contained on purpose (zero imports) so it can be pasted into a live page for
// testing. Coordinates are small-canvas pixels (192x108 typically), y down, x
// unmirrored. `prev` is accepted for contract parity with detectAuto but the lock
// lives on the model, which survives caller resets — same arrangement detectAuto uses.
export const NAME = "tip";

const FG_T = 16;        // foreground: |lum - bg| must clear this. Sensor grain
                        // measures ~5 luma on the real camera; 16 is 3x clear of it,
                        // and blade-over-wall contrast in the dim room is ~45.
const FG_FAINT = 8;     // accepted near the predicted tip while the lock is FAST:
                        // blur spreads the tip's coverage thin, and its diff lands in
                        // 8..16 exactly when speed is high. Still above the grain.
const FAINT_R = 26;     // ...within this radius of the predicted tip only, so grain
                        // excursions elsewhere never become candidates
const FAINT_SPD = 5;    // px/frame of lock speed before faint evidence is trusted
const MOVE_T = 8;       // |luma delta| above this = the pixel is MOVING and is never
                        // learned as background: the room is what holds still
const BG_UP = 1 / 300;  // ~10s at 30fps once warm; cold it is a running mean via
                        // max(BG_UP, 1/(n+1)) so frame 1 learns the room outright
const GHOST_UP = 0.08;  // a STATIC pixel far off its background is a parked shaft or
                        // a ghost trench (bg absorbed the blade, the blade moved on).
                        // Luminance has no "vanished" test the way valley response
                        // does — this is its stand-in: novelty that neither moves nor
                        // sits under the tip's freeze disc decays in ~0.5s, not 10.
const GLUT = 0.30;      // foreground fraction that means the WORLD changed (exposure
                        // shift, camera bump), not that a sword appeared. Far above a
                        // player walking into frame (~15-20% of it).
const GLUT_UP = 0.15;   // catch-up rate on glut frames — at BG_UP the room would stay
                        // wrong for 10 blind seconds after every exposure shift
const FREEZE_R = 8;     // freeze disc radius around the lock: a held-still tip must
                        // not be absorbed. Small on purpose — the shaft is ALLOWED to
                        // absorb; only the point the game follows needs protecting.
const BG_WARM_MIN = 5;  // frames of bg before any freeze is honored (probation:
                        // whatever latched while the room still had raw evidence is
                        // learned away instead of frozen novel forever)
const BGS_UP = 1 / 600; // slow room memory rate (~20s at 30fps). Seeded outright from
                        // frame 1 and NEVER cold-ramped: a running-mean warm-up let a
                        // 2s blade dwell rewrite the "long-held" level to the blade
                        // itself, and recovery then had no room left to recover
const BGS_MATURE = 30;  // frames before bgS genuinely means LONG-known
const REC_T = 10;       // |lum - bgS| under this = the room re-emerged. Above the
                        // 5-luma grain, far under blade-over-wall contrast (~45)
const LOCK_AGE = 3;     // consecutive confirmations before a lock earns its disc
const MIN_FG = 6;       // fewer strict foreground pixels than this = nothing in frame
const MIN_MASS = 3;     // the winner needs company in its refine window: a tip is the
                        // end of something contiguous, never a lone speckle
const DEAD = 1.5;       // report deadband, px: measured wobble under this is grain
const PULL_FULL = 8;    // px of measured change at which the report snaps 1:1
const VEL_REF = 10;     // speed at which the deadband is fully open — the 1-euro
                        // idea: the clamp that pins a held-still tip is exactly what
                        // would starve a fast swing
const VEL_MIX = 0.5;    // how fast the velocity estimate follows the measured step
const VEL_CAP = 24;     // px/frame ceiling so one bad frame cannot fling the tip
const COAST_MAX = 4;    // missed frames bridged on velocity before reports stop —
                        // one blurred or contrast-dead frame must not cost the game
                        // its cursor
const MISS_MAX = 12;    // missed frames before the lock is forgotten
const LOCK_R = 40;      // continuity bonus radius around the predicted tip...
const LOCK_W = 30;      // ...and its peak weight. Deliberately smaller than the
                        // extremity+motion margin a real swing produces (~45), so the
                        // true tip can always break a wrongly-latched lock.
const UP_W = 1.0;       // upper-end prior: you hold a sword below its tip — the same
                        // physical prior ObjectBlade's hiltEnd hard-codes. STRONG on
                        // purpose: raw distance-from-centroid measurably handed the
                        // lock to a 3px fragment of the blade's BASE (lit up over a
                        // black clutter pit) 55px below the foreground mass, and no
                        // continuity bonus could hand it back. Near-horizontal poses
                        // contribute ~0 difference, so mid-swing it decides nothing —
                        // continuity and motion carry the identity there.
const DENS_W = 2;       // per-neighbour bonus: a tip backed by a contiguous stub
                        // outranks an isolated speck of equal extremity
const MO_W = 0.75;      // per-pixel motion bonus: the tip end sweeps the longest arc,
const MO_CAP = 20;      // so its freshly covered pixels carry the biggest luma delta
const JUMP_BASE = 15;   // translation gate: a tip cannot teleport. Junk picked up
const JUMP_GROW = 8;    // while blind sits far away; the allowance grows per missed
                        // frame and with measured speed so a fast blade stays reachable
const MO_ESCAPE = 12;   // ...unless the winner is heavily moving — a genuine swing
                        // breaking a wrongly-latched still lock must stay possible

/** Scratch buffers live on the model so nothing is allocated per frame. */
function buffers(model, SW, SH) {
  const n = SW * SH;
  if (model._n !== n) {
    model._n = n;
    model.lum = new Float32Array(n);
    model.bg = new Float32Array(n);
    model.bgS = new Float32Array(n);  // slow room memory: what a pixel has LONG held
    model.prevLum = null;
    model.mask = new Uint8Array(n);   // this frame's candidate set, for the
    model.xs = new Int16Array(n);     // contiguity test in scoring
    model.ys = new Int16Array(n);
    model.bgN = 0;
    model.lock = null;   // {x, y, px, py, vx, vy, spd, miss, age} — x/y is the
                         // deadbanded report, px/py the raw measurement it derives
                         // from (velocity must be measured raw-to-raw, or smoothing
                         // understates every swing). Survives caller resets.
  }
  return model;
}

// Learn the room from this frame. Moving pixels are skipped (a swung blade and the
// player never enter bg), the freeze disc around an earned lock holds still (a
// held-still tip must not absorb itself), and STATIC novelty decays fast — ghost
// trenches and parked shafts are the price of a luminance background, and letting
// them ride for 10s of BG_UP measurably left decoy extremities behind every swing.
function learnBg(model, SW, SH, glut) {
  const { lum, bg, bgS, prevLum } = model;
  const L = model.lock;
  const up = Math.max(BG_UP, 1 / (model.bgN + 1));
  const upS = model.bgN === 0 ? 1 : BGS_UP;
  const upG = glut ? Math.max(up, GLUT_UP) : up;
  const frz = L && L.age >= LOCK_AGE && model.bgN >= BG_WARM_MIN;
  const fx = frz ? L.x : 0, fy = frz ? L.y : 0;
  const R2 = FREEZE_R * FREEZE_R;
  const fastOk = model.bgN >= BG_WARM_MIN;
  const mature = model.bgN >= BGS_MATURE;
  for (let y = 0, i = 0; y < SH; y++) {
    for (let x = 0; x < SW; x++, i++) {
      if (prevLum) { const dm = lum[i] - prevLum[i]; if (dm > MOVE_T || dm < -MOVE_T) continue; }
      const d = lum[i] - bg[i];
      // Recovery: a pixel far off bg but back at the level it has LONG held is
      // occluded room re-emerging (the ghost trench an absorbed shaft leaves), not
      // novelty — snap bg home. This pierces the freeze disc on purpose: a held
      // blade never matches bgS while present (it would be invisible if it did), so
      // unlike the valley detector's band there is nothing here for piercing to eat.
      if (mature && (d > FG_T || d < -FG_T)) {
        const dS = lum[i] - bgS[i];
        if (dS < REC_T && dS > -REC_T) { bg[i] += d * 0.5; continue; }
      }
      // Inside the disc both models hold still: bg rises would absorb a held tip,
      // and bgS following the blade would turn recovery into fast tip absorption.
      // Recovery above still pierces the disc, so a ghost the lock slides onto is
      // killed even while the disc is parked right on top of it.
      if (frz) { const ax = x - fx, ay = y - fy; if (ax * ax + ay * ay < R2) continue; }
      bgS[i] += (lum[i] - bgS[i]) * upS;
      const r = fastOk && (d > FG_T || d < -FG_T) ? Math.max(upG, GHOST_UP) : upG;
      bg[i] += d * r;
    }
  }
  model.bgN++;
}

export function enroll(frames, SW, SH) {
  // Nothing to learn — the background model warms itself over the first few live
  // detect() calls, exactly as detectAuto does. (The caller hands one frame.)
  return buffers({ _n: -1 }, SW, SH);
}

export function detect(pixels, SW, SH, model, prev) {
  if (!model) return null;
  buffers(model, SW, SH);
  const { lum, bg, mask, xs, ys } = model;
  const n = SW * SH;

  for (let i = 0, p = 0; i < n; i++, p += 4) {
    lum[i] = 0.299 * pixels[p] + 0.587 * pixels[p + 1] + 0.114 * pixels[p + 2];
  }
  const prevLum = model.prevLum;
  const L = model.lock;
  const predX = L ? L.x + L.vx : 0, predY = L ? L.y + L.vy : 0;

  // Every exit learns the room from this frame — a room the detector is failing in
  // is still a room — and rolls prevLum forward. Misses age the lock; MISS_MAX of
  // them and it is forgotten, so a lowered sword does not haunt the next raise.
  const finish = (hit, glut) => {
    learnBg(model, SW, SH, glut);
    if (!model.prevLum) model.prevLum = new Float32Array(n);
    model.prevLum.set(lum);
    if (!hit && model.lock && ++model.lock.miss > MISS_MAX) model.lock = null;
    return hit;
  };

  // Every would-be miss routes through here. A lock with real speed dead-reckons
  // along its velocity for a few frames instead of dropping; a still lock (spd ~0)
  // gets no coasting — for it this is exactly finish(null).
  const coastOut = (glut) => {
    const C = model.lock;
    if (!(C && C.spd > 1.5 && C.miss < COAST_MAX)) return finish(null, glut);
    C.miss++;
    C.x += C.vx; C.y += C.vy;
    // damp hard: extrapolation overshoots worst exactly where misses cluster, the
    // stroke reversal, where the tip dwells while the prediction sails on
    C.vx *= 0.75; C.vy *= 0.75; C.spd *= 0.75;
    return finish({ x: C.x, y: C.y, quality: 0.25 }, glut);
  };

  // Foreground collection. Strict pixels (diff > FG_T) are real novelty anywhere in
  // frame and feed the centroid; faint pixels (FG_FAINT..FG_T) are admitted only
  // inside the disc ahead of a FAST lock — that is where a motion-blurred tip lives,
  // and nowhere else is worth the false-positive risk.
  mask.fill(0);
  const faint = L && L.spd > FAINT_SPD;
  const fr2 = FAINT_R * FAINT_R;
  let cnt = 0, fgN = 0, sx = 0, sy = 0, sw = 0;
  for (let y = 0, i = 0; y < SH; y++) {
    for (let x = 0; x < SW; x++, i++) {
      let d = lum[i] - bg[i];
      if (d < 0) d = -d;
      if (d <= FG_FAINT) continue;
      if (d <= FG_T) {
        if (!faint) continue;
        const ax = x - predX, ay = y - predY;
        if (ax * ax + ay * ay > fr2) continue;
      } else {
        fgN++; sx += x * d; sy += y * d; sw += d;
      }
      mask[i] = 1; xs[cnt] = x; ys[cnt] = y; cnt++;
    }
  }

  // Whole-room foreground is never a blade arriving — learn it (fast) and stay
  // quiet, unless a healthy lock is already mid-track (mirror of detectAuto's glut
  // gate). Frame 1 lands here by construction and cold-learns the room outright.
  if (fgN > GLUT * n && !(L && L.miss === 0)) return coastOut(true);
  if (fgN < MIN_FG) return coastOut(false);

  // Score every candidate as a TIP: an extremity of the foreground (far from its
  // mass), preferably upper (cold tie-break between the two ends of a bare blade),
  // preferably moving (the leading end covers fresh pixels), preferably where the
  // lock predicts it (continuity). No axis anywhere in this.
  const cx = sx / sw, cy = sy / sw;
  let bi = -1, bs = -1e9;
  for (let j = 0; j < cnt; j++) {
    const x = xs[j], y = ys[j];
    if (x < 1 || y < 1 || x >= SW - 1 || y >= SH - 1) continue;
    const i = y * SW + x;
    // contiguity: a tip is the end of something — a candidate with no candidate
    // neighbours is bg-model noise near a hard edge, not a blade
    const nb = mask[i - 1] + mask[i + 1] + mask[i - SW] + mask[i + SW] +
      mask[i - SW - 1] + mask[i - SW + 1] + mask[i + SW - 1] + mask[i + SW + 1];
    if (!nb) continue;
    const ex = x - cx, ey = y - cy;
    let s = Math.sqrt(ex * ex + ey * ey) + UP_W * (SH - y) + DENS_W * nb;
    if (prevLum) {
      let m = lum[i] - prevLum[i];
      if (m < 0) m = -m;
      s += MO_W * (m > MO_CAP ? MO_CAP : m);
    }
    if (L) {
      const ax = x - predX, ay = y - predY;
      const dp = Math.sqrt(ax * ax + ay * ay);
      if (dp < LOCK_R) s += LOCK_W * (1 - dp / LOCK_R);
    }
    if (s > bs) { bs = s; bi = j; }
  }
  if (bi < 0) return coastOut(false);

  // Sub-pixel refine: diff-weighted centroid of the foreground in a 5x5 window.
  // Pulls the report ~1px inward along the blade (the window sees shaft, never
  // beyond-tip) — a stable bias, which the deadband then holds perfectly still.
  const wx = xs[bi], wy = ys[bi];
  let rx = 0, ry = 0, rw = 0, sup = 0;
  const y0 = wy - 2 < 0 ? 0 : wy - 2, y1 = wy + 2 >= SH ? SH - 1 : wy + 2;
  const x0 = wx - 2 < 0 ? 0 : wx - 2, x1 = wx + 2 >= SW ? SW - 1 : wx + 2;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const i = y * SW + x;
      let d = lum[i] - bg[i];
      if (d < 0) d = -d;
      if (d <= FG_FAINT) continue;
      rx += x * d; ry += y * d; rw += d; sup++;
    }
  }
  if (sup < MIN_MASS) return coastOut(false);
  const mx = rx / rw, my = ry / rw;
  const q = sup / 8 > 1 ? 1 : sup / 8;

  if (!L) {
    model.lock = { x: mx, y: my, px: mx, py: my, vx: 0, vy: 0, spd: 0, miss: 0, age: 1 };
    return finish({ x: mx, y: my, quality: q }, false);
  }

  // Teleport gate: junk that wins while the tip is blind sits far from the
  // prediction (measured on the axis detector: 36-70px; honest re-captures a few px
  // to ~25). Heavy per-pixel motion escapes — that is a real swing.
  {
    const jx = mx - predX, jy = my - predY;
    let m = 0;
    if (prevLum) {
      const i = wy * SW + wx;
      m = lum[i] - prevLum[i];
      if (m < 0) m = -m;
    }
    if (Math.sqrt(jx * jx + jy * jy) > JUMP_BASE + JUMP_GROW * (L.miss + 1) + 2 * L.spd &&
        m < MO_ESCAPE) return coastOut(false);
  }

  // Velocity: raw-to-raw measurements, per frame across any missed gap, EMA'd so
  // grain flicker averages out, capped so one bad frame cannot poison the prediction.
  const gapI = 1 / (L.miss + 1);
  const cap = (v) => (v > VEL_CAP ? VEL_CAP : v < -VEL_CAP ? -VEL_CAP : v);
  const nvx = cap((mx - L.px) * gapI), nvy = cap((my - L.py) * gapI);
  L.vx += (nvx - L.vx) * VEL_MIX;
  L.vy += (nvy - L.vy) * VEL_MIX;
  const iv = Math.sqrt(nvx * nvx + nvy * nvy);
  L.spd = 0.5 * L.spd + 0.5 * iv;
  L.px = mx; L.py = my;

  // Deadbanded report: under DEAD px of measured change the point barely moves (a
  // slow creep, so a sub-deadband systematic error still converges instead of being
  // frozen in forever); past PULL_FULL it snaps 1:1; the band closes as speed rises.
  const sp = Math.min(1, Math.max(0, (L.spd - 2.5) / (VEL_REF - 2.5)));
  const dx = mx - L.x, dy = my - L.y, dd = Math.sqrt(dx * dx + dy * dy);
  const f = dd < DEAD * (1 - sp) ? 0.06 : (dd > PULL_FULL ? 1 : dd / PULL_FULL);
  L.x += dx * f; L.y += dy * f;
  L.miss = 0; L.age++;
  return finish({ x: L.x, y: L.y, quality: q }, false);
}
