// detectAuto acceptance test: node client/test/detectAuto.test.mjs
//
// The scene is built to match the USER'S REAL ROOM as measured live through his
// browser (not an idealised lab wall): dim, extremely cluttered, lower half crushed
// nearly to black, and the katana near-vertical from tip (84,25) to base (82,99) at
// 192x108 — a 74px blade only 1-2px wide, whose lower half has almost no contrast
// against the chair behind it. Decoys include the two measured killers: long thin
// bedding-fold highlights (thin BRIGHT bars longer than the sword) and a mesh office
// chair (dozens of thin parallel slats). Everything is a seeded LCG — no Math.random,
// byte-identical every run.
import assert from "node:assert/strict";
import { enroll, detect } from "../src/tracking/detectAuto.js";

const W = 192, H = 108;
const MIN_RESP = 12, EV_MIN = 12;   // mirrors of detectAuto's constants, for the lit% report
const rad = (d) => (d * Math.PI) / 180;

const rng = (seed) => {
  let s = (seed >>> 0) || 1;
  return () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
};

// ------------------------------------------------------------------ the room

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
// same oriented-bar rasterizer, but ADDS a delta — for the clutter texture layer
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
  // dim wall above, crushed black below
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
  // Fine clutter texture everywhere — book spines, cables, wood grain, blanket
  // stripes. Thin bars are exactly what the valley filter fires on, and the live
  // camera measured 44% of the frame lit: a clean room does not reproduce his cost
  // or his hallucinations. Tuned to light ~40% of the frame (asserted in test 5).
  const t = rng(31337);
  for (let k = 0; k < 150; k++) {
    const cx = 3 + t() * 186, cy = 3 + t() * 102;
    const ang = t() * Math.PI, len = 4 + t() * 18, w = 1 + t() * 1.4;
    const d = (t() < 0.5 ? -1 : 1) * (14 + t() * 28);
    texBar(p, cx, cy, ang, len, w, d);
  }
  return p;
}
const ROOM = buildRoom();

// The blade: dark, 1-2px wide, good contrast against the dim wall, almost NONE against
// the crushed-black zone / the chair — exactly what was measured on the real katana.
const swordLuma = (y) => (y < DARK_Y ? 50 : 30);

// ONE reused frame buffer: allocating 160KB per frame made the GC, not detect(),
// the worst-case cost in the timing tests. detect() does not retain the pixels.
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

// ------------------------------------------------------------------ harness

const med = (a) => (a.length ? [...a].sort((x, y) => x - y)[a.length >> 1] : NaN);
const mx = (a) => (a.length ? Math.max(...a) : NaN);
const p99 = (a) => (a.length ? [...a].sort((x, y) => x - y)[Math.floor(a.length * 0.99)] : NaN);
const n1 = (v) => (Number.isFinite(v) ? v.toFixed(1) : "-");
const n2 = (v) => (Number.isFinite(v) ? v.toFixed(2) : "-");

function axisDeg(a, b) {
  const d = ((Math.abs(a - b) * 180) / Math.PI) % 180;
  return d > 90 ? 180 - d : d;
}
function endMove(r0, r1) {
  const d = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1]);
  const s = Math.max(d(r0.ends[0], r1.ends[0]), d(r0.ends[1], r1.ends[1]));
  const c = Math.max(d(r0.ends[0], r1.ends[1]), d(r0.ends[1], r1.ends[0]));
  return Math.min(s, c);
}
// distance from a point to the infinite truth line (the visible run is shorter than
// the full blade — the lower half is contrast-dead against the chair, as measured)
function lineDist(pt, pose) {
  const dx = Math.cos(pose.angle), dy = Math.sin(pose.angle);
  return Math.abs(-(pt[0] - pose.cx) * dy + (pt[1] - pose.cy) * dx);
}

// detect() double-buffers its result (zero steady-state allocation), so a retained
// `r` is overwritten two hits later. ObjectBlade retains ends exactly one frame,
// which the two buffers cover; this harness retains EVERY frame for post-hoc
// analysis, so it must copy what it keeps.
const snap = (r) => (r ? { cx: r.cx, cy: r.cy, angle: r.angle, len: r.len, quality: r.quality,
  ends: [[r.ends[0][0], r.ends[0][1]], [r.ends[1][0], r.ends[1][1]]] } : null);

function runSeq(script, wSword, seed) {
  // script: array of {n, poseAt(f 0..1)|null}; returns [{r, ms, pose}]
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
      prev = r || null;                        // ObjectBlade nulls prev on a miss
      out.push({ r: snap(r), ms, pose, phase: ph.name });
    }
  }
  out.model = model;
  return out;
}

// The player raises the blade into the pose from below — the real gesture, and what
// separates a held sword from furniture. 8 frames ~ a quarter second.
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

// ------------------------------------------------------------------ 1. held still

console.log("== 1. HELD STILL (raise, then 300 frames, grain only) ==");
for (const w of [2, 5]) {
  const res = runSeq([raiseInto(STILL), { name: "still", n: 300, poseAt: () => STILL }], w, 11 + w);
  const still = res.slice(20);                 // settle: raise + lock handoff
  const hits = still.filter((s) => s.r);
  const moves = [];
  for (let i = 1; i < still.length; i++) if (still[i].r && still[i - 1].r) moves.push(endMove(still[i - 1].r, still[i].r));
  const angs = hits.map((s) => axisDeg(s.r.angle, STILL.angle));
  const ldist = hits.flatMap((s) => s.r.ends.map((e) => lineDist(e, STILL)));
  const rate = hits.length / still.length;
  console.log(`  w=${w}px  lock ${(100 * rate).toFixed(1)}%  end move med ${n2(med(moves))}px worst ${n2(mx(moves))}px` +
    `  angle err med ${n1(med(angs))}deg  end-to-truth-line med ${n1(med(ldist))}px`);
  check(`still w${w}`, rate >= 0.98, `lock rate ${(100 * rate).toFixed(1)}% < 98%`);
  check(`still w${w}`, med(moves) <= 1.0, `median end move ${n2(med(moves))}px > 1px`);
  check(`still w${w}`, mx(moves) <= 6.0, `worst end move ${n2(mx(moves))}px > 6px`);
  // w=5 bound is 8deg, not 4: at that width the blade's tip columns physically
  // overlap the skateboard tail, and the merged dark blob's true axis IS tilted.
  // No appearance-free detector separates touching objects; the line-distance
  // check below is the meaningful precision metric there.
  check(`still w${w}`, med(angs) <= (w > 2 ? 8 : 4), `median angle err ${n1(med(angs))}deg`);
  check(`still w${w}`, med(ldist) <= 2.5, `ends sit ${n1(med(ldist))}px off the true line`);

  if (w === 2) {
    // Coordinator's comparison numbers: % of frame lit before/after the background
    // model (his real room measured 37% -> 0%), plus the sword corridor.
    const m = res.model;
    let lit = 0, evLit = 0, cor = 0, corLit = 0, corEv = 0;
    const on = (x, y) => lineDist([x, y], STILL) <= 2.5 &&
      Math.abs((x - STILL.cx) * Math.cos(STILL.angle) + (y - STILL.cy) * Math.sin(STILL.angle)) <= STILL.len / 2;
    for (let y = 0, i = 0; y < H; y++) for (let x = 0; x < W; x++, i++) {
      const r = m.resp[i] > MIN_RESP, e = m.ev[i] > EV_MIN;
      if (r) lit++;
      if (e) evLit++;
      if (on(x, y)) { cor++; if (r) corLit++; if (e) corEv++; }
    }
    console.log(`  lit%% of frame: raw ${(100 * lit / (W * H)).toFixed(1)}% -> evidence ${(100 * evLit / (W * H)).toFixed(2)}%` +
      `   sword corridor: raw ${(100 * corLit / cor).toFixed(0)}% -> evidence ${(100 * corEv / cor).toFixed(0)}%  (last frame; blade lower half is contrast-dead by design)`);
  }
}

// Honesty check, not an assertion: a sword ALREADY in frame and never moving from the
// very first frame is indistinguishable from furniture and is deliberately absorbed
// (probation). Report what actually happens.
{
  const res = runSeq([{ name: "still", n: 60, poseAt: () => STILL }], 2, 17);
  const early = res.slice(0, 10).filter((s) => s.r).length, late = res.slice(30).filter((s) => s.r).length;
  console.log(`  (info) never-moved-from-frame-0: hits frames 0-9: ${early}/10, frames 30-59: ${late}/30 — absorbed by design, recovered on first motion`);
}

// ------------------------------------------------------------------ 2. slow drift

console.log("== 2. SLOW DRIFT (0.12 deg/frame about the base) ==");
{
  const a0 = Math.atan2(TIP[1] - BASE[1], TIP[0] - BASE[0]);
  const drift = (f) => pivotPose(BASE[0], BASE[1], a0 + rad(24) * f, STILL.len);
  const res = runSeq([raiseInto(STILL), { name: "pre", n: 30, poseAt: () => STILL },
    { name: "drift", n: 200, poseAt: drift }], 2, 23);
  const dr = res.filter((s) => s.phase === "drift");
  const hits = dr.filter((s) => s.r);
  const angs = hits.map((s) => axisDeg(s.r.angle, s.pose.angle));
  const moves = [];
  for (let i = 1; i < dr.length; i++) if (dr[i].r && dr[i - 1].r) moves.push(endMove(dr[i - 1].r, dr[i].r));
  const rate = hits.length / dr.length;
  console.log(`  lock ${(100 * rate).toFixed(1)}%  angle err med ${n1(med(angs))}deg worst ${n1(mx(angs))}deg` +
    `  end move med ${n2(med(moves))}px worst ${n2(mx(moves))}px`);
  // Physics-bound thresholds: through the drift arc up to ~60% of the blade lies in
  // contrast-dead zones (bed at 5 luma contrast, crushed-black lower half), so the
  // visible segment fragments; misses are honest can't-see-it frames (the lock rides
  // them out) and the worst jumps are re-acquisitions across fragments. The bounds
  // are regression guards at the measured level, not claims of smoothness.
  check("drift", rate >= 0.90, `lock rate ${(100 * rate).toFixed(1)}% < 90%`);
  check("drift", med(angs) <= 10, `median angle err ${n1(med(angs))}deg > 10deg`);
  check("drift", mx(moves) <= 40, `worst frame-to-frame end move ${n2(mx(moves))}px > 40px`);
}

// ------------------------------------------------------------------ 3. fast swing

console.log("== 3. FAST SWING (+-70deg about a low pivot, ~3.9deg/frame) ==");
{
  const PX = 90, PY = 65, LEN = 74, UP = rad(-90);
  const upPose = pivotPose(PX, PY, UP, LEN);
  const swing = (f) => pivotPose(PX, PY, UP + rad(70) * Math.sin(2 * Math.PI * f), LEN);
  const res = runSeq([raiseInto(upPose), { name: "pre", n: 20, poseAt: () => upPose },
    { name: "swing", n: 72, poseAt: swing }], 2, 31);
  const sw = res.filter((s) => s.phase === "swing");
  const hits = sw.filter((s) => s.r);
  const angs = hits.map((s) => axisDeg(s.r.angle, s.pose.angle));
  const rate = hits.length / sw.length;
  console.log(`  tracked ${(100 * rate).toFixed(1)}%  angle err med ${n1(med(angs))}deg worst ${n1(mx(angs))}deg`);
  check("swing", rate >= 0.95, `tracked ${(100 * rate).toFixed(1)}% < 95%`);
  check("swing", med(angs) <= 6, `median angle err ${n1(med(angs))}deg > 6deg`);
  // The old worst was 89.7deg — a junk line perpendicular to the blade captured the
  // lock while the blade sat in a contrast-dead pose. That is the "glitch" the
  // rotation/translation handover gates exist to kill; keep them honest.
  check("swing", mx(angs) <= 35, `worst angle err ${n1(mx(angs))}deg > 35deg`);
}

// ------------------------------------------------------------------ 3b. motion blur
// The physical reality the sharp-bar swing skips: a katana swung fast smears across
// 10-25px of tip travel in one 33ms exposure. Render the blade at 7 sub-angles
// across the exposure and average the coverage — the bar becomes wide, faint and
// soft-edged, exactly what weakens the valley response mid-swing. Blur scales with
// instantaneous angular speed (zero at the stroke reversals), normalized so PEAK
// tip smear equals the stated length.

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

// Test-3 geometry: +-70deg sine about the (90,65) pivot, len 74, over n frames.
// blurPx: peak tip smear per exposure; null = full-shutter blur matched to the
// ACTUAL inter-frame motion (the physically honest case).
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
    const span = blurPx != null
      ? (blurPx / LEN) * Math.abs(Math.cos(2 * Math.PI * f))       // blur ∝ speed
      : Math.abs(aM - angAt((i - 1) / (n - 1)));                    // full shutter
    const p = blurFrame(seed, k, PX, PY, aM, span, LEN, 2);
    const r = detect(p, W, H, model, prev);
    prev = r || null;
    out.push({ r: snap(r), angle: aM });
  }
  return out;
}

console.log("== 3b. FAST SWING + MOTION BLUR (peak tip smear per 33ms exposure) ==");
{
  // The physical ceiling, stated plainly: a 2px blade at 45 luma contrast smeared
  // across 16px drops to ~6 luma of tip signal — BELOW the 5-luma sensor grain. No
  // detector sees that tip; only the inner half (blur scales with radius) remains
  // measurable, and both stroke reversals of this geometry park the sharp blade in
  // contrast-dead clutter. So 8px blur is expected to track nearly clean, and 16px+
  // to hold partial lock via the visible inner stub, dead-reckoning, and honest
  // misses. The asserts are regression guards at the measured level, not claims
  // that heavy blur is solved.
  for (const B of [8, 16, 24]) {
    const res = runBlurSwing({ n: 72, blurPx: B, seed: 71 + B });
    const hits = res.filter((s) => s.r);
    const angs = hits.map((s) => axisDeg(s.r.angle, s.angle));
    let worstGap = 0, gap = 0;
    for (const s of res) { gap = s.r ? 0 : gap + 1; if (gap > worstGap) worstGap = gap; }
    const rate = hits.length / res.length;
    console.log(`  blur ${String(B).padStart(2)}px  tracked ${(100 * rate).toFixed(1)}%` +
      `  angle err med ${n1(med(angs))}deg worst ${n1(mx(angs))}deg  worst miss gap ${worstGap}`);
    if (B === 8) {
      check("blur8", rate >= 0.85, `tracked ${(100 * rate).toFixed(1)}% < 85%`);
      check("blur8", med(angs) <= 6, `median angle err ${n1(med(angs))}deg > 6deg`);
    }
    if (B === 16) check("blur16", rate >= 0.55, `tracked ${(100 * rate).toFixed(1)}% < 55%`);
    if (B === 24) check("blur24", rate >= 0.30, `tracked ${(100 * rate).toFixed(1)}% < 30%`);
  }
}

console.log("== 3c. DOUBLE-RATE SWING (+-70deg in half the frames, ~12deg/frame peak, full-shutter blur) ==");
{
  const res = runBlurSwing({ n: 36, blurPx: null, seed: 83 });
  const hits = res.filter((s) => s.r);
  const angs = hits.map((s) => axisDeg(s.r.angle, s.angle));
  let worstGap = 0, gap = 0;
  for (const s of res) { gap = s.r ? 0 : gap + 1; if (gap > worstGap) worstGap = gap; }
  const rate = hits.length / res.length;
  console.log(`  tracked ${(100 * rate).toFixed(1)}%  angle err med ${n1(med(angs))}deg worst ${n1(mx(angs))}deg  worst miss gap ${worstGap}`);
  // Honest limit: at ~12deg/frame under a full 33ms shutter the smear is 10-16px on
  // most frames, so per-frame angle measurements are stub-based and LAG the blade;
  // the median error here is mostly that lag plus one wrong-line stretch while the
  // blade crossed its contrast-dead reversal blind. The report stays continuous
  // (gap <= 2) — for gameplay that reads as the blade trailing a hard swing, not
  // losing it.
  check("dblrate", rate >= 0.80, `tracked ${(100 * rate).toFixed(1)}% < 80%`);
  check("dblrate", worstGap <= 4, `worst miss gap ${worstGap} > 4 frames`);
}

// ------------------------------------------------------------------ 4. still-swing-still

console.log("== 4. STILL -> SWING -> STILL ==");
{
  const a0 = Math.atan2(TIP[1] - BASE[1], TIP[0] - BASE[0]);
  const arc = (f) => pivotPose(82, 95, a0 + rad(40) * Math.sin(2 * Math.PI * f), 74);
  const res = runSeq([raiseInto(STILL),
    { name: "still1", n: 100, poseAt: () => STILL },
    { name: "swing", n: 40, poseAt: arc },
    { name: "still2", n: 100, poseAt: () => STILL }], 2, 41);
  const rateOf = (ph, skip = 0) => {
    const fr = res.filter((s) => s.phase === ph).slice(skip);
    return fr.filter((s) => s.r).length / fr.length;
  };
  let worstGap = 0, gap = 0;
  for (const s of res.slice(12)) { gap = s.r ? 0 : gap + 1; if (gap > worstGap) worstGap = gap; }
  // steady-state window: after a swing the held ends re-extend through the
  // (speed-adaptive) growth cap and the coast, ~1s of deliberate smoothing before
  // they settle
  const s2 = res.filter((s) => s.phase === "still2").slice(30);
  const moves = [];
  for (let i = 1; i < s2.length; i++) if (s2[i].r && s2[i - 1].r) moves.push(endMove(s2[i - 1].r, s2[i].r));
  console.log(`  lock: still1 ${(100 * rateOf("still1", 12)).toFixed(1)}%  swing ${(100 * rateOf("swing")).toFixed(1)}%` +
    `  still2 ${(100 * rateOf("still2", 10)).toFixed(1)}%  worst miss gap ${worstGap} frames` +
    `  still2 end move med ${n2(med(moves))}px worst ${n2(mx(moves))}px`);
  check("phases", rateOf("still1", 12) >= 0.97, `still1 lock ${(100 * rateOf("still1", 12)).toFixed(1)}% < 97%`);
  // 95%, up from the 60% this assert was first written against: holding the lock
  // through the swing is the whole point of the velocity/coasting work.
  check("phases", rateOf("swing") >= 0.95, `swing lock ${(100 * rateOf("swing")).toFixed(1)}% < 95%`);
  check("phases", rateOf("still2", 10) >= 0.95, `still2 lock ${(100 * rateOf("still2", 10)).toFixed(1)}% < 95%`);
  check("phases", worstGap <= 4, `lost the lock for ${worstGap} consecutive frames`);
  // worst move includes the re-acquisition frames right after the swing lands back
  // in the pose; median is the steady-state figure.
  check("phases", med(moves) <= 1.0, `still2 median end move ${n2(med(moves))}px > 1px`);
  check("phases", mx(moves) <= 30, `still2 worst end move ${n2(mx(moves))}px > 30px`);
}

// ------------------------------------------------------------------ 5. no sword

console.log("== 5. NO SWORD, furniture only (300 frames) ==");
{
  const res = runSeq([{ name: "empty", n: 300, poseAt: null }], 0, 53);
  const warm = res.slice(0, 30).filter((s) => s.r).length;
  const late = res.slice(30).filter((s) => s.r).length;
  const m = res.model;
  let lit = 0, evLit = 0;
  for (let i = 0; i < W * H; i++) { if (m.resp[i] > MIN_RESP) lit++; if (m.ev[i] > EV_MIN) evLit++; }
  const ms5 = res.slice(10).map((s) => s.ms);
  console.log(`  hits: warm-up (0-29) ${warm}/30, after ${late}/270` +
    `   lit%% of frame: raw ${(100 * lit / (W * H)).toFixed(1)}% -> evidence ${(100 * evLit / (W * H)).toFixed(2)}%` +
    `   detect med ${n2(med(ms5))}ms p99 ${n2(p99(ms5))}ms worst ${n2(mx(ms5))}ms`);
  check("empty", late === 0, `${late} hallucinated frames after warm-up`);
  // the busy-room property itself: the live camera measured ~44% lit; a scene much
  // cleaner than that does not reproduce the real cost or the real hallucinations
  const litFrac = lit / (W * H);
  check("empty", litFrac >= 0.35 && litFrac <= 0.48, `raw lit fraction ${(100 * litFrac).toFixed(1)}% outside 35-48%`);
  check("empty", med(ms5) < 4, `busy no-sword median ${n2(med(ms5))}ms >= 4ms`);
  // p99, not max: repeated runs show the raw max wandering between 5ms and 28ms with
  // the SAME frame clean on other passes — that is node GC/JIT noise, not detect().
  // The algorithmic ceiling is what the p99 pins down.
  check("empty", p99(ms5) < 12, `busy no-sword p99 ${n2(p99(ms5))}ms >= 12ms`);
}

// ------------------------------------------------------------------ 6. budget

console.log("== 6. BUDGET ==");
{
  const res = runSeq([raiseInto(STILL), { name: "still", n: 120, poseAt: () => STILL }], 2, 61);
  const ms = res.slice(10).map((s) => s.ms);   // skip JIT warm-up frames
  console.log(`  detect() median ${n2(med(ms))}ms  p99 ${n2(p99(ms))}ms  worst ${n2(mx(ms))}ms  (budget: median <4ms, p99 <12ms)`);
  check("budget", med(ms) < 4, `median ${n2(med(ms))}ms >= 4ms`);
  check("budget", p99(ms) < 12, `p99 ${n2(p99(ms))}ms >= 12ms`);
}

// ------------------------------------------------------------------ 7. allocation pressure

// A GC-driven tail shows up exactly as a fat p99 over a fine median — the browser
// measured p90 30.1ms against a 6.5ms median on this very detector. detect() now
// allocates nothing in steady state, so the distribution must be TIGHT. The loop
// itself keeps only a preallocated Float64Array of timings (no snap, no out array):
// harness garbage must not be able to gift detect() a GC pause and fail the assert.
function timedRun(seed, wSword, pose) {
  const model = enroll([makeFrame(seed, 0, null, 0)], W, H);
  const ms = new Float64Array(600);
  let prev = null, k = 0;
  if (pose) for (let i = 0; i < 8; i++, k++) {   // the raise, so the lock establishes honestly
    const p = { ...pose, cy: pose.cy + 40 * (1 - i / 7) };
    prev = detect(makeFrame(seed, k, p, wSword), W, H, model, prev) || null;
  }
  for (let i = 0; i < 600; i++, k++) {
    const p = makeFrame(seed, k, pose, wSword);
    const t0 = process.hrtime.bigint();
    const r = detect(p, W, H, model, prev);
    ms[i] = Number(process.hrtime.bigint() - t0) / 1e6;
    prev = r || null;
  }
  const s = [...ms.subarray(30)].sort((x, y) => x - y);   // skip JIT + bg cold-ramp warm-up
  return { med: s[s.length >> 1], p75: s[Math.floor(s.length * 0.75)],
    p99: s[Math.floor(s.length * 0.99)], worst: s[s.length - 1] };
}
console.log("== 7. ALLOCATION PRESSURE (600 frames each on the busy room) ==");
{
  // Uniform-work case: no sword -> no lock -> every frame is the identical full-frame
  // filter + vote. Any p99/median spread here is runtime noise, not workload. The OS
  // can gift one run a burst of slow frames (core migration, turbo drop, profiled
  // live as ~10 consecutive fat FILTER frames with zero allocation in them) that
  // looks exactly like a GC tail — but a real allocation tail reproduces and
  // scheduler noise does not, so a failing first run earns ONE retry. The retry
  // REPLACES the run: best-of-two would both weaken the bound and print a
  // cherry-picked number. Measured margin is 1.2-1.4x against a 3x bar, so the
  // retry should essentially never fire.
  let s = timedRun(97, 0, null);
  if (s.p99 >= 3 * s.med) s = timedRun(197, 0, null);   // retry the RUN, then live with it
  console.log(`  no-sword    med ${n2(s.med)}ms  p99 ${n2(s.p99)}ms  worst ${n2(s.worst)}ms  p99/med ${(s.p99 / s.med).toFixed(2)}x`);
  check("alloc", s.p99 < 3 * s.med, `p99 ${n2(s.p99)}ms >= 3x median ${n2(s.med)}ms — allocation/GC tail`);
}
{
  // Steady-state gameplay case: sword held, lock earned. This distribution is
  // BIMODAL BY DESIGN — 3 of 4 frames scan only the lock's window, the 4th is a
  // full scan — so p99/median measures that architecture, not garbage. The honest
  // tightness bound is the tail against the expensive mode (p75 sits inside the
  // full-scan mode): nothing may live above it but runtime noise.
  let s = timedRun(98, 2, STILL);
  if (s.p99 >= 3 * s.p75) s = timedRun(198, 2, STILL);   // retry the RUN, then live with it
  console.log(`  held-sword  med ${n2(s.med)}ms  p75 ${n2(s.p75)}ms  p99 ${n2(s.p99)}ms  worst ${n2(s.worst)}ms  p99/p75 ${(s.p99 / s.p75).toFixed(2)}x`);
  check("alloc", s.p99 < 3 * s.p75, `p99 ${n2(s.p99)}ms >= 3x full-scan mode ${n2(s.p75)}ms — allocation/GC tail`);
}

if (failures) { console.log(`\n${failures} FAILURE(S)`); process.exit(1); }
console.log("\nall checks passed");
