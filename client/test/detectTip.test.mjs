// detectTip acceptance test: node client/test/detectTip.test.mjs
//
// detectTip is a SPARE PART (see TIP_MODE.md) — this file is its only importer, and
// node-only tests are never bundled by Vite, so the detector stays out of the app.
//
// The scene is the same synthetic build of the USER'S REAL ROOM the axis detector is
// tested against (detectAuto.test.mjs): dim, extremely cluttered, lower half crushed
// nearly to black, fine clutter tuned so the raw valley filter lights ~37-44% of the
// frame (verified below with a minimal copy of that filter — the tip detector never
// runs it, but the scene claim must hold on its own). The blade is dark, 1-2px wide,
// 74px long, near-vertical from tip (84,25) to base (82,99). Everything is a seeded
// LCG — no Math.random, byte-identical every run.
import assert from "node:assert/strict";
import { enroll, detect } from "../src/tracking/detectTip.js";

const W = 192, H = 108;
const rad = (d) => (d * Math.PI) / 180;

const rng = (seed) => {
  let s = (seed >>> 0) || 1;
  return () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
};

// ------------------------------------------------------------------ the room
// Verbatim from detectAuto.test.mjs — the two detectors must face the same room.

const addL = (p, x, y, d) => {
  if (x < 0 || y < 0 || x >= W || y >= H) return;
  const i = (y * W + x) * 4;
  const v = Math.max(0, Math.min(255, p[i] + d));
  p[i] = p[i + 1] = p[i + 2] = v;
};
const put = (p, x, y, l) => {
  if (x < 0 || y < 0 || x >= W || y >= H) return;
  const i = (y * W + x) * 4;
  p[i] = p[i + 1] = p[i + 2] = l; p[i + 3] = 255;
};
const rect = (p, x0, y0, x1, y1, l) => {
  for (let y = y0 | 0; y <= y1; y++) for (let x = x0 | 0; x <= x1; x++) put(p, x, y, l);
};
function bar(p, cx, cy, angle, len, w, luma) {
  const dx = Math.cos(angle), dy = Math.sin(angle), h = len / 2, hw = w / 2;
  const r = Math.ceil(h + hw) + 1;
  for (let y = Math.max(0, (cy - r) | 0); y <= Math.min(H - 1, (cy + r) | 0); y++) {
    for (let x = Math.max(0, (cx - r) | 0); x <= Math.min(W - 1, (cx + r) | 0); x++) {
      const u = (x - cx) * dx + (y - cy) * dy, v = -(x - cx) * dy + (y - cy) * dx;
      if (Math.abs(u) <= h && Math.abs(v) <= hw) {
        const l = typeof luma === "function" ? luma(y) : luma;
        put(p, x, y, l);
      }
    }
  }
}
function texBar(p, cx, cy, angle, len, w, d) {
  const dx = Math.cos(angle), dy = Math.sin(angle), h = len / 2, hw = w / 2;
  const r = Math.ceil(h + hw) + 1;
  for (let y = Math.max(0, (cy - r) | 0); y <= Math.min(H - 1, (cy + r) | 0); y++) {
    for (let x = Math.max(0, (cx - r) | 0); x <= Math.min(W - 1, (cx + r) | 0); x++) {
      const u = (x - cx) * dx + (y - cy) * dy, v = -(x - cx) * dy + (y - cy) * dx;
      if (Math.abs(u) <= h && Math.abs(v) <= hw) addL(p, x, y, d);
    }
  }
}

const DARK_Y = 62;   // below this the frame is crushed nearly to black (measured)

function buildRoom() {
  const p = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) put(p, x, y, y < DARK_Y ? 95 + 0.04 * x - 0.1 * y : 22);
  rect(p, 0, 0, 24, DARK_Y - 1, 55);                       // wooden door (an EDGE, left)
  for (let y = 20; y <= 32; y++) for (let x = 26; x <= 38; x++) {  // lamp blob
    if ((x - 32) ** 2 / 36 + (y - 26) ** 2 / 36 <= 1) put(p, x, y, 185);
  }
  rect(p, 150, 8, 178, 24, 50); rect(p, 152, 10, 176, 22, 88);     // framed picture: 2px thin border
  bar(p, 55, 21, rad(4), 52, 9, 45);                       // skateboard 1 (long FAT bar)
  bar(p, 145, 33, rad(-7), 48, 8, 45);                     // skateboard 2
  const f = rng(9001);                                     // shirts: vertical dim stripes
  for (let x = 120; x <= 188;) {
    const w2 = 3 + Math.floor(f() * 6), l = 34 + f() * 18;
    rect(p, x, 40, Math.min(188, x + w2 - 1), DARK_Y - 1, l);
    x += w2;
  }
  rect(p, 10, 44, 140, DARK_Y - 1, 55);                    // unmade bed...
  for (const [y, x0, x1] of [[46, 14, 132], [51, 20, 138], [55, 12, 120], [59, 30, 136]]) {
    rect(p, x0, y, x1, y, 78);                             // ...with long THIN fold highlights
  }
  rect(p, 62, 55, 106, 92, 24);                            // mesh office chair...
  for (let x = 63; x <= 105; x += 3) rect(p, x, 56, x, 90, 42);   // ...dozens of thin slats
  rect(p, 10, 64, 38, 88, 48);                             // laundry basket, dim white
  bar(p, 160, 80, rad(30), 40, 3, 35);                     // scooter tube, marginal contrast
  const t = rng(31337);                                    // fine clutter: ~40% raw-lit
  for (let k = 0; k < 150; k++) {
    const cx = 3 + t() * 186, cy = 3 + t() * 102;
    const ang = t() * Math.PI, len = 4 + t() * 18, w = 1 + t() * 1.4;
    const d = (t() < 0.5 ? -1 : 1) * (14 + t() * 28);
    texBar(p, cx, cy, ang, len, w, d);
  }
  return p;
}
const ROOM = buildRoom();

// The blade: dark, 1-2px wide, good contrast against the dim wall, almost NONE
// against the crushed-black zone / the chair — as measured on the real katana.
const swordLuma = (y) => (y < DARK_Y ? 50 : 30);

// ONE reused frame buffer — same reason as the axis test: per-frame allocation makes
// GC, not detect(), the worst-case in the timing numbers.
const FRAME = new Uint8ClampedArray(W * H * 4);
function makeFrame(seed, k, pose, wSword) {
  const p = FRAME;
  p.set(ROOM);
  if (pose) bar(p, pose.cx, pose.cy, pose.angle, pose.len, wSword, swordLuma);
  const rnd = rng(seed + k * 7919);
  for (let i = 0; i < W * H; i++) {
    const gN = (rnd() * 2 - 1) * 5;       // sensor grain, fresh every frame
    const j = i * 4;
    p[j] += gN; p[j + 1] += gN; p[j + 2] += gN;
  }
  return p;
}

const poseFromEnds = (ax, ay, bx, by) => ({
  cx: (ax + bx) / 2, cy: (ay + by) / 2,
  angle: Math.atan2(by - ay, bx - ax), len: Math.hypot(bx - ax, by - ay),
});
// GROUND TRUTH from the live measurement: tip (84,25) -> base (82,99).
const TIP = [84, 25], BASE = [82, 99];
const STILL = poseFromEnds(BASE[0], BASE[1], TIP[0], TIP[1]);
const pivotPose = (px, py, angle, len) =>
  poseFromEnds(px, py, px + len * Math.cos(angle), py + len * Math.sin(angle));

// Truth for a TIP detector is a point: the pose's forward end, clipped to the frame
// (a detector cannot see the part of the blade that is off-camera — same honesty rule
// the axis bench uses for its visible-segment truth).
function truthTip(pose) {
  const tx = pose.cx + Math.cos(pose.angle) * pose.len / 2;
  const ty = pose.cy + Math.sin(pose.angle) * pose.len / 2;
  const fx = pose.cx, fy = pose.cy;   // center is in-frame in every scripted pose
  let t = 1;
  if (tx < 0) t = Math.min(t, (0 - fx) / (tx - fx));
  if (tx > W - 1) t = Math.min(t, (W - 1 - fx) / (tx - fx));
  if (ty < 0) t = Math.min(t, (0 - fy) / (ty - fy));
  if (ty > H - 1) t = Math.min(t, (H - 1 - fy) / (ty - fy));
  return [fx + (tx - fx) * t, fy + (ty - fy) * t];
}

// ------------------------------------------------------------------ harness

const med = (a) => (a.length ? [...a].sort((x, y) => x - y)[a.length >> 1] : NaN);
const mx = (a) => (a.length ? Math.max(...a) : NaN);
const p90 = (a) => (a.length ? [...a].sort((x, y) => x - y)[Math.floor(a.length * 0.9)] : NaN);
const p99 = (a) => (a.length ? [...a].sort((x, y) => x - y)[Math.floor(a.length * 0.99)] : NaN);
const n1 = (v) => (Number.isFinite(v) ? v.toFixed(1) : "-");
const n2 = (v) => (Number.isFinite(v) ? v.toFixed(2) : "-");
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

function runSeq(script, wSword, seed) {
  // script: array of {name, n, poseAt(f 0..1)|null}; returns [{r, ms, pose, phase}]
  const model = enroll([makeFrame(seed, 0, null, 0)], W, H);
  const out = [];
  let prev = null, k = 0;
  for (const ph of script) {
    for (let i = 0; i < ph.n; i++, k++) {
      const pose = ph.poseAt ? ph.poseAt(ph.n > 1 ? i / (ph.n - 1) : 0) : null;
      const p = makeFrame(seed, k, pose, wSword);
      const t0 = process.hrtime.bigint();
      const r = detect(p, W, H, model, prev);
      const ms = Number(process.hrtime.bigint() - t0) / 1e6;
      prev = r || null;                        // the caller nulls prev on a miss
      out.push({ r, ms, pose, phase: ph.name });
    }
  }
  out.model = model;
  return out;
}

// The player raises the blade into the pose from below — the real gesture.
const raiseInto = (pose, from = 40) => ({
  name: "raise", n: 8,
  poseAt: (f) => ({ ...pose, cy: pose.cy + from * (1 - f) }),
});

let failures = 0;
function check(name, cond, msg) {
  if (cond) return;
  failures++;
  console.log(`  FAIL: ${name}: ${msg}`);
}

// Minimal copy of detectAuto's raw valley/ridge filter, ONLY to verify the scene
// property the whole feature was tuned against (his live camera measured 37-44% of
// the frame raw-lit). The tip detector itself never runs this.
function valleyLitFrac(p) {
  const OFFS = [2, 4, 7], MIN_RESP = 12, M = 8;
  const lum = new Float32Array(W * H);
  for (let i = 0, j = 0; i < W * H; i++, j += 4) lum[i] = 0.299 * p[j] + 0.587 * p[j + 1] + 0.114 * p[j + 2];
  let lit = 0;
  for (let y = M; y < H - M; y++) {
    for (let x = M; x < W - M; x++) {
      const i = y * W + x, c = lum[i];
      let best = 0;
      for (let k = 0; k < 6; k++) {
        const a = (k * Math.PI) / 6 + Math.PI / 2;
        const ox = Math.cos(a), oy = Math.sin(a);
        for (const o of OFFS) {
          const q = Math.round(oy * o) * W + Math.round(ox * o);
          const u = lum[i + q], v = lum[i - q];
          const vd = (u < v ? u : v) - c, vb = c - (u > v ? u : v);
          const r = vd > vb ? vd : vb;
          if (r > best) best = r;
        }
      }
      if (best > MIN_RESP) lit++;
    }
  }
  // Denominator is the WHOLE frame with the margin counted unlit — exactly how
  // detectAuto.test.mjs reports its lit%, so the two numbers are comparable and this
  // one can be read against his live camera's 37-44% directly.
  return lit / (W * H);
}

// ------------------------------------------------------------------ 1. held still

console.log("== 1. HELD STILL (raise, then 300 frames, grain only) ==");
{
  const res = runSeq([raiseInto(STILL), { name: "still", n: 300, poseAt: () => STILL }], 2, 13);
  const still = res.slice(20);                 // settle: raise + lock handoff
  const hits = still.filter((s) => s.r);
  const errs = hits.map((s) => dist([s.r.x, s.r.y], truthTip(s.pose)));
  const moves = [];
  for (let i = 1; i < still.length; i++) {
    if (still[i].r && still[i - 1].r) moves.push(dist([still[i].r.x, still[i].r.y], [still[i - 1].r.x, still[i - 1].r.y]));
  }
  const rate = hits.length / still.length;
  console.log(`  found ${(100 * rate).toFixed(1)}%  tip err med ${n2(med(errs))}px worst ${n2(mx(errs))}px` +
    `  move med ${n2(med(moves))}px worst ${n2(mx(moves))}px`);
  check("still", rate >= 0.98, `found ${(100 * rate).toFixed(1)}% < 98%`);
  check("still", med(errs) <= 3, `median tip err ${n2(med(errs))}px > 3px`);
  check("still", med(moves) <= 0.3, `median move ${n2(med(moves))}px > 0.3px`);
  check("still", mx(moves) <= 3, `worst move ${n2(mx(moves))}px > 3px`);
}

// Honesty check, not an assertion: a sword already in frame and never moving from
// the very first frame is learned as furniture (same deliberate trade the axis
// detector makes). Report what actually happens.
{
  const res = runSeq([{ name: "still", n: 60, poseAt: () => STILL }], 2, 17);
  const early = res.slice(0, 10).filter((s) => s.r).length, late = res.slice(30).filter((s) => s.r).length;
  console.log(`  (info) never-moved-from-frame-0: hits frames 0-9: ${early}/10, frames 30-59: ${late}/30 — absorbed by design, recovered on first motion`);
}

// ------------------------------------------------------------------ 2. fast swing

console.log("== 2. FAST SWING (+-70deg about a low pivot, sharp bar, ~6deg/frame peak) ==");
{
  const PX = 90, PY = 65, LEN = 74, UP = rad(-90);
  const upPose = pivotPose(PX, PY, UP, LEN);
  const swing = (f) => pivotPose(PX, PY, UP + rad(70) * Math.sin(2 * Math.PI * f), LEN);
  const res = runSeq([raiseInto(upPose), { name: "pre", n: 20, poseAt: () => upPose },
    { name: "swing", n: 72, poseAt: swing }], 2, 31);
  const sw = res.filter((s) => s.phase === "swing");
  const hits = sw.filter((s) => s.r);
  const errs = hits.map((s) => dist([s.r.x, s.r.y], truthTip(s.pose)));
  const rate = hits.length / sw.length;
  const close = hits.filter((s, i) => errs[i] <= 10).length / sw.length;
  console.log(`  tracked ${(100 * rate).toFixed(1)}%  within 10px ${(100 * close).toFixed(1)}%` +
    `  tip err med ${n2(med(errs))}px p90 ${n2(p90(errs))}px worst ${n2(mx(errs))}px`);
  check("swing", rate >= 0.95, `tracked ${(100 * rate).toFixed(1)}% < 95%`);
  check("swing", med(errs) <= 4, `median tip err ${n2(med(errs))}px > 4px`);
  // The worst frames are the stroke reversals, where this room parks the tip in
  // contrast-dead clutter (door at 5 luma of contrast, picture border at 0) and the
  // report rides the visible-foreground boundary or the coast. Bound the damage.
  check("swing", mx(errs) <= 30, `worst tip err ${n2(mx(errs))}px > 30px`);
}

// ------------------------------------------------------------------ 3. no sword

console.log("== 3. NO SWORD, furniture only (300 frames) ==");
{
  const res = runSeq([{ name: "empty", n: 300, poseAt: null }], 0, 53);
  const warm = res.slice(0, 30).filter((s) => s.r).length;
  const late = res.slice(30).filter((s) => s.r).length;
  const lit = valleyLitFrac(makeFrame(53, 1, null, 0));
  const ms5 = res.slice(10).map((s) => s.ms);
  console.log(`  hits: warm-up (0-29) ${warm}/30, after ${late}/270` +
    `   raw valley-lit ${(100 * lit).toFixed(1)}% of frame (his room: 37-44%)` +
    `   detect med ${n2(med(ms5))}ms p99 ${n2(p99(ms5))}ms`);
  check("empty", late === 0, `${late} hallucinated frames after warm-up`);
  // the busy-room property itself, so this test cannot quietly go easy on itself
  check("empty", lit >= 0.35 && lit <= 0.48, `raw valley-lit ${(100 * lit).toFixed(1)}% outside 35-48%`);
}

// ------------------------------------------------------------------ 3b. sword leaves
// The trap a luminance background walks into that the valley detector does not: the
// shaft bg absorbs while the blade dwells becomes a GHOST TRENCH the moment the
// blade leaves, the lock slides onto it, and the freeze disc would protect the ghost
// forever (first build of this detector: 52/52 hallucinated frames here). The slow
// room memory (bgS recovery) is what kills it — this section keeps that honest.

console.log("== 3b. STILL -> LOWERED OUT OF FRAME -> RAISED AGAIN ==");
{
  const res = runSeq([raiseInto(STILL),
    { name: "still1", n: 60, poseAt: () => STILL },
    { name: "gone", n: 60, poseAt: null },
    raiseInto(STILL),
    { name: "still2", n: 60, poseAt: () => STILL }], 2, 97);
  // A dying lock may legally still speak for COAST_MAX (4) + MISS_MAX (12) frames
  // after its last real hit; past that window a report is a ghost the slow room
  // memory failed to kill. The window is the MECHANISM's bound, not a fitted one: a
  // 12-frame window flaked on 2 of 10 grain seeds (measured last-report index 3..12).
  const GHOST_WIN = 16;
  const gone = res.filter((s) => s.phase === "gone");
  let lastGhost = -1;
  gone.forEach((s, i) => { if (s.r) lastGhost = i; });
  const ghost = gone.slice(0, GHOST_WIN).filter((s) => s.r).length;
  const lateGhost = gone.slice(GHOST_WIN).filter((s) => s.r).length;
  const s2 = res.filter((s) => s.phase === "still2").slice(10);
  const rate2 = s2.filter((s) => s.r).length / s2.length;
  const errs2 = s2.filter((s) => s.r).map((s) => dist([s.r.x, s.r.y], truthTip(s.pose)));
  console.log(`  gone: reports in first ${GHOST_WIN} frames ${ghost}/${GHOST_WIN} (last at ${lastGhost}), after ${lateGhost}/${60 - GHOST_WIN}` +
    `   re-raised: found ${(100 * rate2).toFixed(1)}%  tip err med ${n2(med(errs2))}px`);
  check("gone", lateGhost === 0, `${lateGhost} ghost reports after the ${GHOST_WIN}-frame window`);
  check("gone", rate2 >= 0.98, `re-acquired only ${(100 * rate2).toFixed(1)}% < 98%`);
  check("gone", med(errs2) <= 3, `re-acquired tip err ${n2(med(errs2))}px > 3px`);
}

// ------------------------------------------------------------------ 4. motion blur
// The entire reason this mode exists. Same harness as the axis test's 3b: the blade
// is rendered at 7 sub-angles across the exposure and coverage-averaged, so it goes
// wide, faint and soft exactly as a real swing does. Peak tip smear = stated px;
// blur scales with instantaneous angular speed (zero at the reversals).

const COV = new Float32Array(W * H);
function blurFrame(seed, k, px, py, angMid, angSpan, len, wSword) {
  const p = FRAME;
  p.set(ROOM);
  COV.fill(0);
  const S = 7;
  for (let s = 0; s < S; s++) {
    const a = angMid + angSpan * (s / (S - 1) - 0.5);
    const dx = Math.cos(a), dy = Math.sin(a);
    const cx = px + (len / 2) * dx, cy = py + (len / 2) * dy;
    const h = len / 2, hw = wSword / 2, r = Math.ceil(h + hw) + 1;
    for (let y = Math.max(0, (cy - r) | 0); y <= Math.min(H - 1, (cy + r) | 0); y++) {
      for (let x = Math.max(0, (cx - r) | 0); x <= Math.min(W - 1, (cx + r) | 0); x++) {
        const u = (x - cx) * dx + (y - cy) * dy, v = -(x - cx) * dy + (y - cy) * dx;
        if (Math.abs(u) <= h && Math.abs(v) <= hw) COV[y * W + x] += 1 / S;
      }
    }
  }
  for (let i = 0; i < W * H; i++) {
    const c = COV[i];
    if (c > 0) {
      const j = i * 4, y = (i / W) | 0;
      const cc = c > 1 ? 1 : c;
      const l = p[j] * (1 - cc) + swordLuma(y) * cc;
      p[j] = p[j + 1] = p[j + 2] = l;
    }
  }
  const rnd = rng(seed + k * 7919);
  for (let i = 0; i < W * H; i++) {
    const gN = (rnd() * 2 - 1) * 5;
    const j = i * 4;
    p[j] += gN; p[j + 1] += gN; p[j + 2] += gN;
  }
  return p;
}

function runBlurSwing({ n, blurPx, seed }) {
  const PX = 90, PY = 65, LEN = 74, UP = rad(-90);
  const angAt = (f) => UP + rad(70) * Math.sin(2 * Math.PI * f);
  const upPose = pivotPose(PX, PY, UP, LEN);
  const model = enroll([makeFrame(seed, 0, null, 0)], W, H);
  let prev = null, k = 0;
  for (const ph of [raiseInto(upPose), { name: "pre", n: 20, poseAt: () => upPose }]) {
    for (let i = 0; i < ph.n; i++, k++) {
      prev = detect(makeFrame(seed, k, ph.poseAt(ph.n > 1 ? i / (ph.n - 1) : 0), 2), W, H, model, prev) || null;
    }
  }
  const out = [];
  for (let i = 0; i < n; i++, k++) {
    const f = i / (n - 1);
    const aM = angAt(f);
    const span = (blurPx / LEN) * Math.abs(Math.cos(2 * Math.PI * f));   // blur ∝ speed
    const p = blurFrame(seed, k, PX, PY, aM, span, LEN, 2);
    const t0 = process.hrtime.bigint();
    const r = detect(p, W, H, model, prev);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    prev = r || null;
    out.push({ r, ms, truth: truthTip(pivotPose(PX, PY, aM, LEN)) });
  }
  return out;
}

console.log("== 4. FAST SWING + MOTION BLUR (peak tip smear per 33ms exposure) ==");
console.log("  axis detector on this harness, for comparison: 8px 91.7% / 16px 68.1% / 24px 45.8% tracked");
const blurMs = [];
{
  // Physics, stated plainly: a 2px blade at 45 luma of contrast smeared across 16px
  // leaves ~6 luma of tip signal — barely above grain even for the faint window. The
  // OUTER part of the blade dims first (smear grows with radius), so under heavy
  // blur the honest best answer is the outermost pixel that still shows: the report
  // pulls inward along the blade, then snaps back out as the stroke slows. Tracked%
  // stays high because a point+coast always has something to say — the error
  // distribution is where blur actually lands, so both are printed and bounded.
  for (const B of [8, 16, 24]) {
    const res = runBlurSwing({ n: 72, blurPx: B, seed: 71 + B });
    for (const s of res) blurMs.push(s.ms);
    const hits = res.filter((s) => s.r);
    const errs = hits.map((s) => dist([s.r.x, s.r.y], s.truth));
    const rate = hits.length / res.length;
    const close = errs.filter((e) => e <= 10).length / res.length;
    let worstGap = 0, gap = 0;
    for (const s of res) { gap = s.r ? 0 : gap + 1; if (gap > worstGap) worstGap = gap; }
    console.log(`  blur ${String(B).padStart(2)}px  tracked ${(100 * rate).toFixed(1)}%  within 10px ${(100 * close).toFixed(1)}%` +
      `  tip err med ${n1(med(errs))}px p90 ${n1(p90(errs))}px worst ${n1(mx(errs))}px  worst miss gap ${worstGap}`);
    // tracked% alone is a soft metric for a POINT detector — a coast always has
    // something to say — so within-10px is asserted too, and the bounds below are the
    // worst of a sweep over 14 grain seeds AND 9 re-rolled rooms, not this seed's
    // number. Measured spread: 8px within10 94.4-100%, med 2.9-3.4px; 16px 76.4-94.4%,
    // med 4.4-6.1px; 24px 37.5-81.9%, med 6.2-15.5px. 24px is where the physics
    // genuinely runs out (a 2px blade at 45 luma smeared over 24px leaves ~4 luma of
    // tip, at the grain floor), and the spread there is the honest headline.
    if (B === 8) {
      check("blur8", rate >= 0.95, `tracked ${(100 * rate).toFixed(1)}% < 95%`);
      check("blur8", close >= 0.90, `within 10px ${(100 * close).toFixed(1)}% < 90%`);
      check("blur8", med(errs) <= 5, `median tip err ${n1(med(errs))}px > 5px`);
    }
    if (B === 16) {
      check("blur16", rate >= 0.90, `tracked ${(100 * rate).toFixed(1)}% < 90%`);
      check("blur16", close >= 0.70, `within 10px ${(100 * close).toFixed(1)}% < 70%`);
      check("blur16", med(errs) <= 8, `median tip err ${n1(med(errs))}px > 8px`);
    }
    if (B === 24) {
      check("blur24", rate >= 0.85, `tracked ${(100 * rate).toFixed(1)}% < 85%`);
      check("blur24", close >= 0.35, `within 10px ${(100 * close).toFixed(1)}% < 35%`);
      check("blur24", med(errs) <= 18, `median tip err ${n1(med(errs))}px > 18px`);
    }
  }
}

// ------------------------------------------------------------------ 5. budget

console.log("== 5. BUDGET (target: median < 3ms at 192x108) ==");
{
  const res = runSeq([raiseInto(STILL), { name: "still", n: 120, poseAt: () => STILL }], 2, 61);
  const ms = res.slice(10).map((s) => s.ms).concat(blurMs);   // still + all blur-swing frames
  console.log(`  detect() median ${n2(med(ms))}ms  p99 ${n2(p99(ms))}ms  worst ${n2(mx(ms))}ms`);
  check("budget", med(ms) < 3, `median ${n2(med(ms))}ms >= 3ms`);
  check("budget", p99(ms) < 6, `p99 ${n2(p99(ms))}ms >= 6ms`);
}

if (failures) { console.log(`\n${failures} FAILURE(S)`); process.exit(1); }
console.log("\nall checks passed");
