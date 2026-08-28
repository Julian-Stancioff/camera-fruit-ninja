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
import * as detector from "./detectBlade.js";

const SCAN_W = 192;          // scan resolution: enough structure, cheap enough for 30fps
const BUF_FRAMES = 20;       // ~0.7s of history at 30fps feeding enrolment
const MIN_FRAMES = 10;       // don't even try to enrol on less than this
const MOTION_TARGET = 3.2;   // accumulated inter-frame motion (mean abs delta) before we commit
const MOTION_STRIDE = 4;     // subsample when measuring motion — we need a magnitude, not detail
const SWAP_MARGIN = 0.6;     // how decisively the other end must be slower before the hilt flips
const STORE_KEY = "fn_katana";

const clamp01 = (v) => Math.min(1, Math.max(0, v));

/**
 * Match this frame's two endpoints to the previous frame's, so a hilt/tip decision
 * carries forward. The detector reports an unordered axis, so without this the two
 * ends swap identity at random and the blade flips end-over-end every few frames.
 * @returns {[number, number]} indices into `ends` for [prevEnd0, prevEnd1]
 */
export function pairEnds(ends, prevEnds) {
  const d = (a, b) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2;
  const straight = d(ends[0], prevEnds[0]) + d(ends[1], prevEnds[1]);
  const crossed = d(ends[1], prevEnds[0]) + d(ends[0], prevEnds[1]);
  return crossed < straight ? [1, 0] : [0, 1];
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
    this.fcos = new OneEuroFilter(30, 1.5, 0.2);
    this.fsin = new OneEuroFilter(30, 1.5, 0.2);
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
   * Called every frame while the enrolment screen is up. Buffers frames and only
   * commits once it has seen enough movement, then hands back a candidate to Approve
   * or Deny. Returns null while still gathering.
   */
  scan(video) {
    const f = this._grab(video);
    if (!f) return null;

    this.motion += this._motionSince(f.pixels);
    this.lastFrame = f.pixels;
    this.buf.push(f.pixels);
    if (this.buf.length > BUF_FRAMES) this.buf.shift();
    if (this.buf.length < MIN_FRAMES || this.motion < MOTION_TARGET) return null;

    const model = detector.enroll(this.buf, f.SW, f.SH);
    if (!model) {
      // Nothing object-like in that wave. Keep the frames but reset the motion budget
      // so the next second of waving gets a fresh attempt rather than retrying every
      // frame against the same failed buffer.
      this.motion = 0;
      this.failed = true;
      return null;
    }
    const hit = detector.detect(f.pixels, f.SW, f.SH, model, null);
    if (!hit) { this.motion = 0; this.failed = true; return null; }

    // Which end is the grip? The end that moves least — a swing pivots about the hand.
    // Measured across the wave we just recorded, which is exactly the motion that
    // makes the answer visible.
    const hilt = this._hiltFromWave(model, f.SW, f.SH, hit);
    const tip = 1 - hilt;
    return {
      model,
      ends: hit.ends,
      hilt,
      quality: hit.quality,
      angle: Math.atan2(hit.ends[tip][1] - hit.ends[hilt][1], hit.ends[tip][0] - hit.ends[hilt][0]),
      gripNorm: { x: hit.ends[hilt][0] / f.SW, y: hit.ends[hilt][1] / f.SH },
      tipNorm: { x: hit.ends[tip][0] / f.SW, y: hit.ends[tip][1] / f.SH },
    };
  }

  // Replay the buffered wave and total how far each endpoint travelled. The pivot end
  // is the grip. Falls back to end 0 if the replay is too sparse to call.
  _hiltFromWave(model, SW, SH, last) {
    let prev = null, prevEnds = null;
    const travel = [0, 0];
    for (const px of this.buf) {
      const r = detector.detect(px, SW, SH, model, prev);
      if (!r) continue;
      if (prevEnds) {
        const [i0, i1] = pairEnds(r.ends, prevEnds);
        travel[0] += Math.hypot(r.ends[i0][0] - prevEnds[0][0], r.ends[i0][1] - prevEnds[0][1]);
        travel[1] += Math.hypot(r.ends[i1][0] - prevEnds[1][0], r.ends[i1][1] - prevEnds[1][1]);
        prevEnds = [r.ends[i0], r.ends[i1]];
      } else prevEnds = r.ends;
      prev = r;
    }
    if (!prevEnds || travel[0] === travel[1]) return 0;
    // prevEnds is in the buffer's own ordering; carry that ordering onto `last`.
    const [j0] = pairEnds(last.ends, prevEnds);
    const hiltInBuf = travel[0] <= travel[1] ? 0 : 1;
    return hiltInBuf === 0 ? j0 : 1 - j0;
  }

  accept(candidate) {
    if (!candidate) return;
    this.model = candidate.model;
    try { localStorage.setItem(STORE_KEY, JSON.stringify(this.model)); } catch { /* no storage — just won't persist */ }
    this.reset();
    // Seed tracking with the pose you approved, so the very first frame already knows
    // which end is the grip instead of re-deriving it.
    this.prevEnds = candidate.ends;
    this.hilt = candidate.hilt;
  }

  load() {
    try {
      const m = JSON.parse(localStorage.getItem(STORE_KEY) || "null");
      if (!m) return false;
      this.model = m;
      return true;
    } catch { return false; }
  }

  get calibrated() { return !!this.model; }

  /**
   * Per game frame. Null means the object is not visible — main.js coasts for a few
   * frames and then shows the "bring your blade back" prompt. There is no hand to fall
   * back on in this mode, which is exactly what was asked for.
   * @returns {{gripNorm:{x,y}, angle, conf}|null}
   */
  update(video, dtMs) {
    if (!this.model) return null;
    const f = this._grab(video);
    if (!f) return null;
    const hit = detector.detect(f.pixels, f.SW, f.SH, this.model, this.prev);
    if (!hit) { this.prev = null; return null; }

    let ends = hit.ends;
    if (this.prevEnds) {
      const [i0, i1] = pairEnds(ends, this.prevEnds);
      ends = [ends[i0], ends[i1]];
      // Track how much each end moves. The grip is the quiet one; requiring a clear
      // margin before flipping stops the blade inverting on a frame of noise.
      for (let k = 0; k < 2; k++) {
        const d = Math.hypot(ends[k][0] - this.prevEnds[k][0], ends[k][1] - this.prevEnds[k][1]);
        this.speed[k] += (d - this.speed[k]) * 0.15;
      }
      const other = 1 - this.hilt;
      if (this.speed[other] < this.speed[this.hilt] * SWAP_MARGIN) this.hilt = other;
    }
    this.prevEnds = ends;
    this.prev = hit;

    const hilt = ends[this.hilt], tip = ends[1 - this.hilt];
    const raw = Math.atan2(tip[1] - hilt[1], tip[0] - hilt[0]);
    // Smooth wrap-safely: filtering the angle itself would spin the blade all the way
    // around every time it crosses ±π.
    const freq = dtMs > 0 ? 1000 / dtMs : 30;
    const angle = Math.atan2(this.fsin.filter(Math.sin(raw), freq), this.fcos.filter(Math.cos(raw), freq));
    return {
      gripNorm: { x: hilt[0] / f.SW, y: hilt[1] / f.SH },
      angle,
      conf: hit.quality,
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
  }
}
