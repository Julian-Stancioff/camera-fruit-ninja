// Self-check for the structure detector: node client/test/detectRidge.test.mjs
// One room: a bookshelf of static decoy lines longer, straighter and higher contrast than
// the object, and a mirror blade whose FILL sits 2 RGB units off whatever is behind it, so
// only a hairline rim betrays it. Can it find a bar that has no colour, ignore lines that
// never move, and say null when the sword is gone and only the decoys are left?
import assert from "node:assert";
import { NAME, enroll, detect } from "../src/tracking/detectRidge.js";

const W = 192, H = 108, CX = 96, CY = 78, LEN = 70, HW = 2;
let seed = 7;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const off = (a, b) => {
  const t = (((a - b) % Math.PI) + Math.PI) % Math.PI;
  return (Math.abs(t > Math.PI / 2 ? t - Math.PI : t) * 180) / Math.PI;
};

// Lit wall, sensor noise, and shelf furniture drawn from a FIXED seed: the decoys are
// byte-identical every frame, so only the noise and the blade ever move.
const paint = (p, q, c) => { p[q * 4] = c[0]; p[q * 4 + 1] = c[1]; p[q * 4 + 2] = c[2]; };

function room(k) {
  seed = 7 + k * 7919;
  const p = new Uint8ClampedArray(W * H * 4);
  for (let i = 0, y = 0; y < H; y++) for (let x = 0; x < W; x++, i += 4) {
    const v = 108 + x * 0.05 + y * 0.06 + rnd() * 3;
    p[i] = v; p[i + 1] = v * 0.98; p[i + 2] = v * 0.95; p[i + 3] = 255;
  }
  let s = 1;
  const fix = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let x = 14; x < W - 20; x += 19 + ((fix() * 7) | 0)) {     // book spines
    const w = 4 + ((fix() * 5) | 0), g = 40 + fix() * 170;
    for (let y = 8; y <= 34; y++) for (let d = 0; d < w; d++) paint(p, y * W + x + d, [g, g * 0.9, g * 0.8]);
  }
  for (let y = 38; y <= 39; y++) for (let x = 0; x < W; x++) paint(p, y * W + x, [50, 44, 36]); // board
  return p;
}

// A mirror bar: body +2 RGB on whatever it covers, a dark rim, no colour of its own.
function blade(p, angle, cx = CX, cy = CY) {
  const bg = p.slice(), dx = Math.cos(angle), dy = Math.sin(angle);
  for (let r = -LEN / 2; r <= LEN / 2; r += 0.4) for (let t = -HW - 1.2; t <= HW + 1.2; t += 0.25) {
    const x = Math.round(cx + r * dx - t * dy), y = Math.round(cy + r * dy + t * dx);
    if (x < 0 || y < 0 || x >= W || y >= H) continue;
    const i = (y * W + x) * 4, d = Math.abs(t) <= HW ? 2 : -32;
    p[i] = bg[i] + d; p[i + 1] = bg[i + 1] + d; p[i + 2] = bg[i + 2] + d;
  }
  return p;
}

assert.strictEqual(NAME, "ridge");

// 1. Enrol on the object being waved: motion, not brightness, has to pick it out. The wave
//    sweeps clear of where the tracking happens, as a real one does — an object that
//    lingers in one pose is an object the room model learns as furniture.
const wave = (k) => blade(room(k), (-40 + k * 6) * Math.PI / 180, 56 + k * 8, 66);
const model = enroll([...Array(10)].map((_, k) => wave(k)), W, H);
assert.ok(model, "enroll found nothing");
assert.ok(Math.abs(model.len - LEN) < 0.35 * LEN, `enrolled len ${model.len.toFixed(1)} vs ${LEN}`);
// The room model is a per-pixel buffer rebuilt lazily, never persisted with the model.
const cold = JSON.parse(JSON.stringify(model));
assert.ok(!("bg" in cold), "background must not be serialised");
console.log(`model: len ${model.len.toFixed(1)} (true ${LEN}) halfW ${model.halfW} edgeMag ${model.edgeMag.toFixed(0)}`);

// 2. The point of the detector: recover a bar whose fill matches its background, in a
//    frame where every decoy line is straighter and higher contrast than it is.
let prev = null, worst = 0;
for (let k = 0; k < 6; k++) {
  const a = -30 * Math.PI / 180 + k * 0.06;
  const hit = detect(blade(room(100 + k), a), W, H, model, prev);
  assert.ok(hit && hit.ends.length === 2 && Number.isFinite(hit.quality), `frame ${k}: lost the blade`);
  worst = Math.max(worst, off(hit.angle, a));
  assert.ok(worst < 10, `frame ${k}: locked onto the shelf, ${worst.toFixed(1)}deg off`);
  assert.ok(Math.hypot(hit.cx - CX, hit.cy - CY) < 10, `frame ${k}: centre off`);
  prev = hit;
}
console.log(`tracked 6 frames through the clutter, worst ${worst.toFixed(1)}deg`);

// 3. Object gone, decoys left. A latched shelf spine is a swing the player never made.
for (let k = 0; k < 4; k++) assert.strictEqual(detect(room(200 + k), W, H, model, prev), null, "hallucinated a sword");
console.log("object gone, decoys left: null");

// 4. A model straight out of localStorage has no room model yet. Its first frame is
//    deliberately ungated — nothing is known about the room — but it has to learn that
//    room live and let go of whatever it latched within a few frames.
const cold4 = [...Array(4)].map((_, k) => detect(room(300 + k), W, H, cold, null));
assert.strictEqual(cold4[3], null, "cold model never let go of the shelf");
console.log(`cold model warm-up: ${cold4.map((r) => (r ? "latched" : "null")).join(" ")}`);

// 5. Budget: this runs inside a 33ms camera frame next to Three.js.
const f = blade(room(9), -0.4);
const t0 = process.hrtime.bigint();
for (let k = 0; k < 60; k++) detect(f, W, H, model, prev);
const ms = Number(process.hrtime.bigint() - t0) / 1e6 / 60;
assert.ok(ms < 4, `${ms.toFixed(2)}ms per detect exceeds the 4ms budget`);
console.log(`budget: ${ms.toFixed(2)}ms per detect\ndetectRidge: OK`);
