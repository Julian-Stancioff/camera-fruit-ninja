// Katana mode: the blade is a real object held in the hand, not the fingertip.
// We march rays out of the palm across a downscaled camera frame and keep the one
// that runs furthest over a consistent colour — that ray IS the object. Only the
// ANGLE comes from vision; the on-screen blade LENGTH is a game-feel setting in
// main.js, so reach stays comparable to hand mode regardless of the real object.
import { OneEuroFilter } from "./OneEuroFilter.js";

const SCAN_W = 192;                 // scan resolution: enough detail, cheap enough for 30fps
const PALM = [0, 1, 5, 9, 13, 17];  // wrist + finger bases → palm centre (a stable grip point)
const TOL = 52;                     // per-channel colour distance to the enrolled appearance
const STEP_TOL = 34;                // looser per-channel step-to-step delta (continuity along a ray)
const MISS_RUN = 4;                 // consecutive failed samples that end a ray
const SIDE_MIN = 12;                // per-channel contrast a ray must show against what is beside it
const SIDE_REF = 40;                // contrast that scores full marks
const DENSITY = 0.6;                // min share of a ray's span that must actually match
const REF_SAMPLES = 6;              // samples right at the hand that define a ray's own reference
const REF_ADAPT = 0.12;             // how fast the reference follows the object's own shading
const MIN_HANDS = 2.5;              // a "blade" must run at least this many hand-widths
const TRACK_SPREAD = (50 * Math.PI) / 180; // per-frame search window either side of the last angle
const TRACK_BINS = 90;
const STORE_KEY = "fn_katana";

const clamp01 = (v) => Math.min(1, Math.max(0, v));
const wrapPi = (a) => Math.atan2(Math.sin(a), Math.cos(a));

// March one ray and report how far a consistent object runs along it.
// ref = enrolled colour, or null to let the first samples (the object right at the
// hand) define the reference — that is what makes the enrollment scan self-seeding.
function marchRay(pixels, SW, SH, grip, angle, rMin, maxLen, ref, side) {
  const dx = Math.cos(angle), dy = Math.sin(angle);
  const at = (r) => {
    const x = Math.round(grip.x + r * dx), y = Math.round(grip.y + r * dy);
    if (x < 0 || y < 0 || x >= SW || y >= SH) return -1;
    return (y * SW + x) * 4;
  };
  // A pixel `side` away, perpendicular to the ray — this is what the object is lying
  // ON TOP of. Without it a plain wall wins every scan: over flat background every ray
  // runs to max length with near-zero variance, and the sword loses to the wall.
  const off = (r, s) => {
    const x = Math.round(grip.x + r * dx - s * dy), y = Math.round(grip.y + r * dy + s * dx);
    if (x < 0 || y < 0 || x >= SW || y >= SH) return -1;
    return (y * SW + x) * 4;
  };

  let cr = 0, cg = 0, cb = 0;
  if (ref) {
    cr = ref.r; cg = ref.g; cb = ref.b;
  } else {
    let n = 0;
    for (let r = rMin; r < maxLen && n < REF_SAMPLES; r++) {
      const i = at(r);
      if (i < 0) break;
      cr += pixels[i]; cg += pixels[i + 1]; cb += pixels[i + 2];
      n++;
    }
    if (n < REF_SAMPLES) return null; // ray leaves the frame immediately — nothing to measure
    cr /= n; cg /= n; cb /= n;
  }

  const colTol = 3 * TOL * TOL, stepTol = 3 * STEP_TOL * STEP_TOL;
  let len = 0, miss = 0, n = 0;
  let sr = 0, sg = 0, sb = 0, qr = 0, qg = 0, qb = 0; // sums + squared sums of accepted samples
  let ur = 0, ug = 0, ub = 0, un = 0;                 // sums of the flanking (background) samples
  let pr = -1, pg = -1, pb = -1;                      // previous sample (pass or fail)
  for (let r = rMin; r <= maxLen; r++) {
    const i = at(r);
    if (i < 0) break; // ran off the frame: keep what we measured, the object may continue offscreen
    const R = pixels[i], G = pixels[i + 1], B = pixels[i + 2];
    const dr = R - cr, dg = G - cg, db = B - cb;
    const near = dr * dr + dg * dg + db * db < colTol;
    const er = R - pr, eg = G - pg, eb = B - pb;
    const cont = pr < 0 || er * er + eg * eg + eb * eb < stepTol;
    pr = R; pg = G; pb = B;
    if (near && cont) {
      // Drift the reference along the object. A blade is not one flat colour — it is
      // lit tip-to-hilt, and a fixed reference stops the march halfway up. Adapting
      // slowly still snaps off at a real edge, where the jump fails `cont` outright.
      cr += (R - cr) * REF_ADAPT; cg += (G - cg) * REF_ADAPT; cb += (B - cb) * REF_ADAPT;
      len = r; miss = 0; n++;
      sr += R; sg += G; sb += B;
      qr += R * R; qg += G * G; qb += B * B;
      for (const s of [-side, side]) {
        const j = off(r, s);
        if (j < 0) continue;
        ur += pixels[j]; ug += pixels[j + 1]; ub += pixels[j + 2]; un++;
      }
    } else if (++miss >= MISS_RUN) break;
  }
  // The 4-miss gap lets a real object survive a glint or a highlight, but it also
  // lets a lucky chain of matching background pixels hop its way to max length. A
  // real object matches nearly every step, so require the run to be dense.
  if (!n || n < DENSITY * (len - rMin + 1)) return null;

  const mr = sr / n, mg = sg / n, mb = sb / n;
  const variance = (qr / n - mr * mr) + (qg / n - mg * mg) + (qb / n - mb * mb);
  // Accepted samples are all within TOL of the reference, so 3*TOL² is the natural
  // ceiling — a ray over one flat-coloured object scores near 0 here.
  const nvar = clamp01(variance / (3 * TOL * TOL));

  // Per-channel RMS gap between the ray and its flanks. A real object stands out from
  // what's beside it; a stretch of wall does not, whichever is brighter.
  if (!un) return null;
  const contrast = Math.sqrt((((ur / un - mr) ** 2) + ((ug / un - mg) ** 2) + ((ub / un - mb) ** 2)) / 3);
  if (contrast < SIDE_MIN) return null;

  return {
    len, nvar, mean: { r: mr, g: mg, b: mb },
    score: len * (1 - nvar) * clamp01(contrast / SIDE_REF),
  };
}

/**
 * Pure core: find the elongated object held at `grip` in an ImageData-style buffer.
 * All angles/lengths are in small-canvas PIXEL space (y down, x unmirrored).
 * @returns {{angle, len, quality, ref:{r,g,b}}|null}
 */
export function scanRays(pixels, SW, SH, grip, handW, opts = {}) {
  const bins = opts.bins || 180;
  const spread = opts.spread ?? Math.PI;
  const full = opts.centerAngle === null || opts.centerAngle === undefined;
  const center = full ? 0 : opts.centerAngle;
  const rMin = 0.8 * handW;
  const maxLen = Math.min(9 * handW, Math.hypot(SW, SH));
  const side = Math.max(3, 0.5 * handW); // flank offset: just clear of a held object's width
  const binAngle = (i) => center - spread + (2 * spread * i) / bins;

  let best = null, bestI = 0;
  const scores = new Float64Array(bins);
  for (let i = 0; i < bins; i++) {
    const hit = marchRay(pixels, SW, SH, grip, binAngle(i), rMin, maxLen, opts.ref || null, side);
    if (!hit) continue;
    scores[i] = hit.score;
    if (!best || hit.score > best.score) { best = hit; bestI = i; }
  }
  if (!best || best.len < MIN_HANDS * handW) return null;

  // Sub-bin refine: parabolic fit through the winning score and its neighbours.
  // Skipped at the sweep edges — a winner pinned to the edge isn't a real peak anyway.
  let angle = binAngle(bestI);
  if (bestI > 0 && bestI < bins - 1) {
    const denom = scores[bestI - 1] - 2 * scores[bestI] + scores[bestI + 1];
    if (denom !== 0) {
      const d = Math.min(1, Math.max(-1, (0.5 * (scores[bestI - 1] - scores[bestI + 1])) / denom));
      angle = binAngle(bestI + d);
    }
  }
  return {
    angle: wrapPi(angle),
    len: best.len,
    quality: clamp01(best.len / (5 * handW)) * clamp01(1 - best.nvar),
    ref: best.mean,
  };
}

// Palm anchor + scale reference, all converted to small-canvas pixels.
function handFrame(lm, SW, SH) {
  let gx = 0, gy = 0;
  for (const i of PALM) { gx += lm[i].x; gy += lm[i].y; }
  return {
    grip: { x: (gx / PALM.length) * SW, y: (gy / PALM.length) * SH },
    // floored: a hand edge-on collapses to a few px and would make every threshold trivial
    handW: Math.max(6, Math.hypot((lm[5].x - lm[17].x) * SW, (lm[5].y - lm[17].y) * SH)),
    handAngle: Math.atan2((lm[9].y - lm[0].y) * SH, (lm[9].x - lm[0].x) * SW),
  };
}

export class ObjectBlade {
  constructor() {
    this.cal = null;   // { ref, lenHands, angleOffset } — survives in localStorage
    this.canvas = null;
    this.ctx = null;
    this.prevAngle = null;
    // cos/sin are unit-scale (not pixels), so beta has to be far bigger than the
    // pixel-space filters in main.js to get the same "fast swing → low lag" feel.
    this.fcos = new OneEuroFilter(30, 1.5, 0.2);
    this.fsin = new OneEuroFilter(30, 1.5, 0.2);
  }

  // Draw the current video frame into the ONE reused offscreen canvas (never
  // allocate per frame). `pixels` comes back null if the read throws so the caller
  // can still fall back to the hand angle. Created lazily: this module is imported
  // by a plain-node self-check, so it must not touch `document` at import time.
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
    let pixels = null;
    try {
      this.ctx.drawImage(video, 0, 0, SCAN_W, SH);
      pixels = this.ctx.getImageData(0, 0, SCAN_W, SH).data;
    } catch { /* tainted / undecoded frame — caller falls back to the hand angle */ }
    return { pixels, SW: SCAN_W, SH };
  }

  /** One-shot enrollment scan of the current frame → a candidate to Approve or Deny. */
  scan(video, landmarks) {
    if (!landmarks || landmarks.length < 21) return null;
    const f = this._grab(video);
    if (!f?.pixels) return null;
    const { grip, handW, handAngle } = handFrame(landmarks, f.SW, f.SH);
    // Full circle, no enrolled colour: the object right at the hand seeds itself.
    // ponytail: an object the same colour as the wall behind it is invisible to this
    // and won't enroll — the Approve/Deny step is the mitigation (move, re-scan). A
    // gradient/edge test instead of a colour one is the upgrade if people fight it.
    const hit = scanRays(f.pixels, f.SW, f.SH, grip, handW, { ref: null, centerAngle: null });
    if (!hit) return null;
    return {
      angle: hit.angle,
      lenHands: hit.len / handW,
      ref: hit.ref,
      quality: hit.quality,
      // The calibration that makes the fallback work: the object is rigid in the
      // hand, so its offset from the hand's own axis holds even when vision loses it.
      angleOffset: wrapPi(hit.angle - handAngle),
      gripNorm: { x: grip.x / f.SW, y: grip.y / f.SH },
      tipNorm: { x: (grip.x + Math.cos(hit.angle) * hit.len) / f.SW, y: (grip.y + Math.sin(hit.angle) * hit.len) / f.SH },
    };
  }

  accept(candidate) {
    if (!candidate) return;
    this.cal = { ref: candidate.ref, lenHands: candidate.lenHands, angleOffset: candidate.angleOffset };
    try { localStorage.setItem(STORE_KEY, JSON.stringify(this.cal)); } catch { /* no storage — calibration just won't persist */ }
    this.reset();
  }

  load() {
    try {
      const c = JSON.parse(localStorage.getItem(STORE_KEY) || "null");
      if (!c?.ref || !c.lenHands) return false;
      this.cal = c;
      return true;
    } catch { return false; }
  }

  get calibrated() { return !!this.cal; }

  /** Per game frame. @returns {{gripNorm:{x,y}, angle, conf}|null} */
  update(video, landmarks, dtMs) {
    if (!landmarks || landmarks.length < 21) return null;
    const f = this._grab(video);
    if (!f) return null;
    const { grip, handW, handAngle } = handFrame(landmarks, f.SW, f.SH);
    const fallback = handAngle + (this.cal?.angleOffset ?? 0);
    const hit = f.pixels && scanRays(f.pixels, f.SW, f.SH, grip, handW, {
      ref: this.cal?.ref || null,
      centerAngle: this.prevAngle ?? fallback,
      spread: TRACK_SPREAD,
      bins: TRACK_BINS,
    });

    // A mirror-finish katana can vanish into the background for whole frames, so the
    // hand's own orientation is the load-bearing safety net: never return null while
    // a hand is present, the blade just gets less confident.
    let raw = fallback, conf = 0.35;
    if (hit && hit.len > 0.5 * (this.cal?.lenHands ?? MIN_HANDS) * handW) {
      raw = hit.angle;
      conf = hit.quality;
    }

    // Smooth wrap-safely: filtering the angle directly would spin the blade all the
    // way around every time it crosses ±π.
    const freq = dtMs > 0 ? 1000 / dtMs : 30;
    const angle = Math.atan2(this.fsin.filter(Math.sin(raw), freq), this.fcos.filter(Math.cos(raw), freq));
    this.prevAngle = angle;
    return { gripNorm: { x: grip.x / f.SW, y: grip.y / f.SH }, angle, conf };
  }

  reset() {
    this.fcos.reset();
    this.fsin.reset();
    this.prevAngle = null;
  }
}
