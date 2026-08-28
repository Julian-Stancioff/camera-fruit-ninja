// Self-check for the ray scanner: node client/src/tracking/ObjectBlade.test.mjs
// No framework. Scenes are built the way a camera actually sees them — a SMOOTH room
// behind the hand, and a blade that is lit unevenly along its length. Per-pixel white
// noise would be an easy, unrealistic negative.
import assert from "node:assert";
import { scanRays } from "./ObjectBlade.js";

const W = 192, H = 108;
const GRIP = { x: 50, y: 60 }, HANDW = 10, LEN = 70, ANGLE = -Math.PI / 6;
const OPTS = { ref: null, centerAngle: null };
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const degOff = (a) => (Math.abs(wrap(a - ANGLE)) * 180) / Math.PI;

let seed = 12345;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);

function scene({ bar }) {
  seed = 12345;
  const p = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 4, v = 60 + x * 0.35 + y * 0.5 + rnd() * 14; // lit wall
    p[i] = v; p[i + 1] = v * 0.55; p[i + 2] = v * 0.85; p[i + 3] = 255;
  }
  if (!bar) return p;
  const dx = Math.cos(ANGLE), dy = Math.sin(ANGLE);
  for (let r = 0; r <= LEN; r += 0.5) for (let t = -2.5; t <= 2.5; t += 0.5) {
    const x = Math.round(GRIP.x + r * dx - t * dy), y = Math.round(GRIP.y + r * dy + t * dx);
    if (x < 0 || y < 0 || x >= W || y >= H) continue;
    const i = (y * W + x) * 4, g = 200 + 35 * Math.sin(r / 9); // specular gradient up the blade
    p[i] = g; p[i + 1] = g * 0.97; p[i + 2] = g * 0.92; p[i + 3] = 255;
  }
  return p;
}

// 1. Enrolment: a lit blade over a lit wall is found, end to end.
const hit = scanRays(scene({ bar: true }), W, H, GRIP, HANDW, OPTS);
assert.ok(hit, "expected the blade to be found");
assert.ok(degOff(hit.angle) < 5, `angle off by ${degOff(hit.angle).toFixed(2)}°`);
assert.ok(hit.len > LEN * 0.75, `len ${hit.len} stopped short of ${LEN} — reference is not adapting`);
assert.ok(hit.len < LEN * 1.25, `len ${hit.len} overran ${LEN} — the ray walked onto the wall`);
console.log(`blade: ${degOff(hit.angle).toFixed(2)}° off, len ${hit.len} (want ${LEN}), quality ${hit.quality.toFixed(2)}`);

// 2. Empty hand against that same wall must report nothing, not a stretch of wall.
//    Over flat background every ray runs to max length, so only the perpendicular
//    contrast test can reject it — this is the assertion that guards that.
assert.strictEqual(scanRays(scene({ bar: false }), W, H, GRIP, HANDW, OPTS), null,
  "a blank wall was mistaken for a held object");
console.log("empty hand: null");

// 3. Tracking: enrolled colour + the narrow per-frame window re-finds the same blade.
const track = scanRays(scene({ bar: true }), W, H, GRIP, HANDW,
  { ref: { r: 212, g: 206, b: 195 }, centerAngle: ANGLE + 0.2, spread: (50 * Math.PI) / 180, bins: 90 });
assert.ok(track, "tracking pass lost the blade");
assert.ok(degOff(track.angle) < 5, `tracking off by ${degOff(track.angle).toFixed(2)}°`);
console.log(`tracked: ${degOff(track.angle).toFixed(2)}° off, len ${track.len}`);

// 4. Budget: this runs on every camera frame, so keep it far under a 33ms frame.
const f = scene({ bar: true }), t0 = process.hrtime.bigint();
for (let k = 0; k < 50; k++) scanRays(f, W, H, GRIP, HANDW, OPTS);
const ms = Number(process.hrtime.bigint() - t0) / 1e6 / 50;
assert.ok(ms < 5, `${ms.toFixed(2)}ms per scan is too slow`);
console.log(`budget: ${ms.toFixed(2)}ms per scan`);
console.log("ObjectBlade: OK");
