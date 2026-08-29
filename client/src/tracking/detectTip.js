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
// THE PLAYER (the deployed failure): "extremity of the foreground" is only the tip
// when the blade is the only foreground. With the player in frame — head, shoulders,
// torso, a raised elbow, all one swaying mass — the deployed build reported HIS BODY
// on 302 of 310 sword-less frames and stole cold acquisition whenever the sword hung
// idle. What separates a blade from a body is not extremity: it is being THIN where
// a body is thick, being a LONG straight protrusion where a body's parts are short
// or fat, and MOVING coherently when it matters. The gates and the blooding rule
// below encode exactly that, and the acceptance test now keeps a synthetic player
// in frame for every scenario.
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

// --- the PLAYER fix. Measured failure (see TIP_MODE.md): with a person in frame the
// extremity search reported his head/elbow on 302 of 310 sword-less frames and stole
// cold acquisition whenever the sword hung idle. Three mechanisms below: a mass map
// that still sees an absorbed body, thinness/protrusion gates on candidates, and
// blooding (no first report until the lock has travelled coherently, from the end of
// a long thin protrusion — a raise crosses that in 3-4 frames, sway never does).
const NOV_T = 24;       // |bg - bgS| above this marks ABSORBED novelty: a standing
                        // body is swallowed by the fast background in ~12 frames
                        // (GHOST_UP) and its silhouette would then read thin exactly
                        // when the player holds still. Absorbed bulk still counts.
const THIN_R = 4;       // width probes count mass on a 9px segment
const W0_CAP = 6;       // max mass on the probe PERPENDICULAR to the candidate's
                        // outward direction. A 1-2px blade (plus its ghost band)
                        // reads 2-5; a head rim, torso edge or arm reads 7-9. The
                        // single strongest body-vs-blade discriminator measured here.
const PROT_K = 3;       // deep gate: probes at 0, K, 2K px BEHIND the winner —
const PROT_CAP = 12;    // a tip must continue behind itself (both back rows
                        // non-empty) and stay thin (3-row total under this, rows
                        // 5px narrow). A head top has no thin continuation; an
                        // elbow's is a fat arm (5/row = 15+).
const TOPK = 8;         // a deep-gated winner falls through to the next-best
const ACQ_D = 8;        // blooding: a cold lock must travel this many px within
const ACQ_WIN = 8;      // this many frames before its FIRST report. A raise moves
                        // ~6px/frame; bounded sway drifts ~0.2. Until then: silence —
                        // a detector that reports a head is worse than one that
                        // reports nothing.
const ACQ_JMP = 10;     // an unblooded candidate only follows winners this close
                        // per missed frame. Without this, the winner hopping between
                        // rim flickers 20px apart stays inside the normal jump
                        // allowance and the hops themselves bloodied the lock.
const CAND_N = 3;       // unblooded MULTI-HYPOTHESIS: the per-frame winner
const CAND_GAP = 6;     // ping-pongs between the blade and a body flicker feature
                        // (measured: arm end and rising tip alternating through an
                        // entire raise) — a single candidate lock loses its streak
                        // to every alternation. Up to CAND_N candidates track
                        // independently (a candidate survives CAND_GAP missed
                        // frames); the first to BLOOD becomes the lock.
const ACQ_STK = 2;      // ...and the travel must be COHERENT: this many consecutive
const ACQ_STEP = 1.5;   // steps of at least this size, each in the same half-plane
                        // as the last. Net distance alone was not enough — the lock
                        // oscillating between two rim flickers ~7px apart crossed
                        // ACQ_D whenever the origin re-anchored at one extreme
                        // (measured: it blooded on a sword-less player and the
                        // freeze disc then cemented his arm as the cursor). A raise
                        // strings coherent ~6px steps immediately; oscillation
                        // reverses direction and never does.
const LONG_K = 3;       // blood-time protrusion check: probes every LONG_K px behind
const LONG_N = 5;       //   the winner, LONG_N rows deep (15px of shaft — the still
                        //   pose leaves only ~19px of blade visible above the bed
                        //   band, and a 20px reach lost the blood race to it)...
const LONG_MIN = 4;     //   at least this many back rows BLADE-LIKE (1..LONG_ROW
const LONG_ROW = 4;     //   px of mass in a 5px row — an empty row is a gap, a full
const LONG_CAP = 14;    //   one is a crossing edge or bulk), total mass at most
                        // LONG_CAP. A blade has 40+px of thin shaft behind its tip;
                        // a forearm hits its fat joint inside 16px; the head rim's
                        // near-straight equator run is ~16px and its only
                        // "continuation" is the shoulder-top line CROSSING the
                        // corridor at full width. This is what finally stops a
                        // coherent flicker chain (head rim -> elbow -> arm end reads
                        // as accelerating directed motion!) from blooding a lock on
                        // the player.
const LONG_TOT = 9;     // minimum total mass across the blood walk's rows: the
                        // measured false bloods rode 4-8 scattered flicker crumbs
                        // (a head-top hair band walks at exactly 8); a real 2px
                        // shaft yields 10
const COAST_MM = 8;     // 3x3 mass around a coasted report at/above this = the dead
                        // reckoning has sailed INTO the player (a 2px blade fills at
                        // most 6 of 9); the report is suppressed for that frame

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
    model.massM = new Uint8Array(n);  // strict OR absorbed novelty, for the gates
    model.topS = new Float64Array(TOPK);   // score shortlist, so a deep-gated
    model.topJ = new Int32Array(TOPK);     // winner can fall through
    model.cands = [];    // unblooded candidate locks (see CAND_N)
    model.accJ = new Int32Array(CAND_N);   // gate-surviving shortlist entries fed
                                           // to the candidates while unblooded
    model.bgN = 0;
    model.lock = null;   // {x, y, px, py, vx, vy, spd, miss, age, rep, ox, oy, bn,
                         //  sx, sy, stk} — x/y is the deadbanded report, px/py the
                         // raw measurement it derives from (velocity must be measured
                         // raw-to-raw, or smoothing understates every swing);
                         // rep/ox/oy/bn/sx/sy/stk are the blooding state (has it
                         // reported yet; travel origin; frames since anchored; last
                         // step; coherent-streak length). Survives caller resets.
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
  // On glut frames the SLOW memory catches up too: an exposure shift must rebase
  // both models, or |bg - bgS| marks the whole room as absorbed bulk for ~20s and
  // the thinness gates go blind.
  const upS = model.bgN === 0 ? 1 : glut ? GLUT_UP : BGS_UP;
  const upG = glut ? Math.max(up, GLUT_UP) : up;
  // Only a lock that has actually REPORTED earns the freeze disc — an unblooded
  // sway flicker must not get a patch of background frozen under it forever.
  const frz = L && L.rep && L.age >= LOCK_AGE && model.bgN >= BG_WARM_MIN;
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

  // Every would-be miss routes through here. A BLOODED lock with real speed
  // dead-reckons along its velocity for a few frames instead of dropping; a still
  // or unblooded lock gets no coasting — for it this is exactly finish(null).
  const coastOut = (glut) => {
    const C = model.lock;
    if (!(C && C.rep && C.spd > 1.5 && C.miss < COAST_MAX)) return finish(null, glut);
    C.miss++;
    C.x += C.vx; C.y += C.vy;
    // damp hard: extrapolation overshoots worst exactly where misses cluster, the
    // stroke reversal, where the tip dwells while the prediction sails on
    C.vx *= 0.75; C.vy *= 0.75; C.spd *= 0.75;
    // A coasted point that has sailed into thick mass is ON THE PLAYER — dead
    // reckoning must not paint the cursor onto his head. (massM may be one frame
    // stale on an early-exit path; a body does not move that fast.)
    const qx = Math.round(C.x), qy = Math.round(C.y);
    if (qx > 0 && qy > 0 && qx < SW - 1 && qy < SH - 1) {
      const i0 = qy * SW + qx, M = model.massM;
      const mm = M[i0 - SW - 1] + M[i0 - SW] + M[i0 - SW + 1] + M[i0 - 1] + M[i0] +
        M[i0 + 1] + M[i0 + SW - 1] + M[i0 + SW] + M[i0 + SW + 1];
      if (mm >= COAST_MM) return finish(null, glut);
    }
    return finish({ x: C.x, y: C.y, quality: 0.25 }, glut);
  };

  // Foreground collection. Strict pixels (diff > FG_T) are real novelty anywhere in
  // frame and feed the centroid; faint pixels (FG_FAINT..FG_T) are admitted only
  // inside the disc ahead of a FAST, blooded lock — that is where a motion-blurred
  // tip lives, and nowhere else is worth the false-positive risk.
  mask.fill(0);
  const faint = L && L.rep && L.spd > FAINT_SPD;
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

  // Mass map for the thinness gates: strict novelty plus ABSORBED novelty — a pixel
  // whose fast background sits far from what the room has LONG held is a swallowed
  // body or shaft and still counts as bulk. Without this the gates go blind ~12
  // frames after the player stops moving (GHOST_UP absorbs him that fast).
  const massM = model.massM, bgS = model.bgS;
  const matureS = model.bgN >= BGS_MATURE;
  for (let i = 0; i < n; i++) {
    let d = lum[i] - bg[i];
    if (d < 0) d = -d;
    if (d > FG_T) { massM[i] = 1; continue; }
    if (matureS) {
      let g = bg[i] - bgS[i];
      if (g < 0) g = -g;
      massM[i] = g > NOV_T ? 1 : 0;
    } else massM[i] = 0;
  }
  // Local structure direction at (x,y): the mass-weighted mean offset in an 11x11
  // window, pointing INTO the shaft. Returns [ux,uy] when the mass is one-sided
  // (a tip property), false when there is mass but no dominant side (a mid-edge or
  // interior pixel), and null when there is too little mass around to judge.
  const ldir = (x, y) => {
    let lvx = 0, lvy = 0, mcnt = 0;
    for (let oy2 = -5; oy2 <= 5; oy2++) {
      const yy = y + oy2;
      if (yy < 0 || yy >= SH) continue;
      for (let ox2 = -5; ox2 <= 5; ox2++) {
        const xx = x + ox2;
        if (xx < 0 || xx >= SW) continue;
        if (massM[yy * SW + xx]) { lvx += ox2; lvy += oy2; mcnt++; }
      }
    }
    if (mcnt < 4) return null;
    const lvm = Math.sqrt(lvx * lvx + lvy * lvy);
    if (lvm < 1.5 * mcnt) return false;
    return [lvx / lvm, lvy / lvm];
  };
  // Mass count on a (2r+1)px segment through (x,y) along (dx,dy).
  const probe = (x, y, dx, dy, r = THIN_R) => {
    let c = 0;
    for (let j = -r; j <= r; j++) {
      const qx = Math.round(x + j * dx), qy = Math.round(y + j * dy);
      if (qx >= 0 && qy >= 0 && qx < SW && qy < SH) c += massM[qy * SW + qx];
    }
    return c;
  };

  // Sub-pixel refine at a winner pixel: diff-weighted centroid of the foreground
  // in a 5x5 window. Pulls ~1px inward along the blade (the window sees shaft,
  // never beyond-tip) — a stable bias the deadband then holds still.
  const refineAt = (wx2, wy2) => {
    let rx = 0, ry = 0, rw = 0, sup = 0;
    const y0 = wy2 - 2 < 0 ? 0 : wy2 - 2, y1 = wy2 + 2 >= SH ? SH - 1 : wy2 + 2;
    const x0 = wx2 - 2 < 0 ? 0 : wx2 - 2, x1 = wx2 + 2 >= SW ? SW - 1 : wx2 + 2;
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const i = y * SW + x;
        let d = lum[i] - bg[i];
        if (d < 0) d = -d;
        if (d <= FG_FAINT) continue;
        rx += x * d; ry += y * d; rw += d; sup++;
      }
    }
    if (sup < MIN_MASS) return null;
    return { mx: rx / rw, my: ry / rw, q: sup / 8 > 1 ? 1 : sup / 8 };
  };

  // Feed one refined point into the candidate tracker; returns true when it
  // BLOODS (and installs model.lock). Blood needs: a coherent streak (ACQ_STK+
  // same-half-plane steps of ACQ_STEP+, decaying on quiet frames, surviving
  // CAND_GAP miss gaps), ACQ_D+ px of net travel from a windowed origin,
  // UPWARD-dominant travel — you acquire a katana by RAISING it, and every
  // measured false blood travelled along the head's horizontal hair band — and a
  // shaft behind the point: the walk below, back along the travel (the shaft IS
  // what the tip left behind), wants LONG_MIN+ blade-like rows. A blade-like row
  // holds 1..LONG_ROW px of CONTIGUOUS mass (a 4px forearm reads as two edge
  // strips split 4 apart; the shoulder line crosses at full width; flicker crumbs
  // leave gaps) and the rows' total must look like a shaft (LONG_TOT..LONG_CAP —
  // measured false bloods rode 4-8 crumbs, a real 2px shaft yields 10). Each row
  // RE-CENTERS on its mass: a rounded seat on a 2px shaft tilts any local
  // direction estimate enough to walk clean off it by the third row.
  const feedCand = (cs, now, fmx, fmy) => {
    let best = -1, bestD = 1e9;
    for (let ci = 0; ci < cs.length; ci++) {
      const c2 = cs[ci];
      const g2 = now - c2.seen;
      if (g2 < 1) continue;                       // already fed this frame
      const dx2 = fmx - (c2.px + c2.sx * g2), dy2 = fmy - (c2.py + c2.sy * g2);
      const d2 = Math.sqrt(dx2 * dx2 + dy2 * dy2);
      const r2 = ACQ_JMP * g2 > 30 ? 30 : ACQ_JMP * g2;
      if (d2 <= r2 && d2 < bestD) { bestD = d2; best = ci; }
    }
    if (best < 0) {
      const fresh = { px: fmx, py: fmy, sx: 0, sy: 0, stk: 0, ox: fmx, oy: fmy, bn: 0, seen: now };
      if (cs.length < CAND_N) cs.push(fresh);
      else {
        let wi = 0;
        for (let ci = 1; ci < cs.length; ci++) if (cs[ci].stk < cs[wi].stk) wi = ci;
        cs[wi] = fresh;
      }
      return false;
    }
    const c = cs[best];
    const g = now - c.seen;
    const stx = (fmx - c.px) / g, sty = (fmy - c.py) / g;
    const siv = Math.sqrt(stx * stx + sty * sty);
    if (siv >= ACQ_STEP && stx * c.sx + sty * c.sy > 0) c.stk++;
    else if (siv >= ACQ_STEP) c.stk = 1;          // big incoherent step: oscillation
    else if (c.stk > 0) c.stk--;                  // quiet frame: decay, don't reset
    c.sx = stx; c.sy = sty;
    c.px = fmx; c.py = fmy; c.seen = now;
    const bx = c.px - c.ox, by = c.py - c.oy;
    let blood = false;
    if (c.stk >= ACQ_STK && bx * bx + by * by >= ACQ_D * ACQ_D &&
        by < 0 && by * by >= 2.25 * bx * bx) {
      const bd0 = Math.sqrt(bx * bx + by * by);
      const ux = -bx / bd0, uy = -by / bd0;       // back along the travel
      let fx2 = c.px, fy2 = c.py, tot = 0, ne = 0;
      for (let g2 = 1; g2 <= LONG_N; g2++) {
        fx2 += LONG_K * ux; fy2 += LONG_K * uy;
        let w = 0, off = 0, jmin = 3, jmax = -3;
        for (let j = -2; j <= 2; j++) {
          const qx = Math.round(fx2 - j * uy), qy = Math.round(fy2 + j * ux);
          if (qx >= 0 && qy >= 0 && qx < SW && qy < SH && massM[qy * SW + qx]) {
            w++; off += j;
            if (j < jmin) jmin = j;
            if (j > jmax) jmax = j;
          }
        }
        tot += w;
        if (w >= 1 && w <= LONG_ROW && jmax - jmin <= 2) {
          ne++;
          const o = off / w;                      // follow the shaft, gently
          const oc = o > 1.5 ? 1.5 : o < -1.5 ? -1.5 : o;
          fx2 -= oc * uy; fy2 += oc * ux;
        }
      }
      blood = ne >= LONG_MIN && tot >= LONG_TOT && tot <= LONG_CAP;
    }
    if (!blood) {
      if (++c.bn >= ACQ_WIN) { c.bn = 0; c.ox = c.px; c.oy = c.py; }
      return false;
    }
    cs.length = 0;
    model.lock = { x: fmx, y: fmy, px: fmx, py: fmy, vx: c.sx, vy: c.sy,
      spd: Math.min(siv, VEL_CAP), miss: 0, age: LOCK_AGE, rep: true };
    return true;
  };

  // Score every candidate as a TIP: an extremity of the foreground (far from its
  // mass), preferably upper (cold tie-break between the two ends of a bare blade),
  // preferably moving (the leading end covers fresh pixels), preferably where the
  // lock predicts it (continuity). No axis anywhere in this — but a THINNESS gate:
  // a tip candidate must be thin across its own outward direction. A body is thick;
  // a head rim's band is long; a 1-2px blade passes. Strict candidates only — faint
  // ones exist solely inside the disc ahead of a fast lock, where continuity owns
  // identity and blur has smeared the tip too wide for any width test; strict
  // candidates in that same disc are exempt for the same reason.
  const cx = sx / sw, cy = sy / sw;
  const tS = model.topS, tJ = model.topJ;
  tS.fill(-1e9); tJ.fill(-1);
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
    const ed = Math.sqrt(ex * ex + ey * ey);
    if (ed > 4) {
      let d0 = lum[i] - bg[i];
      if (d0 < 0) d0 = -d0;
      if (d0 > FG_T) {
        const ax = x - predX, ay = y - predY;
        if (!(faint && ax * ax + ay * ay < fr2) &&
            probe(x, y, -ey / ed, ex / ed) > W0_CAP) continue;
      }
    }
    let s = ed + UP_W * (SH - y) + DENS_W * nb;
    if (prevLum) {
      let m = lum[i] - prevLum[i];
      if (m < 0) m = -m;
      s += MO_W * (m > MO_CAP ? MO_CAP : m);
    }
    // Continuity is EARNED by blooding: an unblooded lock squatting on a head rim
    // must not use this bonus to outscore the real tip rising past it — measured
    // costing the entire acquisition on 3 of 10 sway phases.
    if (L && L.rep) {
      const ax = x - predX, ay = y - predY;
      const dp = Math.sqrt(ax * ax + ay * ay);
      if (dp < LOCK_R) s += LOCK_W * (1 - dp / LOCK_R);
    }
    if (s > tS[TOPK - 1]) {
      let t = TOPK - 1;
      while (t > 0 && s > tS[t - 1]) { tS[t] = tS[t - 1]; tJ[t] = tJ[t - 1]; t--; }
      tS[t] = s; tJ[t] = j;
    }
  }

  // Deep protrusion gate, wherever identity is NOT already carried by a reporting
  // lock's continuity (cold acquisition, an unblooded lock, a winner outside
  // LOCK_R): the far end of a long thin thing must CONTINUE behind itself, thinly.
  // A head top has no thin continuation (the rows behind it are skull or nothing);
  // an elbow's continuation is a fat arm. A gated winner falls through to the
  // next-best candidate.
  // While no lock exists, the top few gate-surviving candidates ALL feed the
  // acquisition tracker below — the per-frame #1 ping-pongs between the blade and
  // body flicker (a capped motion bonus ties them), and the winner-only diet
  // starved the real tip's candidate of updates through entire raises (measured).
  let bi = -1, accN = 0;
  const acc = model.accJ;
  const accMax = L ? 1 : CAND_N;
  for (let t = 0; t < TOPK && accN < accMax; t++) {
    const j = tJ[t];
    if (j < 0) break;
    const x = xs[j], y = ys[j], i = y * SW + x;
    let d0 = lum[i] - bg[i];
    if (d0 < 0) d0 = -d0;
    if (d0 > FG_T) {
      const ax = x - predX, ay = y - predY;
      const carried = L && L.rep && ax * ax + ay * ay < LOCK_R * LOCK_R;
      if (!carried) {
        // Direction comes from the winner's own 11x11 mass mean-offset, NOT the
        // global centroid: the player drags the centroid 20-30deg off the blade
        // axis — enough for the probes to walk off the shaft and reject the real
        // tip mid-raise. The offset must also be one-sided: a tip has all its
        // mass on one side, a mid-edge pixel cancels out.
        const ld = ldir(x, y);
        if (ld) {
          const ux = ld[0], uy = ld[1];
          const w0 = probe(x, y, -uy, ux, 2);
          const w1 = probe(x + PROT_K * ux, y + PROT_K * uy, -uy, ux, 2);
          const w2 = probe(x + 2 * PROT_K * ux, y + 2 * PROT_K * uy, -uy, ux, 2);
          if (w0 + w1 + w2 > PROT_CAP) continue;
          // The continuation requirement is waived only for a BLOODED lock's
          // heavily-moving winner — a blurred blade re-captured beyond LOCK_R has
          // no strict shaft behind its tip (that is what blur IS), but it does
          // have a huge frame delta. Cold acquisition never gets the waiver.
          if (!w1 || !w2) {
            if (!(L && L.rep)) continue;
            let mw = 0;
            if (prevLum) {
              mw = lum[i] - prevLum[i];
              if (mw < 0) mw = -mw;
            }
            if (mw < MO_ESCAPE) continue;
          }
        }
        // ld null/false (too little mass, or no dominant side — which real tip
        // corners trigger too): no orientation to test; the cheap width gate and
        // blooding carry the protection instead
      }
    }
    if (accN > 0) {
      // one entry per FEATURE: neighbouring pixels of the same tip are one update
      const x1 = xs[acc[0]], y1 = ys[acc[0]];
      if (Math.abs(x - x1) + Math.abs(y - y1) < 6) continue;
      if (accN > 1) {
        const x2 = xs[acc[1]], y2 = ys[acc[1]];
        if (Math.abs(x - x2) + Math.abs(y - y2) < 6) continue;
      }
    }
    acc[accN++] = j;
  }
  if (!accN) return coastOut(false);
  bi = acc[0];

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
    // ---- ACQUISITION: no lock exists until a candidate BLOODS. Reporting the
    // first frame's winner is exactly how the player's head became the cursor, so
    // until then the detector says NOTHING. The per-frame winner ping-pongs
    // between the blade and body flicker features, so up to CAND_N candidates
    // track independently, each with its own coherence streak, and each accepted
    // shortlist entry (not just the winner) feeds its nearest candidate.
    const cs = model.cands;
    const now = model.bgN;
    for (let ci = cs.length - 1; ci >= 0; ci--) {
      if (now - cs[ci].seen > CAND_GAP) cs.splice(ci, 1);
    }
    for (let a = 0; a < accN; a++) {
      const fj = acc[a];
      const fr = a === 0 ? { mx, my, q } : refineAt(xs[fj], ys[fj]);
      if (!fr) continue;
      const r = feedCand(cs, now, fr.mx, fr.my);
      if (r) return finish({ x: fr.mx, y: fr.my, quality: fr.q }, false);
    }
    return finish(null, false);
  }
  // Teleport gate: junk that wins while the tip is blind sits far from the
  // prediction (measured on the axis detector: 36-70px; honest re-captures a few
  // px to ~25). Heavy per-pixel motion escapes — that is a real swing.
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
