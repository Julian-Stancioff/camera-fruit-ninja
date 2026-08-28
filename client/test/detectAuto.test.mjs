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
  return p;
}
const ROOM = buildRoom();

// The blade: dark, 1-2px wide, good contrast against the dim wall, almost NONE against
// the crushed-black zone / the chair — exactly what was measured on the real katana.
const swordLuma = (y) => (y < DARK_Y ? 50 : 30);

function makeFrame(seed, k, pose, wSword) {
  const p = new Uint8ClampedArray(ROOM);
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
      out.push({ r, ms, pose, phase: ph.name });
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
  check("drift", mx(moves) <= 30, `worst frame-to-frame end move ${n2(mx(moves))}px > 30px`);
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
  check("swing", rate >= 0.85, `tracked ${(100 * rate).toFixed(1)}% < 85%`);
  check("swing", med(angs) <= 6, `median angle err ${n1(med(angs))}deg > 6deg`);
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
  // steady-state window: after a swing the held ends re-extend through the growth
  // cap (6px/frame) and the coast, ~1s of deliberate smoothing before they settle
  const s2 = res.filter((s) => s.phase === "still2").slice(30);
  const moves = [];
  for (let i = 1; i < s2.length; i++) if (s2[i].r && s2[i - 1].r) moves.push(endMove(s2[i - 1].r, s2[i].r));
  console.log(`  lock: still1 ${(100 * rateOf("still1", 12)).toFixed(1)}%  swing ${(100 * rateOf("swing")).toFixed(1)}%` +
    `  still2 ${(100 * rateOf("still2", 10)).toFixed(1)}%  worst miss gap ${worstGap} frames` +
    `  still2 end move med ${n2(med(moves))}px worst ${n2(mx(moves))}px`);
  check("phases", rateOf("still1", 12) >= 0.97, `still1 lock ${(100 * rateOf("still1", 12)).toFixed(1)}% < 97%`);
  check("phases", rateOf("swing") >= 0.6, `swing lock ${(100 * rateOf("swing")).toFixed(1)}% < 60%`);
  check("phases", rateOf("still2", 10) >= 0.95, `still2 lock ${(100 * rateOf("still2", 10)).toFixed(1)}% < 95%`);
  check("phases", worstGap <= 8, `lost the lock for ${worstGap} consecutive frames`);
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
  console.log(`  hits: warm-up (0-29) ${warm}/30, after ${late}/270` +
    `   lit%% of frame: raw ${(100 * lit / (W * H)).toFixed(1)}% -> evidence ${(100 * evLit / (W * H)).toFixed(2)}%`);
  check("empty", late === 0, `${late} hallucinated frames after warm-up`);
}

// ------------------------------------------------------------------ 6. budget

console.log("== 6. BUDGET ==");
{
  const res = runSeq([raiseInto(STILL), { name: "still", n: 120, poseAt: () => STILL }], 2, 61);
  const ms = res.slice(10).map((s) => s.ms);   // skip JIT warm-up frames
  console.log(`  detect() median ${n2(med(ms))}ms  worst ${n2(mx(ms))}ms  (budget 4ms median)`);
  check("budget", med(ms) < 4, `median ${n2(med(ms))}ms >= 4ms`);
}

if (failures) { console.log(`\n${failures} FAILURE(S)`); process.exit(1); }
console.log("\nall checks passed");
