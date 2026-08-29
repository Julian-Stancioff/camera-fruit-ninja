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
//
// Real-katana testing exposed the previous revision's flaw: it discriminated blade
// from clutter by MOTION alone (votes up to 4x by per-pixel motion, run scores paid
// 2.2x per moving pixel, ends trimmed to the outermost MOVING support). That works
// mid-swing and collapses the moment the sword is held still — with zero motion the
// static bars that pass the valley filter anyway (a picture frame, a skateboard, a
// light fixture) score level with the blade, the winner flips frame to frame, and the
// motion trim turns endpoints into noise. Two mechanisms replace it, ported from
// detectRidge (which took the same room from 74.9deg median error to 2.1deg):
//
//   1. A per-pixel BACKGROUND MODEL of the valley response. Static clutter responds
//      in EVERY frame; the evidence that votes and supports runs is resp - g*bg, so
//      after ~3 frames the furniture is out of the contest entirely and the blade
//      needs no motion at all to win. Rises learn slowly (running mean cold, ~10s
//      exponential warm), a VANISHED structure is forgotten immediately (it was never
//      background), and a freeze band around the tracked blade stops a held-still
//      blade from being absorbed: inside the band bg holds still except that vanish.
//      The band is honored only once bg is warm (probation): a lock latched during
//      warm-up — when clutter still has full evidence and wins spuriously — gets
//      learned like everything else and dies within a few frames, instead of being
//      frozen novel and hallucinated forever. The cost is deliberate: a sword that is
//      ALREADY in frame and never moves from the very first frame is absorbed like
//      furniture (it is indistinguishable from furniture); a sword raised or moved at
//      any point after warm-up establishes and then holds still indefinitely.
//   2. A LINE LOCK on the model (not on `prev` — the caller nulls prev on any miss).
//      The locked line gets a 1.5x score boost, so a challenger needs clearly better
//      evidence to displace it, and reported endpoints move through a deadband: under
//      1.5px of measured change they barely move (a slow creep). Motion is only a
//      TIEBREAKER (max 2x, > the 1.5x lock boost by design), so a genuinely swinging
//      blade can always break a wrongly-latched static lock, but sensor grain cannot.
//
// Real-katana testing then exposed the OPPOSITE failure: everything tuned for the
// held-still case (deadband, extent caps, same-line tolerance, stranger refusal)
// starved a fast swing — 62.5% lock mid-swing, with 90deg "glitch" frames where a
// junk line captured the lock while the blade crossed a contrast-dead pose. Three
// mechanisms fix that without giving the stillness back:
//
//   3. SPEED ADAPTIVITY (the 1-euro-filter idea). The lock tracks its endpoints'
//      measured velocity; the LATERAL component (EMA'd) is the swing-speed signal —
//      axial endpoint jumps are support fragments flickering, not motion. Every
//      stillness clamp opens with that speed, the same-line test also accepts the
//      velocity-PREDICTED line, and a missed frame dead-reckons the lock as a RIGID
//      body (translate + rotate, never shrink) for up to COAST_MAX frames, so a
//      blurred or contrast-dead frame does not drop the game's blade. A replacement
//      lock inherits the outgoing lock's damped velocity — same physical blade.
//   4. HANDOVER GATES. A non-incumbent winner must be physically reachable from the
//      last CONFIDENT axis (rotation-rate cap, allowance growing with time unseen
//      and with the speed last measured) and from the lock's position (translation
//      cap) — junk light picked up while the blade is invisible fails both, which
//      is what killed the perpendicular-flip glitches. A heavily MOVING challenger
//      (score >= 1.7x support) bypasses the gates: a real swing must still be able
//      to break a wrongly-latched static lock.
//   5. A SLOW SIGNED ROOM MEMORY (bgS, ~20s EMA, vanish-proof). A motion-blurred
//      blade occludes furniture with per-pixel luma deltas too small for MOVE_T,
//      the vanish rule then forgets that furniture, and on return it fed ghost
//      lines for ~10s of BG_UP. A pixel returning to the level AND polarity it has
//      long held is re-learned fast — outside the lock's band only, because a dark
//      blade over a remembered dark valley is indistinguishable from the valley.
export const NAME = "auto";

// Probe distances, in px at 192 wide. MULTI-SCALE on purpose: a blade held at arm's
// length is ~3px across, one held close to the camera is ~8px. Probing only narrow
// offsets makes the detector blind to a near blade, because both "flanks" land inside
// it — dark beside dark, no response.
const OFFS = [2, 4, 7];     // widest probe 7: covers a blade up to ~10px across. The old
                            // 11px probe existed for very-near blades but also lit every
                            // skateboard deck and shelf board in the room; live
                            // measurement puts the real blade at 1-2px, near-camera ~7.
const THIN_Q = 2;           // response at OFFS[0..1] => bar is <=~7px wide: blade-thin.
                            // A skateboard deck or a shelf board responds too, but only
                            // at the widest probes — that is width physics, not tuning.
const MIN_RESP = 12;        // luminance a bar must stand clear of both flanks by
const MIN_LEN = 14;         // shortest thing we will call a blade, in px
const NTH = 90;             // line-vote angle bins (2 deg)
const GAP = 14;             // px of unsupported line we will bridge (see below)
const NEAR = 2.2;           // how close a responding pixel must sit to a line to support it

// Background model of the valley response (mechanism from detectRidge).
const BG_WARM = 3;          // frames before subtraction reaches full strength
const BG_UP = 1 / 300;      // slow rise (~10s at 30fps) once warm; cold it is a running
                            // mean via max(BG_UP, 1/(n+1)) so frame 1 learns the room
                            // outright instead of suppressing nothing for 300 frames
const BG_PAD_U = 4;         // freeze-band margin past the blade tip, px
const BG_PAD_V = 5;         // freeze-band half-width across the blade, px. Generous —
                            // the held line can sit a deadband off the physical blade —
                            // because the freeze is POLARITY-AWARE: only pixels of the
                            // lock's own polarity are frozen, so the bright wall sliver
                            // pinched between a dark blade and a dark neighbour still
                            // gets learned even though it lies inside the band. (At a
                            // blanket 5 those slivers stayed evidence and formed junk
                            // lines beside the blade; at a blanket 3 the blade itself
                            // was absorbed the moment the held line sat 2px off.)
const BG_BAND_MIN = 5;      // frames of bg before any freeze band is honored. Probation:
                            // whatever got latched while the room still had evidence is
                            // NOT protected, so a warm-up mistake is learned away instead
                            // of being frozen novel forever
const BAND_AGE = 3;         // consecutive confirmations before a LOCK earns its band.
                            // A wrong capture (a diagonal that outscored everything for
                            // one frame mid-raise) must not freeze its own support the
                            // frame it wins — unfrozen, that support decays and the
                            // impostor dies; frozen, it self-locked forever. Measured.
const EV_MIN = 12;          // evidence floor: grain wobble on learned clutter stays
                            // under it, a real bar clears it by an order of magnitude

// Lock / hysteresis.
const EST_LEN = 18;         // a NEW lock needs this much supported run. Modest on
                            // purpose: in a dim room the VISIBLE part of a real blade
                            // can be ~20px (the rest contrast-dead), and the winner-only
                            // rule plus probation plus bg suppression carry the rest
const EST_THIN = 0.5;       // ...and at least half its support blade-thin (<=~7px wide),
                            // so a skateboard or shelf board cannot establish at all
const LOCK_BOOST = 1.5;     // hysteresis: a challenger needs 1.5x the locked line's score
const MO_BOOST = 1.0;       // motion tiebreaker cap (was 3x votes / 2.2x score). Kept
                            // ABOVE LOCK_BOOST-1 so a truly moving blade (boost -> 2.0)
                            // can always break a static wrong lock; grain (~0.3) cannot.
const LOCK_T = 5;           // same-line tolerance: 5 bins = 10deg...
const LOCK_R = 12;          // ...and 12px of rho
const MISS_MAX = 12;        // missed frames before the lock is forgotten
const VOTE_MAX = 1200;      // hard ceiling on voting pixels: cost must not scale with
                            // room clutter. A blade is ~100-300 evidence pixels; when
                            // more than VOTE_MAX are lit, the strongest win the vote.
const GLUT = 0.06;          // evidence pixels above this fraction of the frame mean the
                            // WORLD changed (bg warm-up, exposure shift, camera move),
                            // not that a blade appeared: nothing may establish, and
                            // unless already locked the frame is not even worth voting
                            // on — which also bounds the worst-case cost of exactly
                            // those frames. Measured live: the two hallucinations were
                            // a 169px room-spanning chain during warm-up and a door
                            // edge, both on frames like these.
const PEAK_FLOOR = 0.05;    // Hough peaks under this fraction of the strongest are not
                            // worth a run-walk — in a 40%-lit room the peak list was
                            // thousands long and the sort alone blew the budget
const MOVE_T = 8;           // |luma delta| above this = the pixel is MOVING and must not
                            // be learned as background: the room is what holds still.
                            // Without this a blade raised through its own final column
                            // teaches bg its own crossings before the lock can freeze
                            // them, and the visible run is truncated forever after.
const DEAD = 1.5;           // endpoint deadband, px: measured wobble under this is grain
const PULL_FULL = 8;        // px of measured change at which endpoints snap 1:1
const VEL_REF = 10;         // endpoint speed (px/frame) at which the adaptive limits are fully
                            // open. The stillness clamps (deadband, extent caps, lock-line
                            // tolerance, stranger refusal) scale between their hard held-still
                            // value at speed 0 and wide open at VEL_REF — the 1-euro-filter
                            // idea: the clamps that give 0.06px endpoints at rest are exactly
                            // what starved a fast swing, measured at 62.5% lock mid-swing.
const COAST_MAX = 4;        // missed frames bridged by dead-reckoning a MOVING lock before the
                            // report actually drops: one blurred/contrast-dead frame must not
                            // cost the game its blade. Bounded well under MISS_MAX, and only
                            // for a lock carrying real measured (or inherited) velocity.

/** Scratch buffers live on the model so nothing is allocated per frame. */
function buffers(model, SW, SH) {
  const n = SW * SH;
  if (model._n !== n) {
    model._n = n;
    model.lum = new Float32Array(n);
    model.resp = new Float32Array(n);
    model.ev = new Float32Array(n);   // resp minus background — zeroed every frame
    model.thin = new Uint8Array(n);   // responder fired at a narrow probe (fresh where ev>0)
    model.pol = new Uint8Array(n);    // responder polarity: 1 bright ridge, 2 dark valley
    model.bg = new Float32Array(n);
    model.bgS = new Float32Array(n); // slow room memory (~20s EMA), never crashed by
                                     // the vanish rule: what this pixel has LONG held
    model.bgN = 0;
    model.lock = null;                // {t, r, e0, e1, miss} — survives caller resets
    model.ax = null;                  // confident axis: {t, n} — theta of the last lock
                                      // confirmed at age>=BAND_AGE, n frames since
    model.xs = new Int16Array(n);
    model.ys = new Int16Array(n);
    model.sup = new Uint8Array(2 * (SW + SH) + 8);
    model.hist = new Uint32Array(64);
    model.pv = new Float32Array(64);  // top-K Hough peaks, preallocated: the peak list
    model.pt = new Int16Array(64);    // on a busy transition frame ran to thousands of
    model.pr = new Int16Array(64);    // small arrays plus a sort — pure GC fodder
    // Integer probe offsets, precomputed once: 4 float mults + 2 truncations per probe
    // gone from the hot loop, and the probes land symmetrically (the inline truncation
    // rounded negative offsets one pixel differently from positive ones).
    model.poff = new Int32Array(DIRS.length * OFFS.length);
    for (let k = 0; k < DIRS.length; k++) {
      for (let q = 0; q < OFFS.length; q++) {
        model.poff[k * OFFS.length + q] =
          Math.round(DIRS[k][1] * OFFS[q]) * SW + Math.round(DIRS[k][0] * OFFS[q]);
      }
    }
    model.acc = new Float32Array(NTH * (2 * (SW + SH) + 8));
    model.nr = 2 * (SW + SH) + 8;
    model.rho0 = SW + SH + 4;
    model.prevLum = null;      // rho = x*cos+y*sin over theta in [0,pi) spans [-SW, SW+SH]
  }
  return model;
}

// 6 orientations over 180 deg; we probe along each one's PERPENDICULAR. Six, not
// eight: worst-case misalignment is 15 deg, which still lands both flanks on the
// background beside any bar longer than a few px — and the filter is the whole cost
// of a busy frame, so every probe pair is 4% of the frame budget.
const DIRS = [];
for (let i = 0; i < 6; i++) {
  const a = (i * Math.PI) / 6 + Math.PI / 2;
  DIRS.push([Math.cos(a), Math.sin(a)]);
}

const COS = new Float32Array(NTH), SIN = new Float32Array(NTH);
for (let t = 0; t < NTH; t++) { const a = (t * Math.PI) / NTH; COS[t] = Math.cos(a); SIN[t] = Math.sin(a); }

// Same physical line? Theta wraps at 0/pi and the normal flips sign there, so a
// near-horizontal blade reports rho of opposite sign across the seam.
function sameLine(t1, r1, t2, r2, rho0, dtMax, drMax) {
  let dt = Math.abs(t1 - t2);
  const wrap = dt > NTH / 2;
  if (wrap) dt = NTH - dt;
  const dr = wrap ? Math.abs(r1 + r2 - 2 * rho0) : Math.abs(r1 - r2);
  return dt <= dtMax && dr <= drMax;
}

// Endpoint deadband: under DEAD px of measured change the reported end does not move
// (grain), past PULL_FULL it snaps 1:1 (a real swing), in between it blends. sp is
// the lock's speed factor (0 still .. 1 fast): the deadband closes as speed rises,
// because at speed every px of measured change is real motion, not grain.
function pull(h, m, sp) {
  const dx = m[0] - h[0], dy = m[1] - h[1], d = Math.hypot(dx, dy);
  // Below the deadband: a slow creep toward the measurement, not a hard freeze. A
  // hard freeze preserves whatever sub-deadband error the lock was born with forever
  // (a 1.4px tilt on a 22px segment is 7deg, permanently). 0.06/frame is invisible
  // (<0.1px) and converges a systematic offset in about a second.
  const f = d < DEAD * (1 - sp) ? 0.06 : Math.min(1, d / PULL_FULL);
  h[0] += dx * f;
  h[1] += dy * f;
}

// Line (theta bin, rho index) through two points — used to re-derive the lock line
// from dead-reckoned endpoints.
function lineFromEnds(e0, e1, rho0) {
  const na = Math.atan2(e1[1] - e0[1], e1[0] - e0[0]) + Math.PI / 2;
  const t = Math.round((((na % Math.PI) + Math.PI) % Math.PI) / (Math.PI / NTH)) % NTH;
  const r = Math.round(((e0[0] + e1[0]) / 2) * COS[t] + ((e0[1] + e1[1]) / 2) * SIN[t]) + rho0;
  return [t, r];
}

// Learn the room from this frame's raw response, minus the band around the blade.
// Inside the band bg holds still — no rises (a held-still blade must not absorb
// itself), no noise-falls (they ratcheted bg down under a wrong lock and regenerated
// its evidence) — except the vanish-fall below, so a ghost learned before tracking
// began is not sealed in underneath the band forever.
//
// Falls are immediate ONLY when the structure is actually gone (response collapsed
// well below the learned level) — that is what stops a passed blade leaving a ghost.
// A small deficit is just grain, and learns at the same slow symmetric rate as rises:
// an unconditional immediate fall makes bg ride each pixel's NOISE MINIMUM, and then
// every static bar in the room pokes evidence above it every single frame. Measured
// on the synthetic room: 25% of the frame stayed lit as "evidence" with the
// unconditional fall, 0.1% with this rule.
function learnBg(model, SW, SH, band) {
  const { resp, bg, bgS, lum, prevLum, pol } = model;
  const up = Math.max(BG_UP, 1 / (model.bgN + 1));
  const upS = Math.max(1 / 600, 1 / (model.bgN + 1));
  // Recovery below only once bgS genuinely means LONG-known (~1s of frames): with
  // the cold ramp the whole room is "known" after two frames, and recovery then
  // acted as fast clutter learning during warm-up — cleaning the field so quickly
  // that the strongest not-yet-learned clutter line stood alone and got locked,
  // exactly what the glut gate and probation exist to prevent.
  const mature = model.bgN >= 30;
  const dx = band ? Math.cos(band.angle) : 0, dy = band ? Math.sin(band.angle) : 0;
  for (let y = 0, i = 0; y < SH; y++) {
    for (let x = 0; x < SW; x++, i++) {
      // A moving pixel is never background — the room is what holds still. This keeps
      // a raised or swung blade (and the player) out of bg entirely; the vanish-fall
      // below simply lands one frame later, once the pixel has settled.
      if (prevLum) { const dm = lum[i] - prevLum[i]; if (dm > MOVE_T || dm < -MOVE_T) continue; }
      let inBand = false, inGeo = false;
      if (band) {
        const ax = x - band.cx, ay = y - band.cy;
        const u = ax * dx + ay * dy, v = ax * dy - ay * dx;
        inGeo = u < band.hu && u > -band.hu && v < BG_PAD_V && v > -BG_PAD_V;
        inBand = inGeo && resp[i] > MIN_RESP && pol[i] === band.pol;
      }
      // Slow room memory, SIGNED by polarity (ridge positive, valley negative —
      // resp alone is magnitude, and a dark blade crossing a bright bed-fold reads
      // as the same magnitude the fold always had). Frozen across the band's whole
      // GEOMETRY (a held blade must never enter it, marginal edge pixels included),
      // and immune to the vanish crash, so it remembers what a pixel held even
      // through an occlusion.
      const sr = pol[i] === 1 ? resp[i] : -resp[i];
      if (!inGeo) bgS[i] += (sr - bgS[i]) * upS;
      const d = resp[i] - bg[i];
      const gone = resp[i] < 0.5 * bg[i] - 6;
      if (d <= 0 && gone) { bg[i] += d; continue; }   // structure vanished: forget it now
      // Recovery: a return to the level AND polarity this pixel has LONG been known
      // to hold is occluded room re-emerging, not a novel object. A fast MOTION-
      // BLURRED blade sweeping over a shelf crushes its valley response for several
      // frames with per-pixel luma deltas too small for MOVE_T; the vanish rule
      // then forgets the shelf, and on return it masqueraded as fresh evidence for
      // ~10s of BG_UP — measured as a ghost line the lock latched onto and then
      // kept alive under its own freeze band. Guards: |bgS| > 20 so the faint
      // pre-band echo the blade leaves in bgS does not count as "known"; the
      // two-sided SIGNED match keeps a blade lying over known structure (level
      // shifted or polarity flipped) novel; and NO band piercing — a dark blade
      // crossing a remembered dark valley matches sign and level, and recovery
      // inside the band measurably ate the held-still blade's low-contrast end.
      // The cost of not piercing: food already under a band when recovery begins
      // stays frozen, so a ghost that latches within ~2 frames of the crash can
      // still ride until a challenger breaks it.
      const aS = bgS[i] < 0 ? -bgS[i] : bgS[i];
      if (!inGeo && mature && d > 0 && aS > 20 && Math.abs(sr - bgS[i]) <= 0.25 * aS + 6) { bg[i] += d * 0.3; continue; }
      // Inside the band bg holds still entirely (except the vanish and recovery
      // cases above): rises would absorb a held blade, and noise-falls would slowly
      // ratchet bg DOWN under a wrongly-latched line and regenerate its evidence —
      // a self-locking loop that measurably kept a bedding fold hallucinated
      // forever.
      if (!inBand) bg[i] += d * up;
    }
  }
  model.bgN++;
}


export function enroll(frames, SW, SH) {
  // Nothing to learn — the filter is universal. (The caller hands one frame; the
  // background model warms itself over the first few live detect() calls instead.)
  return buffers({ _n: -1 }, SW, SH);
}

export function detect(pixels, SW, SH, model, prev) {
  if (!model) return null;
  buffers(model, SW, SH);
  if (model.ax && model.ax.n < 99) model.ax.n++;
  const { lum, resp, ev, thin, pol, xs, ys, acc, nr, rho0 } = model;
  const n = SW * SH;
  // Optional stage profiler: set model.prof = {filter:0,vote:0,walk:0,learn:0,n:0}.
  const P = model.prof;
  let mark = P ? performance.now() : 0;

  for (let i = 0, p = 0; i < n; i++, p += 4) {
    lum[i] = 0.299 * pixels[p] + 0.587 * pixels[p + 1] + 0.114 * pixels[p + 2];
  }
  const prevLum = model.prevLum;

  // Every exit learns the room from this frame — a room the detector is failing in is
  // still a room — and rolls prevLum forward. Misses age the lock; MISS_MAX of them
  // and it is forgotten, so a lowered sword does not haunt the next raise.
  const finish = (hit, band) => {
    if (P) { P.walk += performance.now() - mark; mark = performance.now(); }
    const earned = model.bgN >= BG_BAND_MIN && model.lock && model.lock.age >= BAND_AGE;
    learnBg(model, SW, SH, earned && band ? band : null);
    if (P) { P.learn += performance.now() - mark; P.n++; }
    if (!model.prevLum) model.prevLum = new Float32Array(n);
    model.prevLum.set(lum);
    if (!hit && model.lock && ++model.lock.miss > MISS_MAX) model.lock = null;
    return hit;
  };

  // Every would-be miss routes through here. A lock carrying real velocity dead-
  // reckons along it for up to COAST_MAX frames instead of dropping: one motion-
  // blurred or contrast-dead frame must not cost the game its blade, and
  // reacquisition then tests against the advanced line, not a stale one.
  // Each coasted frame still counts as a miss (a genuinely gone blade still dies at
  // MISS_MAX), velocity decays so a lie cannot run away, and a still lock (vel~0)
  // gets no coasting at all — for it this is exactly the old finish(null).
  const coastOut = () => {
    const C = model.lock;
    if (!(C && C.vx0 !== undefined && (C.latV || 0) > 1.5 && C.miss < COAST_MAX)) {
      return finish(null);
    }
    C.miss++;
    // RIGID-BODY dead reckoning: translate the midpoint by the mean velocity and
    // rotate about it by the angular rate the two ends' LATERAL velocities imply.
    // Advancing each end independently let EMA'd axial noise shrink the segment,
    // and a shrinking segment turns small lateral noise into runaway rotation
    // (measured: 10-22deg/frame under decaying velocities). A sword is rigid.
    const dx = C.e1[0] - C.e0[0], dy = C.e1[1] - C.e0[1];
    const bl = Math.hypot(dx, dy) || 1, nx = -dy / bl, ny = dx / bl;
    const w = ((C.vx1 - C.vx0) * nx + (C.vy1 - C.vy0) * ny) / bl;
    const ca = Math.cos(w), sa = Math.sin(w);
    const nmx = (C.e0[0] + C.e1[0]) / 2 + (C.vx0 + C.vx1) / 2;
    const nmy = (C.e0[1] + C.e1[1]) / 2 + (C.vy0 + C.vy1) / 2;
    const rhx = (dx * ca - dy * sa) / 2, rhy = (dx * sa + dy * ca) / 2;
    C.e0[0] = nmx - rhx; C.e0[1] = nmy - rhy; C.e1[0] = nmx + rhx; C.e1[1] = nmy + rhy;
    // Rotate the velocities with the body (a swing is circular, not straight), then
    // damp — 0.75, not gentler: extrapolation overshoots hardest exactly where
    // misses cluster, the stroke reversal, where the blade dwells in its lowest-
    // contrast pose while the prediction sails on.
    const r2 = (v, u) => [v * ca - u * sa, v * sa + u * ca];
    [C.vx0, C.vy0] = r2(C.vx0, C.vy0); [C.vx1, C.vy1] = r2(C.vx1, C.vy1);
    C.vx0 *= 0.75; C.vy0 *= 0.75; C.vx1 *= 0.75; C.vy1 *= 0.75;
    C.vel *= 0.75; C.latV *= 0.75;
    [C.t, C.r] = lineFromEnds(C.e0, C.e1, rho0);
    const e0 = [C.e0[0], C.e0[1]], e1 = [C.e1[0], C.e1[1]];
    const len = Math.hypot(e1[0] - e0[0], e1[1] - e0[1]);
    const angle = Math.atan2(e1[1] - e0[1], e1[0] - e0[0]);
    const cx = (e0[0] + e1[0]) / 2, cy = (e0[1] + e1[1]) / 2;
    return finish({ cx, cy, angle, len, ends: [e0, e1], quality: Math.min(1, len / 70), _t: C.t, _r: C.r },
      { cx, cy, angle, hu: len / 2 + BG_PAD_U, pol: C.pol || 2 });
  };

  // Valley/ridge response, and collect the responders so the vote below only walks
  // the handful of pixels that are actually bar-like.
  //
  // Coarse-to-fine: while a lock is being tracked cleanly, only the window around it
  // is scanned, with a full-frame scan every 4th frame (fresh background, fresh
  // challengers). The filter is ~90% of a busy frame's cost and the window is ~20%
  // of the frame, so tracking frames cost a fraction of acquisition frames. A blade
  // that outruns the window just misses once — the next frame is a full scan.
  const M = OFFS[OFFS.length - 1] + 1;
  model.fn = (model.fn | 0) + 1;
  const Lw = model.lock;
  // fast-moving locks get full scans: a swing can outrun any static window
  const light = Lw && Lw.miss === 0 && Lw.age >= BAND_AGE && (Lw.vel || 0) < 6 && model.fn % 4 !== 0;
  let wx0 = M, wx1 = SW - M, wy0 = M, wy1 = SH - M;
  if (light) {
    const mrg = 30;
    wx0 = Math.max(wx0, Math.floor(Math.min(Lw.e0[0], Lw.e1[0]) - mrg));
    wx1 = Math.min(wx1, Math.ceil(Math.max(Lw.e0[0], Lw.e1[0]) + mrg));
    wy0 = Math.max(wy0, Math.floor(Math.min(Lw.e0[1], Lw.e1[1]) - mrg));
    wy1 = Math.min(wy1, Math.ceil(Math.max(Lw.e0[1], Lw.e1[1]) + mrg));
    // stale resp outside the window is deliberate: learnBg may read values up to 3
    // frames old there, and the bg rates make that indistinguishable from fresh
    for (let y = wy0; y < wy1; y++) resp.fill(0, y * SW + wx0, y * SW + wx1);
  } else {
    resp.fill(0);
  }
  const poff = model.poff, NP = poff.length, NQ = OFFS.length;
  let cnt = 0;
  for (let y = wy0; y < wy1; y++) {
    for (let x = wx0; x < wx1; x++) {
      const i = y * SW + x, c = lum[i];
      // Polarity is tracked because it is an OBJECT property: a dark blade is a dark
      // valley at every pixel where it responds at all, while the bright wall sliver
      // pinched between the blade and a dark neighbour (a skateboard tail 2px away)
      // is a bright ridge. A "line" whose support mixes the two is a phantom chain of
      // blade + sliver — measurably the thing that pulled the lock diagonal.
      let bestD = 0, bestB = 0, thinV = 0;
      for (let z = 0; z < NP; z += NQ) {          // unrolled per direction: OFFS is
        let o = poff[z];                          // [narrow, narrow, wide] and only the
        let a = lum[i + o], b = lum[i - o];       // narrow two feed the thin flag
        let vd = (a < b ? a : b) - c, vb = c - (a > b ? a : b);
        if (vd > bestD) bestD = vd;
        if (vb > bestB) bestB = vb;
        let v = vd > vb ? vd : vb;
        if (v > thinV) thinV = v;
        o = poff[z + 1]; a = lum[i + o]; b = lum[i - o];
        vd = (a < b ? a : b) - c; vb = c - (a > b ? a : b);
        if (vd > bestD) bestD = vd;
        if (vb > bestB) bestB = vb;
        v = vd > vb ? vd : vb;
        if (v > thinV) thinV = v;
        o = poff[z + 2]; a = lum[i + o]; b = lum[i - o];
        vd = (a < b ? a : b) - c; vb = c - (a > b ? a : b);
        if (vd > bestD) bestD = vd;
        if (vb > bestB) bestB = vb;
      }
      const best = bestD > bestB ? bestD : bestB;
      // The background model sees the RAW response, always. Learning from a
      // thresholded response gives marginal-contrast pixels (a mesh-chair slat top, a
      // shirt stripe) a cliff to flicker across: their resp reads 0 on the dip, the
      // vanish rule crashes bg to zero, and the next frame they are full "evidence" —
      // a permanent per-pixel noise machine, measured at ~1% of the frame.
      resp[i] = best;
      if (best > MIN_RESP) {
        thin[i] = thinV > MIN_RESP ? 1 : 0;
        pol[i] = bestD > bestB ? 2 : 1;
        xs[cnt] = x; ys[cnt] = y; cnt++;
      }
    }
  }
  if (P) { P.filter += performance.now() - mark; mark = performance.now(); }
  if (cnt < 20) return coastOut();

  // Evidence = response minus what has always been there. g ramps the subtraction in
  // over BG_WARM frames so frame 1 behaves exactly like the ungated detector.
  // ev is zeroed then written only for this frame's responders, so a nonzero ev IS
  // the support test — no stale values, no separate responder check.
  ev.fill(0);
  const g = Math.min(1, model.bgN / BG_WARM);
  const bg = model.bg, hist = model.hist;
  hist.fill(0);
  let evN = 0;
  for (let j = 0; j < cnt; j++) {
    const i = ys[j] * SW + xs[j];
    const e = resp[i] - g * bg[i];
    ev[i] = e > 0 ? e : 0;
    if (e > EV_MIN) { evN++; hist[Math.min(63, e >> 2)]++; }
  }
  const L = model.lock;
  // Dead-reckoned line for THIS frame: where the blade should be if it kept its
  // measured endpoint velocity. The identity test below accepts the last seen line
  // OR the predicted one — a fast swing rotates out of the static tolerance within
  // one frame, and treating the real blade at its new angle as a "stranger" was,
  // measured, the main source of mid-swing dropouts.
  const spd = L ? Math.min(1, (L.latV || 0) / VEL_REF) : 0;
  let pT = -1, pR = -1;
  // Only from a lock measured LAST frame: after a miss the coasted line has already
  // been advanced, and predicting again from it double-steps ahead — measured, that
  // overshoot rotated the reachable set onto junk mid-reversal.
  if (L && L.vx0 !== undefined && (L.vel || 0) > 1 && L.miss === 0) {
    [pT, pR] = lineFromEnds(
      [L.e0[0] + L.vx0, L.e0[1] + L.vy0], [L.e1[0] + L.vx1, L.e1[1] + L.vy1], rho0);
  }
  // Static tolerance widens with measured LATERAL speed too (prediction is only as
  // good as one frame of constant velocity): ~0.4 bins per px/frame is the
  // tip-speed-to-angle conversion for a ~70px blade.
  const lockT = LOCK_T + Math.min(8, Math.round(0.4 * (L ? L.latV || 0 : 0)));
  const lockR = LOCK_R + Math.min(15, Math.round(1.2 * (L ? L.latV || 0 : 0)));
  // Walk-support threshold: while tracking a FAST lock, accept fainter evidence in
  // the run walk. Motion blur smears the blade wide and faint — at 16px of tip
  // smear its response sits at 6-11 luma, under EV_MIN — and the incumbent and
  // predicted lines are always walked, so the extra sensitivity lands exactly
  // where the blade should be. Faint pixels still do not VOTE (evCut >= EV_MIN),
  // so junk lines cannot ride the lowered bar into the candidate list, and a
  // still lock (spd 0) keeps the full threshold.
  const EVW = spd > 0.5 ? 8 : EV_MIN;
  // Evidence glut: the whole room lit up at once. That is never a blade arriving —
  // learn the frame and stay quiet unless a healthy lock is already being tracked.
  if (evN > GLUT * n && !(L && L.miss === 0)) return coastOut();
  // Bounded vote: keep the strongest voters so cost cannot scale with clutter.
  let evCut = EV_MIN;
  if (evN > VOTE_MAX) {
    let run = 0, b = 63;
    for (; b > 0; b--) { run += hist[b]; if (run >= VOTE_MAX) break; }
    evCut = Math.max(EV_MIN, b << 2);
  }

  // Vote for straight lines instead of growing connected blobs. A blade crossing a
  // dark shirt loses contrast in the middle and breaks into fragments — connected
  // components see several short stubs and reject them all, while every fragment
  // votes for the SAME line here. Occlusion stops mattering. The background model is
  // the discriminator now; motion is only a mild tiebreaker on top.
  acc.fill(0);
  for (let j = 0; j < cnt; j++) {
    const x = xs[j], y = ys[j], i = y * SW + x;
    const e = ev[i];
    if (e <= evCut) continue;
    let w = e;
    if (prevLum) w *= 1 + MO_BOOST * Math.min(1, Math.abs(lum[i] - prevLum[i]) / 10);
    for (let t = 0; t < NTH; t++) {
      const r = (x * COS[t] + y * SIN[t] + rho0) | 0;
      acc[t * nr + r] += w;
    }
  }

  if (P) { P.vote += performance.now() - mark; mark = performance.now(); }
  // Take the strongest few candidate lines, then judge each by the longest CONTIGUOUS
  // run of support along it — not by its total vote. Total vote rewards a line that
  // happens to clip lots of scattered responders; contiguous run is what actually
  // means "a bar lies here".
  let accMax = 0;
  for (let k = 0, m = NTH * nr; k < m; k++) if (acc[k] > accMax) accMax = acc[k];
  const floor = PEAK_FLOOR * accMax;
  const { pv, pt, pr } = model;
  const PK = pv.length;
  let np = 0;
  for (let t = 0; t < NTH; t++) {
    for (let r = 1; r < nr - 1; r++) {
      const v = acc[t * nr + r];
      if (v <= floor) continue;
      if (v < acc[t * nr + r - 1] || v < acc[t * nr + r + 1]) continue; // local max in rho
      if (np === PK && v <= pv[PK - 1]) continue;
      let j = np < PK ? np : PK - 1;                 // insertion keeps pv descending
      while (j > 0 && pv[j - 1] < v) { pv[j] = pv[j - 1]; pt[j] = pt[j - 1]; pr[j] = pr[j - 1]; j--; }
      pv[j] = v; pt[j] = t; pr[j] = r;
      if (np < PK) np++;
    }
  }
  if (!np) return coastOut();

  // Diverse top-24: one strong blob votes at EVERY theta, so without suppression the
  // whole candidate list is 24 near-copies of the same clutter line and the real
  // blade never gets scored at all. Greedily skip peaks too close in (theta, rho) to
  // one already taken.
  const chosen = [];
  for (let k = 0; k < np; k++) {
    let dup = false;
    for (const q of chosen) {
      if (sameLine(pt[k], pr[k], q[1], q[2], rho0, 3, 7)) { dup = true; break; }
    }
    if (!dup) { chosen.push([pv[k], pt[k], pr[k]]); if (chosen.length >= 24) break; }
  }

  // The locked line is always scored, even if its Hough peak fell out of the top-24 —
  // hysteresis is worthless if the incumbent never stands for re-election. The
  // PREDICTED line stands too: mid-swing the incumbent's next position is where the
  // evidence actually is.
  if (L) {
    let has = false, hasP = false;
    for (const q of chosen) {
      if (sameLine(q[1], q[2], L.t, L.r, rho0, 3, 8)) has = true;
      if (pT >= 0 && sameLine(q[1], q[2], pT, pR, rho0, 3, 8)) hasP = true;
    }
    if (!has) chosen.push([0, L.t, L.r]);
    if (pT >= 0 && !hasP && !sameLine(pT, pR, L.t, L.r, rho0, 3, 8)) chosen.push([0, pT, pR]);
  }

  const lim = SW + SH;
  let best = null, lockSeen = false;
  for (const [, bt, br] of chosen) {
    const ct = COS[bt], st = SIN[bt];
    const rho = br - rho0;
    const px0 = rho * ct, py0 = rho * st, ux = -st, uy = ct;
    const onLock = L && (sameLine(bt, br, L.t, L.r, rho0, lockT, lockR) ||
      (pT >= 0 && sameLine(bt, br, pT, pR, rho0, LOCK_T, LOCK_R)));
    // Support now requires EVIDENCE, not just response: a static picture frame edge
    // sitting collinear with the swing line has full response and zero evidence, so it
    // neither extends a run past the real tip nor scores as a phantom bar. That is
    // what the old motion-trim was for, and why it is gone.
    let bestA = 0, bestB = 0, bestScore = -1, bestSup = -1, bestThin = 0, bestDark = 0;
    let bestTaint = false;
    let runA = null, last = null, supN = 0, runScore = 0, runThin = 0, runDark = 0;
    let strongD = 0, strongB = 0;
    // A run must be DENSE, not just long — GAP-bridging exists for a blade crossing a
    // dark shirt, but it also happily chains sparse grain excursions on suppressed
    // clutter into a phantom "long bar" (the exact long spurious collinear chains
    // measured on the live camera) — and POLARITY-CONSISTENT: one object is a dark
    // valley or a bright ridge along its whole length, never a mix.
    // walk only the on-frame span of the line, not the full +-(SW+SH)
    let tA = -lim, tB = lim;
    if (Math.abs(ux) > 1e-6) {
      const a = (0 - px0) / ux, b2 = (SW - 1 - px0) / ux;
      tA = Math.max(tA, Math.min(a, b2)); tB = Math.min(tB, Math.max(a, b2));
    } else if (px0 < 0 || px0 > SW - 1) continue;
    if (Math.abs(uy) > 1e-6) {
      const a = (0 - py0) / uy, b2 = (SH - 1 - py0) / uy;
      tA = Math.max(tA, Math.min(a, b2)); tB = Math.min(tB, Math.max(a, b2));
    } else if (py0 < 0 || py0 > SH - 1) continue;
    if (tB < tA) continue;
    const close = () => {
      if (supN < 0.4 * (last - runA + 1)) return;
      // 0.62, not higher: a real blade tracks ~2/3 dominance when a bright sliver
      // hugs its base; a phantom chain of blade + sliver sits near 50/50.
      const dark = runDark > supN - runDark;
      const dom = dark ? runDark : supN - runDark;
      if (dom < 0.62 * supN) return;
      // A phantom made of the two bright wedges PINCHED AGAINST a dark blade is
      // polarity-consistent with itself — but it has to cross its parent bar, so a
      // large share of its run is STRONG opposite-polarity positions. A real object
      // never is. TAINT, not rejection: a tainted run may never CAPTURE the lock
      // (this exact impostor captured it and then absorbed the blade), but one that
      // matches the existing lock is still reported — a locked blade swinging past a
      // lamp or a skateboard picks up strong foreign pixels honestly.
      const taint = (dark ? strongB : strongD) >= Math.max(3, 0.18 * supN);
      if (runScore > bestScore) {
        bestScore = runScore; bestSup = supN; bestThin = runThin; bestDark = runDark;
        bestTaint = taint; bestA = runA; bestB = last;
      }
    };
    for (let t = Math.ceil(tA), tE = Math.floor(tB); t <= tE; t++) {
      const x = px0 + ux * t, y = py0 + uy * t;
      if (x < 0 || y < 0 || x >= SW || y >= SH) { if (runA !== null) { close(); runA = null; } continue; }
      let sup = 0, th = 0, m = 0, emax = 0, epol = 0, eraw = 0;
      for (let o = -NEAR; o <= NEAR; o += 1) {
        const sx = (x - st * o) | 0, sy = (y + ct * o) | 0;
        if (sx < 0 || sy < 0 || sx >= SW || sy >= SH) continue;
        const i = sy * SW + sx;
        const e = ev[i];
        if (e <= EVW) continue;
        sup = 1;
        // The corridor exists to tolerate sub-pixel line placement, not to hand the
        // position to a neighbour: weight the polarity pick toward the axis, or a
        // bright sliver 2px off a dark blade outvotes the blade's own pixel.
        const we = e * (1 - 0.28 * (o < 0 ? -o : o));
        if (we > emax) { emax = we; epol = pol[i]; eraw = e; }
        if (thin[i]) th = 1;
        if (prevLum) { const mm = Math.abs(lum[i] - prevLum[i]); if (mm > m) m = mm; }
      }
      if (sup) {
        if (runA === null) { runA = t; supN = 0; runScore = 0; runThin = 0; runDark = 0; strongD = 0; strongB = 0; }
        last = t; supN++; runThin += th;
        if (epol === 2) { runDark++; if (eraw > 2.4 * EV_MIN) strongD++; }
        else if (eraw > 2.4 * EV_MIN) strongB++;
        runScore += 1 + MO_BOOST * Math.min(1, m / 10);
      } else if (runA !== null && t - last > GAP) { close(); runA = null; }
    }
    if (runA !== null) close();
    if (bestSup < MIN_LEN) continue;
    if (onLock) lockSeen = true;
    let score = bestScore;
    if (onLock) score *= LOCK_BOOST;
    if (!best || score > best.score) {
      best = { score, bt, br, aT: bestA, bT: bestB, sup: bestSup, thinN: bestThin,
        dark: bestDark, taint: bestTaint, onLock };
    }
  }
  if (!best) return coastOut();

  // A healthy incumbent's single bad frame must not hand the lock to a stranger: if
  // the locked line produced no valid run at all this frame (a one-frame rejection,
  // an occlusion), a NON-matching winner is refused once. If the incumbent is really
  // gone it misses a few more frames and the replacement goes through. At speed the
  // refusal window shrinks to one frame: a fast blade legitimately teleports in
  // line-space, and refusing it for 3 frames was, measured, the largest single
  // source of mid-swing dropouts.
  if (L && !best.onLock && !lockSeen && L.miss < (spd > 0.5 ? 1 : 3)) return coastOut();

  // Rotation-rate cap against the CONFIDENT axis: a physical blade cannot turn
  // ~90deg in one frame, so a non-incumbent winner far off the last trusted axis is
  // junk light, not the sword (measured: every perpendicular "glitch" frame was
  // such a capture, taken while the real blade sat in a contrast-dead pose — and
  // the reference must be the last CONFIDENT lock, because a fresh junk capture
  // otherwise becomes its own alibi). The allowance grows every frame the axis
  // goes unconfirmed, so a blade genuinely turning while invisible is reachable
  // the moment it re-emerges, and cold acquisition is never blocked for long. A
  // challenger with heavy per-pixel motion (score >= 1.7x sup) bypasses the cap:
  // that is a genuinely swinging blade breaking a wrongly-latched static lock,
  // which must stay possible (junk lines measure 1.3-1.45x).
  // The allowance grows faster when the blade was MOVING when last seen (~0.75deg
  // of axis per px/frame of lateral end speed): a hard swing rotates ~12deg/frame,
  // and a fixed growth lost the re-acquisition race to junk near the stale axis.
  if (!best.onLock && model.ax && best.score < 1.7 * best.sup) {
    let dtb = Math.abs(best.bt - model.ax.t);
    if (dtb > NTH / 2) dtb = NTH - dtb;
    if (dtb * (180 / NTH) > 8 + (6 + 1.5 * (model.ax.v || 0)) * (model.ax.n + 1)) return coastOut();
  }

  // ...and the translation analog: a blade cannot teleport across the room in a
  // frame either. Junk that slips past the rotation cap — roughly parallel, or the
  // allowance grown wide over a blind stretch — is almost always far away
  // spatially (measured captures of junk sat 36-70px from the lock; real
  // re-captures a few px to ~25px). Same growth, same heavy-motion escape.
  if (L && !best.onLock && best.score < 1.7 * best.sup) {
    const ctg = COS[best.bt], stg = SIN[best.bt], rg = best.br - rho0;
    const mtg = (best.aT + best.bT) / 2;
    const gx = rg * ctg - stg * mtg, gy = rg * stg + ctg * mtg;
    const ldx = (L.e0[0] + L.e1[0]) / 2 - gx, ldy = (L.e0[1] + L.e1[1]) / 2 - gy;
    if (Math.hypot(ldx, ldy) > 15 + 8 * (L.miss + 1)) return coastOut();
  }

  // A replacement must look like a blade: thin-dominant, or genuinely MOVING (a fast
  // swing blurs the blade fat, but then its pixels carry heavy motion — score >> sup).
  // A fat, static line (a skateboard-tail diagonal frozen novel under its own band)
  // may never take a lock, which is what used to happen mid-raise and stick forever.
  // Taint blocks a replacement only while the candidate is STATIC: the pinched-wedge
  // impostor taint exists for never moves, while a real blade sweeping across clutter
  // honestly picks up strong foreign pixels and used to be refused for exactly that.
  if (L && !best.onLock && ((best.taint && best.score < 1.5 * best.sup) ||
    (best.thinN < EST_THIN * best.sup && best.score < 1.4 * best.sup))) {
    return coastOut();
  }

  // Establishing a lock from NOTHING demands blade-like structure: long enough, and
  // mostly thin. A skateboard on the wall is a genuine valley bar but a fat one; a
  // picture frame side is thin but short. Once locked (or replacing a live lock mid
  // swing, when blur fattens the blade) MIN_LEN is enough — the lock and the learned
  // background carry the discrimination. Honest limit: a long thin static bar (a
  // broom, a curtain rod) present at cold start IS undecidable without motion; the
  // first real swing out-scores it (MO_BOOST > LOCK_BOOST-1) and the room learns it.
  if (!L && (best.sup < EST_LEN || best.taint ||
    (best.thinN < EST_THIN * best.sup && best.score < 1.4 * best.sup))) return finish(null);

  // Trim ends kept alive by a single isolated grain pixel bridged across a GAP —
  // without this the tip lunges up to GAP px at whatever frame the noise lands on.
  const ct = COS[best.bt], st = SIN[best.bt];
  const rho = best.br - rho0, px0 = rho * ct, py0 = rho * st, ux = -st, uy = ct;
  const supL = model.sup, len0 = best.bT - best.aT;
  for (let t = 0; t <= len0; t++) {
    const x = px0 + ux * (best.aT + t), y = py0 + uy * (best.aT + t);
    let s = 0;
    if (x >= 0 && y >= 0 && x < SW && y < SH) {
      for (let o = -NEAR; o <= NEAR; o += 1) {
        const sx = (x - st * o) | 0, sy = (y + ct * o) | 0;
        if (sx < 0 || sy < 0 || sx >= SW || sy >= SH) continue;
        const i = sy * SW + sx;
        if (ev[i] > EVW) { s = 1; break; }
      }
    }
    supL[t] = s;
  }
  const lone = (i, dir) => {
    for (let k = 1; k <= 3; k++) {
      const j = i + dir * k;
      if (j >= 0 && j <= len0 && supL[j]) return false;
    }
    return true;
  };
  let a = 0, b = len0;
  while (a < b && (!supL[a] || lone(a, 1))) a++;
  while (b > a && (!supL[b] || lone(b, -1))) b--;
  if (b - a < MIN_LEN) { a = 0; b = len0; }
  let m0 = [px0 + ux * (best.aT + a), py0 + uy * (best.aT + a)];
  let m1 = [px0 + ux * (best.aT + b), py0 + uy * (best.aT + b)];

  // Refine the line by weighted moments over the run's own dominant-polarity
  // evidence pixels. The Hough grid is 2deg x 1px, and on a short visible segment
  // that quantization plus endpoint noise makes the winner hop between neighbouring
  // bins frame to frame — reported ends danced several px with nothing moving. The
  // pixels themselves don't hop; fit them instead and the stair-step disappears.
  const wantPol = best.dark * 2 >= best.sup ? 2 : 1;
  {
    let Wm = 0, Sx = 0, Sy = 0, Sxx = 0, Sxy = 0, Syy = 0;
    for (let t = a; t <= b; t++) {
      if (!supL[t]) continue;
      const x = px0 + ux * (best.aT + t), y = py0 + uy * (best.aT + t);
      for (let o = -NEAR; o <= NEAR; o += 1) {
        const sx = (x - st * o) | 0, sy = (y + ct * o) | 0;
        if (sx < 0 || sy < 0 || sx >= SW || sy >= SH) continue;
        const i = sy * SW + sx;
        const e = ev[i];
        if (e <= EVW || pol[i] !== wantPol) continue;
        // lateral weighting, quadratic: a dark neighbour's pixels at the corridor's
        // edge (an abutting skateboard tail) must not drag the fitted axis — at
        // linear weighting they still tilted a 5px blade's axis by ~7deg
        const lw = 1 - (o < 0 ? -o : o) / 2.6;
        const w = e * lw * lw;
        Wm += w; Sx += w * sx; Sy += w * sy;
        Sxx += w * sx * sx; Sxy += w * sx * sy; Syy += w * sy * sy;
      }
    }
    if (Wm > 0) {
      const mxc = Sx / Wm, myc = Sy / Wm;
      const cxx = Sxx / Wm - mxc * mxc, cxy = Sxy / Wm - mxc * myc, cyy = Syy / Wm - myc * myc;
      const fa = 0.5 * Math.atan2(2 * cxy, cxx - cyy);
      const fx = Math.cos(fa), fy = Math.sin(fa);
      // keep the fitted axis only if it agrees with the walked line (it must — the
      // pixels came from that corridor; this is a guard, not a decision)
      if (Math.abs(fx * ux + fy * uy) > 0.9) {
        const t0 = (m0[0] - mxc) * fx + (m0[1] - myc) * fy;
        const t1 = (m1[0] - mxc) * fx + (m1[1] - myc) * fy;
        m0 = [mxc + fx * t0, myc + fy * t0];
        m1 = [mxc + fx * t1, myc + fy * t1];
      }
    }
  }

  if (best.onLock) {
    const d2 = (p, q) => (p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2;
    if (d2(m0, L.e0) + d2(m1, L.e1) > d2(m1, L.e0) + d2(m0, L.e1)) { const t2 = m0; m0 = m1; m1 = t2; }
    // Endpoint velocity, measured-to-measured (the reported ends are smoothed and
    // would understate a swing), per frame across any missed gap, EMA'd one step so
    // grain flicker averages out, components capped so a fragment jump (the base end
    // re-appearing 30px down the blade) cannot poison the prediction.
    const gapI = 1 / (L.miss + 1), cap = (v) => (v > 24 ? 24 : v < -24 ? -24 : v);
    if (L.pm0) {
      const nx0 = cap((m0[0] - L.pm0[0]) * gapI), ny0 = cap((m0[1] - L.pm0[1]) * gapI);
      const nx1 = cap((m1[0] - L.pm1[0]) * gapI), ny1 = cap((m1[1] - L.pm1[1]) * gapI);
      if (L.vx0 === undefined) { L.vx0 = nx0; L.vy0 = ny0; L.vx1 = nx1; L.vy1 = ny1; }
      else {
        L.vx0 = 0.5 * L.vx0 + 0.5 * nx0; L.vy0 = 0.5 * L.vy0 + 0.5 * ny0;
        L.vx1 = 0.5 * L.vx1 + 0.5 * nx1; L.vy1 = 0.5 * L.vy1 + 0.5 * ny1;
      }
      L.vel = Math.max(Math.hypot(nx0, ny0), Math.hypot(nx1, ny1));
      // Swing speed = the LATERAL component of endpoint velocity only. A support
      // fragment flickering in and out moves the measured endpoint ALONG the axis
      // (15-30px in one frame with nothing physically moving), and letting that
      // open the clamps sawed the drift-test endpoints at 4px/frame. Real rotation
      // and translation of a thin bar show up perpendicular to it.
      const axl = Math.hypot(L.e1[0] - L.e0[0], L.e1[1] - L.e0[1]) || 1;
      const nux = -(L.e1[1] - L.e0[1]) / axl, nuy = (L.e1[0] - L.e0[0]) / axl;
      const lv = Math.max(Math.abs(nx0 * nux + ny0 * nuy), Math.abs(nx1 * nux + ny1 * nuy));
      // EMA: the clamps open on SUSTAINED speed. One noisy excursion halves away; a
      // real swing sustains 5-15px/frame and keeps them open the whole stroke.
      L.latV = L.latV === undefined ? lv : 0.5 * L.latV + 0.5 * lv;
    }
    L.pm0 = m0.slice(); L.pm1 = m1.slice();
    // Speed factor with a 2.5px floor: held-still measurement wobble (up to ~2px on
    // a wide blade, laterally, EMA'd) must leave the clamps fully closed.
    const sp = Math.min(1, Math.max(0, ((L.latV || 0) - 2.5) / (VEL_REF - 2.5)));
    // A measured run SHORTER along the same axis is usually occlusion or a contrast
    // hole, not the sword shrinking — the base end was teleporting 15-20px as the
    // lower half's marginal support flickered in and out. Coast inward slowly;
    // growth and lateral movement stay fast.
    const hx = L.e1[0] - L.e0[0], hy = L.e1[1] - L.e0[1];
    const hl = Math.hypot(hx, hy) || 1, uxh = hx / hl, uyh = hy / hl;
    const cxh = (L.e0[0] + L.e1[0]) / 2, cyh = (L.e0[1] + L.e1[1]) / 2;
    const along = (p) => (p[0] - cxh) * uxh + (p[1] - cyh) * uyh;
    const coast = (h, m) => {
      // Only when the measured end is ON the held axis — pure breathing along the
      // blade. A swinging end departs laterally and must take the fast path.
      const lat = (m[0] - cxh) * -uyh + (m[1] - cyh) * uxh;
      if (Math.abs(lat) >= 4.5) return false;
      // Axis extent, asymmetric: noise creeps, real growth is fast (capped so a
      // flickering lower half re-extends smoothly instead of teleporting 15-20px),
      // shrink decays slowly — a vanished tail is usually occlusion, and chasing an
      // alternating measurement at full speed just saws the endpoint back and forth.
      // Both caps and the deadband open with speed: mid-swing the geometry must be
      // allowed to keep up with the blade — the still-tuned 5px growth cap was one
      // of the things that could not.
      const sig = along(h) >= 0 ? 1 : -1;
      const dA = sig * (along(m) - along(h));
      const db = DEAD * (1 - sp);
      const dAx = dA > db ? Math.min(dA, 5 + 20 * sp)
        : dA < -db ? Math.max(dA, -(0.35 + 8 * sp)) : dA * 0.06;
      const fL = Math.abs(lat) < DEAD ? 0.06 : Math.min(1, Math.abs(lat) / PULL_FULL);
      h[0] += uxh * sig * dAx + -uyh * lat * fL;
      h[1] += uyh * sig * dAx + uxh * lat * fL;
      return true;
    };
    if (!coast(L.e0, m0)) pull(L.e0, m0, sp);
    if (!coast(L.e1, m1)) pull(L.e1, m1, sp);
    const hadGap = L.miss > 0;
    L.t = best.bt; L.r = best.br; L.miss = 0; L.age++; L.pol = wantPol;
    // CONSECUTIVE confirmations only: the first hit after a blind gap may be a junk
    // line matched against a coasted (guessed) position, and refreshing the trusted
    // axis from it would make the junk its own alibi.
    if (!hadGap && L.age >= BAND_AGE) model.ax = { t: best.bt, n: 0, v: L.latV || 0 };
  } else {
    // vel 9 keeps full scans until real speed is measured; latV 0 keeps the line
    // tolerances TIGHT — seeding it fast let a fresh (possibly wrong) capture walk
    // across neighbouring clutter lines before its first honest measurement.
    const nl = { t: best.bt, r: best.br, e0: m0.slice(), e1: m1.slice(),
      pm0: m0.slice(), pm1: m1.slice(), miss: 0, age: 1, vel: 9, latV: 0, pol: wantPol };
    // ...but a replacement mid-swing is the SAME physical blade a few frames on:
    // inherit the outgoing lock's damped velocity, or the very next blurred frame
    // finds a velocity-less lock that cannot coast (measured as 3-frame dropouts
    // right after every mid-swing re-capture).
    if (L && L.vx0 !== undefined) {
      const d2c = (p, q) => (p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2;
      const flip = d2c(m0, L.e0) + d2c(m1, L.e1) > d2c(m1, L.e0) + d2c(m0, L.e1);
      nl.vx0 = 0.75 * (flip ? L.vx1 : L.vx0); nl.vy0 = 0.75 * (flip ? L.vy1 : L.vy0);
      nl.vx1 = 0.75 * (flip ? L.vx0 : L.vx1); nl.vy1 = 0.75 * (flip ? L.vy0 : L.vy1);
      nl.vel = 0.75 * (L.vel || 0); nl.latV = 0.75 * (L.latV || 0);
    }
    model.lock = nl;
  }

  const K = model.lock;
  const e0 = [K.e0[0], K.e0[1]], e1 = [K.e1[0], K.e1[1]];
  const len = Math.hypot(e1[0] - e0[0], e1[1] - e0[1]);
  const angle = Math.atan2(e1[1] - e0[1], e1[0] - e0[0]);
  const cx = (e0[0] + e1[0]) / 2, cy = (e0[1] + e1[1]) / 2;
  return finish({
    cx, cy, angle, len, ends: [e0, e1],
    quality: Math.min(1, len / 70),
    _t: best.bt, _r: best.br,
  }, { cx, cy, angle, hu: len / 2 + BG_PAD_U, pol: wantPol });
}
