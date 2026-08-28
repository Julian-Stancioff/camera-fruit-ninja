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
      // the blade as actually seen, for drawing on the camera feed
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
