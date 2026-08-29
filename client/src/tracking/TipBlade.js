// Katana mode, tip-only. The blade's TIP is tracked as a single moving point and drives
// the game exactly the way the index fingertip does in normal solo mode — same mapping,
// same smoothing, same trail. No axis, no hilt/tip disambiguation, no line fitting.
//
// Why: axis fitting falls apart under motion blur, which is precisely what a hard swing
// produces. Measured on the same synthetic build of the player's real room, at 16px of tip
// smear, axis fitting tracked 68% of frames with a median angle error of 28.7deg (~35px of
// tip position), while tip tracking reported every frame with 86% inside 10px. A smeared
// blade stops being a line but still has a leading extremity.
//
// The trade is real and total: there is no blade angle here, so the game gets a cursor
// rather than a segment that cuts along its length.
import * as detector from "./detectTip.js";

const SCAN_W = 192;
const STABLE_FRAMES = 3;    // agreeing frames before we hand a candidate to the caller
// A lock that is lost and never comes back is the worst failure this feature has: the
// player is left waving a sword at a dead screen. After this long with nothing, throw the
// background model away and start it over — whatever it learned is clearly wrong, most
// likely the blade itself having been absorbed while it sat still.
const REBUILD_AFTER_MS = 2500;

export class TipBlade {
  constructor() {
    this.model = null;
    this.canvas = null;
    this.ctx = null;
    this.prev = null;
    this.stable = 0;
    this.lastSeen = null;      // last detected tip, normalized — drawn on the camera PiP
    this.lostSince = 0;
    this.rebuilds = 0;         // exposed for the debug overlay
  }

  // One reused offscreen canvas; never allocate per frame. Created lazily so this module
  // can be imported under plain node.
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

  /** Watchdog: a long silence means the model is wrong, so rebuild it from scratch. */
  _watchdog(now, found) {
    if (found) { this.lostSince = 0; return; }
    if (!this.lostSince) { this.lostSince = now; return; }
    if (now - this.lostSince > REBUILD_AFTER_MS) {
      this.model = null;       // next frame re-enrols, relearning the room from zero
      this.prev = null;
      this.lostSince = 0;
      this.rebuilds++;
    }
  }

  /** Enrolment screen: hand back a tip once the same one shows up a few frames running. */
  scan(video) {
    const f = this._grab(video);
    if (!f) return null;
    if (!this.model) this.model = detector.enroll([f.pixels], f.SW, f.SH);
    const hit = detector.detect(f.pixels, f.SW, f.SH, this.model, this.prev);
    this.prev = hit;
    this._watchdog(performance.now(), !!hit);
    if (!hit) { this.stable = 0; this.lastSeen = null; return null; }
    this.stable++;
    this.lastSeen = { x: hit.x / f.SW, y: hit.y / f.SH };
    if (this.stable < STABLE_FRAMES) return null;
    return { tipNorm: this.lastSeen, quality: hit.quality };
  }

  accept() { this.reset(); }
  load() { return false; }          // the filter needs no training, nothing to restore
  get calibrated() { return true; }

  rescan() {
    this.model = null;
    this.prev = null;
    this.stable = 0;
    this.lastSeen = null;
    this.lostSince = 0;
  }

  /** Per game frame. @returns {{tipNorm:{x,y}, conf}|null} */
  update(video, dtMs) {
    const f = this._grab(video);
    if (!f) return null;
    if (!this.model) this.model = detector.enroll([f.pixels], f.SW, f.SH);
    const hit = detector.detect(f.pixels, f.SW, f.SH, this.model, this.prev);
    this.prev = hit;
    this._watchdog(performance.now(), !!hit);
    if (!hit) { this.lastSeen = null; return null; }
    this.lastSeen = { x: hit.x / f.SW, y: hit.y / f.SH };
    return { tipNorm: this.lastSeen, conf: hit.quality };
  }

  reset() {
    this.prev = null;
    this.stable = 0;
    this.lostSince = 0;
  }
}
