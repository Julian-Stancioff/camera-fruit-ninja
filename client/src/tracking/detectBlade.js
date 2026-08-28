// Which detector to use is decided ONCE, during the enrolment wave, and then only that
// one runs per frame. The two detectors fail in opposite directions — measured on the
// synthetic benchmark (client/test/bench.mjs):
//
//   blob   0.0deg when it fires, but blind on every mirror-steel scene (100% miss)
//   ridge  ~3.5deg across steel, motion blur and occlusion, never blind
//
// So the object decides: a matte stick or a coloured bottle gets blob's precision, a
// polished katana gets ridge's robustness. Choosing per-enrolment rather than per-frame
// matters for the frame budget — blob costs up to ~10ms on the frames where it is
// failing to find anything, which is exactly when a per-frame fallback would run it.
import * as blob from "./detectBlob.js";
import * as ridge from "./detectRidge.js";

export const NAME = "blade";

const BACKENDS = { blob, ridge };
const clamp01 = (v) => Math.min(1, Math.max(0, v));

// An axis has no head or tail, so 179deg apart is really 1deg apart.
function axisDelta(a, b) {
  const d = ((Math.abs(a - b) * 180) / Math.PI) % 180;
  return d > 90 ? 180 - d : d;
}

const median = (a) => (a.length ? [...a].sort((x, y) => x - y)[a.length >> 1] : NaN);

// Replay a detector over the wave it was enrolled on. A detector that will hold during
// play finds the object in most frames, turns SMOOTHLY as the object turns, and reports
// a stable length. One that is hopping between background lines scores badly on the
// last two even when it returns something every frame — which is the failure mode that
// matters, because it looks like success from a hit-rate alone.
function scoreOnWave(mod, model, frames, SW, SH) {
  let prev = null, hits = 0;
  const deltas = [], lens = [];
  let lastAngle = null;
  for (const px of frames) {
    let r = null;
    try { r = mod.detect(px, SW, SH, model, prev); } catch { r = null; }
    if (!r || !Number.isFinite(r.angle) || !Number.isFinite(r.len)) { prev = null; lastAngle = null; continue; }
    hits++;
    lens.push(r.len);
    if (lastAngle !== null) deltas.push(axisDelta(r.angle, lastAngle));
    lastAngle = r.angle;
    prev = r;
  }
  if (!hits || !lens.length) return null;

  const hitRate = hits / frames.length;
  // The object really is rotating during the wave, so some per-frame delta is correct.
  // 25deg between frames is the point where it stops looking like a turn and starts
  // looking like a jump to a different line entirely.
  const steady = 1 - clamp01(median(deltas) / 25);
  const mean = lens.reduce((s, v) => s + v, 0) / lens.length;
  const spread = Math.sqrt(lens.reduce((s, v) => s + (v - mean) ** 2, 0) / lens.length) / (mean || 1);
  const consistent = 1 - clamp01(spread);
  return { score: hitRate * steady * consistent, hitRate, len: mean };
}

/** @returns {{which, model, score}|null} — JSON-serializable, it is persisted. */
export function enroll(frames, SW, SH) {
  const ranked = [];
  for (const [id, mod] of Object.entries(BACKENDS)) {
    let m = null;
    try { m = mod.enroll(frames, SW, SH); } catch { m = null; }
    if (!m) continue;
    const s = scoreOnWave(mod, m, frames, SW, SH);
    if (s && s.score > 0) ranked.push({ which: id, model: m, ...s });
  }
  if (!ranked.length) return null;
  ranked.sort((a, b) => b.score - a.score);
  const best = ranked[0];
  return { which: best.which, model: best.model, score: best.score };
}

export function detect(pixels, SW, SH, model, prev) {
  const mod = BACKENDS[model?.which];
  if (!mod) return null;
  return mod.detect(pixels, SW, SH, model.model, prev);
}
