// Self-check for the endpoint bookkeeping: node client/src/tracking/ObjectBlade.test.mjs
// The detectors have their own tests and a benchmark; what is only testable here is the
// pure geometry — endpoint pairing, step clamping, and the latency-compensation pieces
// (delay estimation and rigid-body extrapolation). The video/canvas plumbing is not.
import assert from "node:assert";
import { pairEnds } from "./ObjectBlade.js";

// Same ordering: identity pairing.
assert.deepStrictEqual(pairEnds([[10, 10], [90, 50]], [[11, 12], [88, 51]]), [0, 1]);

// Detector reported the axis the other way round: pairing must cross to compensate.
assert.deepStrictEqual(pairEnds([[90, 50], [10, 10]], [[11, 12], [88, 51]]), [1, 0]);

// A hard case: the blade swung far enough that both ends moved a lot, but the crossed
// pairing is still the shorter total — this is where a naive nearest-point-per-end
// match (which can assign BOTH ends to the same previous point) would go wrong.
const now = [[52, 20], [48, 80]], before = [[47, 78], [53, 22]];
assert.deepStrictEqual(pairEnds(now, before), [1, 0]);

// Degenerate: identical points must still return a valid pairing, not throw.
assert.deepStrictEqual(pairEnds([[5, 5], [5, 5]], [[5, 5], [5, 5]]), [0, 1]);

console.log("ObjectBlade: pairEnds OK");
// clampStep bounds one frame's endpoint step, so a single bad detection cannot fling the
// blade across the screen while we are coasting on velocity.
import { clampStep, rigidExtrapolate, estimateDelayMs, updateMinSkew, leadScale } from "./ObjectBlade.js";
assert.strictEqual(clampStep(5), 5);
assert.strictEqual(clampStep(-5), -5);
assert.strictEqual(clampStep(900), 26);
assert.strictEqual(clampStep(-900), -26);
console.log("ObjectBlade: clampStep OK");

const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} !~ ${b}`);
const len = (e) => Math.hypot(e[1][0] - e[0][0], e[1][1] - e[0][1]);
const ang = (e) => Math.atan2(e[1][1] - e[0][1], e[1][0] - e[0][0]);

// Zero velocity must extrapolate to zero movement — this is the held-still guarantee.
{
  const ends = [[10, 20], [60, 45]];
  const out = rigidExtrapolate(ends, [[0, 0], [0, 0]], 3.5);
  near(out[0][0], 10); near(out[0][1], 20); near(out[1][0], 60); near(out[1][1], 45);
}

// A rotating blade keeps its LENGTH — the rigid-body invariant that per-endpoint
// advection breaks. Tangential endpoint velocities imply pure rotation about the centre.
{
  const ends = [[30, 50], [70, 50]]; // centre (50,50), half-vector (20,0)
  const w = 0.1;                     // rad/frame
  const vel = [[0, -w * 20], [0, w * 20]];
  const out = rigidExtrapolate(ends, vel, 5);
  near(len(out), len(ends));
  near(ang(out), ang(ends) + 0.5);  // rotated by w * lead
  near((out[0][0] + out[1][0]) / 2, 50); // centre did not translate
  near((out[0][1] + out[1][1]) / 2, 50);
}

// Pure translation carries both ends equally and keeps length.
{
  const ends = [[30, 50], [70, 50]];
  const out = rigidExtrapolate(ends, [[4, -2], [4, -2]], 2);
  near(out[0][0], 38); near(out[0][1], 46); near(out[1][0], 78); near(out[1][1], 46);
  near(len(out), len(ends));
}

// AXIAL noise — the ends jittering along the blade axis — must produce NO rotation and
// no movement at all. This is the exact shape of the runaway-rotation bug.
{
  const ends = [[30, 50], [70, 50]];
  const out = rigidExtrapolate(ends, [[-2, 0], [2, 0]], 4);
  near(out[0][0], 30); near(out[0][1], 50); near(out[1][0], 70); near(out[1][1], 50);
}

// The two cases above are each ONE hand-picked velocity field, and length preservation
// is trivially true for a pure rotation. Real endpoint velocities are rotation AND
// translation AND axial noise at once, so assert the invariants over arbitrary fields:
//   1. length is preserved exactly, whatever the velocities;
//   2. superimposing axial noise changes the result by NOTHING — that is the property
//      that makes runaway rotation impossible, not the single axial sample above.
{
  let s = 12345;
  const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 2 - 1;
  for (let i = 0; i < 500; i++) {
    const ends = [[rnd() * 90, rnd() * 90], [rnd() * 90, rnd() * 90]];
    const L = len(ends);
    if (L < 1) continue;                       // degenerate blades have their own case
    const vel = [[rnd() * 12, rnd() * 12], [rnd() * 12, rnd() * 12]];
    const lead = rnd() * 4;
    const out = rigidExtrapolate(ends, vel, lead);
    near(len(out), L, 1e-9 * Math.max(1, L));
    // add a purely axial disturbance: equal and opposite along the blade's own axis
    const ux = (ends[1][0] - ends[0][0]) / L, uy = (ends[1][1] - ends[0][1]) / L;
    const a = rnd() * 8;
    const noisy = [[vel[0][0] - a * ux, vel[0][1] - a * uy], [vel[1][0] + a * ux, vel[1][1] + a * uy]];
    const out2 = rigidExtrapolate(ends, noisy, lead);
    for (let e = 0; e < 2; e++) for (let c = 0; c < 2; c++) near(out2[e][c], out[e][c], 1e-8 * Math.max(1, L));
  }
}

// Length and axial-invariance hold for ANY rotation rate, so neither pins ω. Feed an
// exactly rigid velocity field (known ω about the centre, plus a known translation) and
// require the analytically transformed blade back. Crucially this sweeps the blade
// ANGLE: every hand-picked case above is horizontal, where hx² and |h|² coincide and a
// whole family of ω bugs is invisible — and the real katana is near-vertical, tip
// (84,25) to base (82,99), which is precisely where such a bug would be worst.
for (let deg = 0; deg < 180; deg += 15) {
  const a = (deg * Math.PI) / 180, hl = 37;
  const cx = 96, cy = 54;
  const hx = hl * Math.cos(a), hy = hl * Math.sin(a);
  const ends = [[cx - hx, cy - hy], [cx + hx, cy + hy]];
  const w = 0.07, tx = 1.3, ty = -0.8, lead = 2.5;   // rad/frame, px/frame
  // rigid field: v = translation + ω × r, with r measured from the centre
  const vel = [[tx - w * -hy, ty + w * -hx], [tx - w * hy, ty + w * hx]];
  const out = rigidExtrapolate(ends, vel, lead);
  const rot = w * lead, c = Math.cos(rot), s = Math.sin(rot);
  const rx = hx * c - hy * s, ry = hx * s + hy * c;
  const ecx = cx + tx * lead, ecy = cy + ty * lead;
  near(out[0][0], ecx - rx, 1e-8); near(out[0][1], ecy - ry, 1e-8);
  near(out[1][0], ecx + rx, 1e-8); near(out[1][1], ecy + ry, 1e-8);
}

// An absurd angular rate is capped, not applied — noise cannot spin the blade.
{
  const ends = [[30, 50], [70, 50]];
  const vel = [[0, -20], [0, 20]]; // w = 1 rad/frame
  const out = rigidExtrapolate(ends, vel, 4); // uncapped this would be 4 rad
  assert.ok(Math.abs(ang(out) - ang(ends)) <= 0.9 + 1e-9);
  near(len(out), len(ends));
}

// Degenerate zero-length blade must not divide by zero.
{
  const out = rigidExtrapolate([[5, 5], [5, 5]], [[1, 0], [0, 1]], 2);
  assert.ok(out.every((e) => e.every(Number.isFinite)));
}
console.log("ObjectBlade: rigidExtrapolate OK");

// Delay estimator: frame age (skew above its floor) plus one detect interval, clamped
// to 0..120 so a bad reading cannot fling the blade.
assert.strictEqual(estimateDelayMs(1050, 1000, 33), 83);
assert.strictEqual(estimateDelayMs(5000, 1000, 33), 120);
assert.strictEqual(estimateDelayMs(990, 1000, 5), 0); // clock jitter below floor → 0, not negative

// Min-skew floor: seeds on first sample, snaps down to a fresher delivery, leaks up
// slowly, and re-seeds on a clock discontinuity (stream restart).
assert.strictEqual(updateMinSkew(Infinity, 1000), 1000);
assert.strictEqual(updateMinSkew(1000, 900), 900);
assert.strictEqual(updateMinSkew(1000, 1400), 1000.5);
assert.strictEqual(updateMinSkew(1000, 2000), 2000);
console.log("ObjectBlade: estimateDelayMs/updateMinSkew OK");

// Lead scaling: zero at held-still speeds (0.06px measured), full in a real swing,
// scaled down by confidence while coasting.
assert.strictEqual(leadScale(0.06, 1), 0);
assert.strictEqual(leadScale(0.75, 1), 0);
assert.strictEqual(leadScale(8, 1), 1);
assert.strictEqual(leadScale(26, 1), 1);
near(leadScale(4.375, 1), 0.5);
near(leadScale(8, 0.25), 0.25);
assert.strictEqual(leadScale(8, 0), 0);
console.log("ObjectBlade: leadScale OK");

// The pure functions above can all be right while _emit still wires them up wrong, and
// _emit is the only place the lead actually reaches the game. It touches no DOM, so
// drive it directly. Both directions matter: a leadScale stuck at 0 would pass the
// held-still case alone, and a lead applied unconditionally would pass the swing case
// alone. `f` only needs the two scan dimensions _emit divides by.
import { ObjectBlade } from "./ObjectBlade.js";
const F = { SW: 192, SH: 108 };

// Held still at the measured 0.06px/frame jitter, with a FAT delay standing by: the
// emitted pose must still be the measured one.
{
  const b = new ObjectBlade();
  b.delayMs = 80;
  b.vel = [[0.04, 0.03], [-0.05, 0.02]];
  const out = b._emit([[82, 99], [84, 25]], F, 33, 1);
  assert.strictEqual(out.lead, 0, `held still must apply zero lead, got ${out.lead}`);
  near(out.endsNorm[0].x * F.SW, 82); near(out.endsNorm[0].y * F.SH, 99);
  near(out.endsNorm[1].x * F.SW, 84); near(out.endsNorm[1].y * F.SH, 25);
}

// Mid-swing at 6px/frame the lead must actually fire and carry the pose forward, along
// the direction of travel and by the distance the measured delay implies.
{
  const b = new ObjectBlade();
  b.delayMs = 80;
  b.vel = [[6, 0], [6, 0]];
  const out = b._emit([[82, 99], [84, 25]], F, 33, 1);
  assert.ok(out.lead > 20, `a swing must apply a real lead, got ${out.lead}`);
  assert.ok(out.lead <= 120, `lead must stay clamped, got ${out.lead}`);
  const dx = out.endsNorm[0].x * F.SW - 82;
  near(dx, 6 * (out.lead / b.tickEma), 1e-6);   // pure translation: no rotation, no drift
  near(out.endsNorm[1].y * F.SH, 25);           // motion is purely horizontal here
}
console.log("ObjectBlade: _emit lead wiring OK");

