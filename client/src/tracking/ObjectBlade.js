// Katana mode: the blade is a physical object you hold, and it is the ONLY thing
// tracked — no hand model runs in this mode at all. That is a deliberate constraint,
// not an omission: with no palm to anchor on there is no scale reference and no
// fallback angle, so the detector has to find an elongated object anywhere in frame.
//
// Enrolment asks you to WAVE the object, because motion is what separates your sword
// from every other long edge in the room — a door frame, a shelf, a table edge. Once
// enrolled, tracking follows that object alone.
//
// Only the ANGLE and the grip POSITION come from vision. The on-screen blade length is
// a game-feel setting in main.js, so reach stays comparable to hand mode whatever you
// happen to be holding.
import { OneEuroFilter } from "./OneEuroFilter.js";
import * as detector from "./detectAuto.js";

const SCAN_W = 192;          // scan resolution: enough structure, cheap enough for 30fps
const BUF_FRAMES = 20;       // ~0.7s of history at 30fps feeding enrolment
const MIN_FRAMES = 10;       // don't even try to enrol on less than this
const MOTION_TARGET = 3.2;   // accumulated inter-frame motion (mean abs delta) before we commit
const MOTION_STRIDE = 4;     // subsample when measuring motion — we need a magnitude, not detail
const SWAP_MARGIN = 0.6;     // how decisively the other end must be slower before the hilt flips
const COAST_MISS = 6;        // frames we will fly on predicted velocity before dropping the lock
const VEL_MIX = 0.5;         // how fast the velocity estimate follows the measured step
const VEL_CAP = 26;          // px/frame ceiling, so a bad frame can't fling the blade away
const STORE_KEY = "fn_katana";

// --- latency compensation ---------------------------------------------------------
// By the time a detection is drawn, the real sword has moved on: camera exposure,
// browser delivery, downscale, detect, smooth, render. Measured live that is 50-80ms,
// which during a hard swing is a large visible trail. So the emitted pose is
// extrapolated forward along its measured velocity by a MEASURED delay — never an
// assumed one, because cameras and browsers differ wildly (node median 3ms vs browser
// p90 30ms on the same detector).
const LEAD_MAX_MS = 120;     // ceiling on the applied lead — a bad reading must not fling the blade
// Held still the detector jitters ~0.06px/frame, so this dead zone keeps the lead off
// almost always: measured over 300 still frames only 8 of 288 crossed it, and those got
// under 2ms of lead — median endpoint movement was unchanged at 0.351px. Not literally
// bit-identical, but far below the level anything is visible at.
const LEAD_DEAD = 0.75;      // px/frame below which no lead applies
// Measured peak of a real ±70deg swing is 7.5px/frame mean endpoint speed, so full lead
// lands at the top of a hard swing and the median of that swing sits near a third of it.
// Lowering this trades tail for median (LF=4: median render-time angle error 7.3->4.8deg
// but worst 20.6->22.6deg, because extrapolation must overshoot at a stroke reversal).
const LEAD_FULL = 8;         // px/frame at which the full measured delay is applied
const LEAD_ROT_CAP = 0.9;    // rad cap on extrapolated rotation, so ω noise can't spin the blade
const SKEW_LEAK = 0.5;       // ms/frame the min-skew floor drifts up — re-adapts in ~2s at 30fps
const SKEW_RESEED = 500;     // a frame "older" than this is a clock discontinuity, not a real age
// Angle passes through the cos/sin 1-euro AFTER extrapolation, which eats some of the
// lead. Measured on the deployed params (minCutoff 1.5, beta 4.0 at 30Hz) the lag PEAKS
// mid-swing and falls away again — 15.8ms at 150deg/s, 18.0 at 300, 15.5 at 450, 7.4 at
// 700 — because that is exactly what the 1-euro speed term is for. Folding in the peak
// slightly over-leads the fastest swings, which is the safe direction: it is only added
// when the lead itself applies, i.e. exactly when the blade is swinging.
const SMOOTH_LAG_MS = 18;

const clamp01 = (v) => Math.min(1, Math.max(0, v));

/**
 * Match this frame's two endpoints to the previous frame's, so a hilt/tip decision
 * carries forward. The detector reports an unordered axis, so without this the two
 * ends swap identity at random and the blade flips end-over-end every few frames.
 * @returns {[number, number]} indices into `ends` for [prevEnd0, prevEnd1]
 */
/** One frame's endpoint step, clamped so a single bad detection can't fling the blade. */
export function clampStep(d) { return Math.max(-VEL_CAP, Math.min(VEL_CAP, d)); }

export function pairEnds(ends, prevEnds) {
  const d = (a, b) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2;
  const straight = d(ends[0], prevEnds[0]) + d(ends[1], prevEnds[1]);
  const crossed = d(ends[1], prevEnds[0]) + d(ends[0], prevEnds[1]);
  return crossed < straight ? [1, 0] : [0, 1];
}

/**
 * Track the floor of `skew` (performance.now − media time): the floor is the freshest
 * delivery ever seen, so skew − floor is how stale the CURRENT frame already is. The
 * floor leaks upward slowly so a genuine latency shift re-adapts, and re-seeds outright
 * on a clock discontinuity (stream restart resets currentTime, which would otherwise
 * read as a frame hundreds of ms old).
 */
export function updateMinSkew(minSkew, skew) {
  if (skew - minSkew > SKEW_RESEED) return skew;
  return Math.min(minSkew + SKEW_LEAK, skew);
}

/** Capture-to-render estimate: frame age plus one detect+dispatch interval, clamped. */
export function estimateDelayMs(skew, minSkew, tickMs) {
  return Math.min(LEAD_MAX_MS, Math.max(0, (skew - minSkew) + tickMs));
}

/**
 * How much of the measured delay to actually apply, 0..1. Zero below LEAD_DEAD so the
 * held-still case (0.06px endpoint jitter) is untouched — lead there would only
 * amplify noise into visible wobble. Confidence scales it too: a shaky lock must not
 * amplify its own error.
 */
export function leadScale(speed, conf) {
  return clamp01((speed - LEAD_DEAD) / (LEAD_FULL - LEAD_DEAD)) * clamp01(conf);
}

/**
 * Advance the blade by `leadFrames` as a RIGID BODY: translate by the mean endpoint
 * velocity, rotate about the centre by the angular rate the endpoints' lateral
 * velocities imply. Never advect the endpoints independently — that turns axial noise
 * into runaway rotation, a bug this codebase has already hit once. Axial velocity
 * components (the blade "stretching") contribute nothing here by construction, and a
 * rotation cannot change the blade's length.
 */
export function rigidExtrapolate(ends, vel, leadFrames) {
  const cx = (ends[0][0] + ends[1][0]) / 2, cy = (ends[0][1] + ends[1][1]) / 2;
  const vcx = (vel[0][0] + vel[1][0]) / 2, vcy = (vel[0][1] + vel[1][1]) / 2;
  const hx = ends[1][0] - cx, hy = ends[1][1] - cy;
  const h2 = hx * hx + hy * hy;
  // lateral component of end 1's velocity about the centre → rad/frame
  const w = h2 > 1e-6 ? (hx * (vel[1][1] - vcy) - hy * (vel[1][0] - vcx)) / h2 : 0;
  const rot = Math.max(-LEAD_ROT_CAP, Math.min(LEAD_ROT_CAP, w * leadFrames));
  const cos = Math.cos(rot), sin = Math.sin(rot);
  const ncx = cx + vcx * leadFrames, ncy = cy + vcy * leadFrames;
  const rhx = hx * cos - hy * sin, rhy = hx * sin + hy * cos;
  return [[ncx - rhx, ncy - rhy], [ncx + rhx, ncy + rhy]];
}

// You hold a sword below its tip, so the grip is the LOWER end on screen. The 6px
// margin is hysteresis: without it the two ends trade places every frame the moment the
// blade swings through horizontal.
function hiltEnd(ends, current) {
  const [a, b] = ends;
  if (Math.abs(a[1] - b[1]) < 6) return current;
  return a[1] > b[1] ? 0 : 1;
}

export class ObjectBlade {
  constructor() {
    this.model = null;       // detector's enrolled model — survives in localStorage
    this.canvas = null;
    this.ctx = null;
    this.buf = [];           // recent frames, oldest first (enrolment only)
    this.motion = 0;         // accumulated inter-frame motion during enrolment
    this.lastFrame = null;
    this.failed = false;     // enrolment ran and found nothing long enough
    this.prev = null;        // last accepted detection, threaded back into detect()
    this.prevEnds = null;
    this.hilt = 0;           // which of prevEnds is the grip end
    this.speed = [0, 0];     // per-endpoint movement, exponentially averaged
    // cos/sin are unit-scale, so beta is far larger than the pixel-space filters in
    // main.js to get the same "fast swing → low lag" behaviour.
    this.miss = 0;           // consecutive detector misses we are coasting through
    this.vel = [[0, 0], [0, 0]];  // per-endpoint velocity, px/frame
    // Pipeline-delay bookkeeping. These describe the camera/browser, not the track, so
    // reset() leaves them alone — the measurement stays warm across re-locks.
    this.minSkew = Infinity; // floor of (now − media time), the freshest delivery seen
    this.tickEma = 33;       // ms between detections, exponentially averaged
    this.delayMs = 0;        // current capture-to-render estimate
    // beta is LARGE because these filter cos/sin, whose derivatives only reach a few
    // units per second even in a hard swing. With a small beta the cutoff barely rises
    // off its floor and the blade stays heavily smoothed exactly when it is moving
    // fastest — which reads as lag and glitching.
    this.fcos = new OneEuroFilter(30, 1.5, 4.0);
    this.fsin = new OneEuroFilter(30, 1.5, 4.0);
  }

  // Draw the current video frame into the ONE reused offscreen canvas (never allocate
  // per frame). Created lazily so this module can be imported under plain node.
  _grab(video) {
    const vw = video?.videoWidth || 0, vh = video?.videoHeight || 0;
    if (!vw || !vh) return null;
    const SH = Math.round((SCAN_W * vh) / vw);
    if (!this.ctx) {
      this.canvas = document.createElement("canvas");
      this.ctx = this.canvas.getContext("2d", { willReadFrequently: true });
    }
    if (this.canvas.width !== SCAN_W || this.canvas.height !== SH) {
      this.canvas.width = SCAN_W;
      this.canvas.height = SH;
    }
    try {
      this.ctx.drawImage(video, 0, 0, SCAN_W, SH);
      return { pixels: this.ctx.getImageData(0, 0, SCAN_W, SH).data, SW: SCAN_W, SH };
    } catch {
      return null; // tainted or undecoded frame
    }
  }

  /** Mean absolute luminance change against the previous frame, subsampled. */
  _motionSince(pixels) {
    if (!this.lastFrame || this.lastFrame.length !== pixels.length) return 0;
    let sum = 0, n = 0;
    for (let i = 0; i < pixels.length; i += 4 * MOTION_STRIDE) {
      sum += Math.abs(pixels[i] - this.lastFrame[i]);
      n++;
    }
    return n ? sum / n : 0;
  }

  /** Progress of the wave, 0..1 — drives the enrolment readout. */
  get scanProgress() { return clamp01(this.motion / MOTION_TARGET); }

  /** Throw away enrolment state and start the wave over (Deny, or re-entering). */
  rescan() {
    this.buf = [];
    this.motion = 0;
    this.lastFrame = null;
    this.failed = false;
  }

  /**
   * Called every frame while the enrolment screen is up. The filter needs no training,
   * so this just waits for the same bar to be found a few frames running and hands it
   * straight back — no wave, no enrolment step.
   */
  scan(video) {
    const f = this._grab(video);
    if (!f) return null;
    if (!this.model) this.model = detector.enroll([f.pixels], f.SW, f.SH);
    const hit = detector.detect(f.pixels, f.SW, f.SH, this.model, this.prev);
    this.prev = hit;
    if (!hit) { this.stable = 0; return null; }
    this.stable = (this.stable || 0) + 1;
    this.lastSeen = [{ x: hit.ends[0][0] / f.SW, y: hit.ends[0][1] / f.SH },
                     { x: hit.ends[1][0] / f.SW, y: hit.ends[1][1] / f.SH }];
    if (this.stable < 3) return null;

    const hilt = hiltEnd(hit.ends, 0);
    const tip = 1 - hilt;
    return {
      model: null, ends: hit.ends, hilt, quality: hit.quality,
      angle: Math.atan2(hit.ends[tip][1] - hit.ends[hilt][1], hit.ends[tip][0] - hit.ends[hilt][0]),
      gripNorm: { x: hit.ends[hilt][0] / f.SW, y: hit.ends[hilt][1] / f.SH },
      tipNorm: { x: hit.ends[tip][0] / f.SW, y: hit.ends[tip][1] / f.SH },
    };
  }

  accept(candidate) {
    if (!candidate) return;
    this.reset();
    // Seed tracking with the pose you approved, so the very first frame already knows
    // which end is the grip instead of re-deriving it.
    this.prevEnds = candidate.ends;
    this.hilt = candidate.hilt;
  }

  load() { return false; } // the filter needs no training, so there is nothing to restore

  get calibrated() { return true; }

  /**
   * Per game frame. Null means the object is not visible — main.js coasts for a few
   * frames and then shows the "bring your blade back" prompt. There is no hand to fall
   * back on in this mode, which is exactly what was asked for.
   * @returns {{gripNorm:{x,y}, angle, conf}|null}
   */
  update(video, dtMs) {
    const f = this._grab(video);
    if (!f) return null;
    // Measure how old this frame already is (skew against its rolling floor) and how
    // long a detect+dispatch cycle takes right now, so the lead tracks the REAL
    // machine — the browser tail measured 44.8ms worst against a 3ms node median.
    const skew = performance.now() - video.currentTime * 1000;
    this.minSkew = updateMinSkew(this.minSkew, skew);
    if (dtMs > 0 && dtMs < 200) this.tickEma += (dtMs - this.tickEma) * 0.1;
    this.delayMs = estimateDelayMs(skew, this.minSkew, this.tickEma);
    if (!this.model) this.model = detector.enroll([f.pixels], f.SW, f.SH);
    const hit = detector.detect(f.pixels, f.SW, f.SH, this.model, this.prev);

    if (!hit) {
      // COAST. A hard swing blurs the blade past the detector for a frame or two, and
      // dropping the lock there is what makes it feel like it "loses it easily": the
      // next frame then starts cold and is even more likely to miss. So fly on the last
      // measured velocity for a few frames, and keep `prev` alive (moved along with the
      // prediction) so the detector keeps searching where the blade is GOING rather than
      // re-acquiring from scratch.
      if (!this.prevEnds || this.miss >= COAST_MISS) { this.prev = null; return null; }
      this.miss++;
      const ends = [
        [this.prevEnds[0][0] + this.vel[0][0], this.prevEnds[0][1] + this.vel[0][1]],
        [this.prevEnds[1][0] + this.vel[1][0], this.prevEnds[1][1] + this.vel[1][1]],
      ];
      this.prevEnds = ends;
      if (this.prev) {
        const vx = (this.vel[0][0] + this.vel[1][0]) / 2, vy = (this.vel[0][1] + this.vel[1][1]) / 2;
        this.prev = { ...this.prev, cx: this.prev.cx + vx, cy: this.prev.cy + vy };
      }
      return this._emit(ends, f, dtMs, 0.25);
    }

    let ends = hit.ends;
    if (this.prevEnds) {
      const [i0, i1] = pairEnds(ends, this.prevEnds);
      ends = [ends[i0], ends[i1]];
      // Velocity is what makes coasting possible, so it is measured here, on good frames.
      for (let k = 0; k < 2; k++) {
        const dx = clampStep(ends[k][0] - this.prevEnds[k][0]);
        const dy = clampStep(ends[k][1] - this.prevEnds[k][1]);
        this.vel[k][0] += (dx - this.vel[k][0]) * VEL_MIX;
        this.vel[k][1] += (dy - this.vel[k][1]) * VEL_MIX;
      }
    }
    this.miss = 0;
    this.hilt = hiltEnd(ends, this.hilt);
    this.prevEnds = ends;
    this.prev = hit;
    return this._emit(ends, f, dtMs, hit.quality);
  }

  /** Shared shaping of a pair of endpoints into what main.js consumes. */
  _emit(ends, f, dtMs, conf) {
    // Lead the pose by the measured pipeline delay (plus the angle filter's own
    // measured lag, which sits downstream of this extrapolation). Speed/confidence
    // scaled, so a still blade emits exactly what was measured. Tracking state
    // (prevEnds, vel) was already updated from the MEASURED ends — the prediction
    // never feeds back into itself.
    const sp = (Math.hypot(this.vel[0][0], this.vel[0][1]) + Math.hypot(this.vel[1][0], this.vel[1][1])) / 2;
    const lead = Math.min(LEAD_MAX_MS, this.delayMs + SMOOTH_LAG_MS) * leadScale(sp, conf);
    if (lead > 0) ends = rigidExtrapolate(ends, this.vel, lead / this.tickEma);
    const hilt = ends[this.hilt], tip = ends[1 - this.hilt];
    const raw = Math.atan2(tip[1] - hilt[1], tip[0] - hilt[0]);
    // Smooth wrap-safely: filtering the angle itself would spin the blade all the way
    // around every time it crosses ±π.
    const freq = dtMs > 0 ? 1000 / dtMs : 30;
    const angle = Math.atan2(this.fsin.filter(Math.sin(raw), freq), this.fcos.filter(Math.cos(raw), freq));
    return {
      gripNorm: { x: hilt[0] / f.SW, y: hilt[1] / f.SH },
      angle,
      conf,
      lead, // ms of extrapolation actually applied — for the debug overlay
      // the blade as drawn on the camera feed (led, so it matches the game blade)
      endsNorm: [{ x: hilt[0] / f.SW, y: hilt[1] / f.SH }, { x: tip[0] / f.SW, y: tip[1] / f.SH }],
    };
  }

  /** Clear per-frame tracking state. Calibration and the enrolled model survive. */
  reset() {
    this.fcos.reset();
    this.fsin.reset();
    this.prev = null;
    this.prevEnds = null;
    this.hilt = 0;
    this.speed = [0, 0];
    this.miss = 0;
    this.vel = [[0, 0], [0, 0]];
  }
}
