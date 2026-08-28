// Self-check for the structure detector: node client/test/detectRidge.test.mjs
// One room, three questions. The room is a bookshelf — a wall of static decoy lines that
// are longer, straighter and higher contrast than the object — and the object is a mirror
// blade whose FILL sits 2 RGB units off whatever is behind it, so only its hairline rim
// betrays it. Can it find a bar that has no colour? Does it ignore lines that never move?
// Does it say null when the sword is gone and only the decoys are left?
import assert from "node:assert";
import { NAME, enroll, detect } from "../src/tracking/detectRidge.js";

const W = 192, H = 108, CX = 96, CY = 78, LEN = 70, HW = 2;
let seed = 7;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const off = (a, b) => {
  const t = (((a - b) % Math.PI) + Math.PI) % Math.PI;
  return (Math.abs(t > Math.PI / 2 ? t - Math.PI : t) * 180) / Math.PI;
};

// The room: lit wall, sensor noise, and shelf furniture that is byte-identical every
// frame. Only the noise and the blade ever move.
function room(k) {
  seed = 7 + k * 7919;
  const p = new Uint8ClampedArray(W * H * 4);
  for (let i = 0, y = 0; y < H; y++) for (let x = 0; x < W; x++, i += 4) {
    const v = 108 + x * 0.05 + y * 0.06 + rnd() * 3;
    p[i] = v; p[i + 1] = v * 0.98; p[i + 2] = v * 0.95; p[i + 3] = 255;
  }
  let s = 1;                                  // decoys: fixed seed, so they never move
  const fix = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let x = 10; x < W - 14; x += 13 + ((fix() * 7) | 0)) {
    const w = 4 + ((fix() * 5) | 0), g = 40 + fix() * 170;
    for (let y = 8; y <= 40; y++) for (let d = 0; d < w; d++) {
      const i = (y * W + x + d) * 4;
      p[i] = g; p[i + 1] = g * 0.9; p[i + 2] = g * 0.8;
    }
  }
  for (let y = 44; y <= 47; y++) for (let x = 0; x < W; x++) { // the board under them
    const i = (y * W + x) * 4;
    p[i] = 50; p[i + 1] = 44; p[i + 2] = 36;
  }
  return p;
}

// A mirror bar: body +2 RGB on whatever it covers, a dark rim, no colour of its own.
function blade(p, angle, cx = CX, cy = CY) {
  const bg = p.slice(), dx = Math.cos(angle), dy = Math.sin(angle);
  for (let r = -LEN / 2; r <= LEN / 2; r += 0.4) for (let t = -HW - 1.2; t <= HW + 1.2; t += 0.25) {
    const x = Math.round(cx + r * dx - t * dy), y = Math.round(cy + r * dy + t * dx);
    if (x < 0 || y < 0 || x >= W || y >= H) continue;
    const i = (y * W + x) * 4, d = Math.abs(t) <= HW ? 2 : -26;
    p[i] = bg[i] + d; p[i + 1] = bg[i + 1] + d; p[i + 2] = bg[i + 2] + d;
  }
  return p;
}

assert.strictEqual(NAME, "ridge");
const ANG = (k) => (-40 + k * 6) * Math.PI / 180;

// 1. Enrol on the object being waved: motion, not brightness, has to pick it out.
const model = enroll([...Array(10)].map((_, k) => blade(room(k), ANG(k), CX - 8 + k * 2)), W, H);
assert.ok(model, "enroll found nothing");
assert.ok(Math.abs(model.len - LEN) < 0.35 * LEN, `enrolled len ${model.len.toFixed(1)} vs ${LEN}`);
assert.ok(!("bg" in JSON.parse(JSON.stringify(model))), "background must not be serialised");
console.log(`model: len ${model.len.toFixed(1)} (true ${LEN}) halfW ${model.halfW} edgeMag ${model.edgeMag.toFixed(0)}`);

// 2. The point of the detector: recover a bar whose fill matches its background, in a
//    frame where every decoy line is straighter and higher contrast than it is.
let prev = null, worst = 0;
for (let k = 0; k < 6; k++) {
  const a = -20 * Math.PI / 180 + k * 0.06;
  const hit = detect(blade(room(100 + k), a), W, H, model, prev);
  assert.ok(hit, `frame ${k}: lost a blade whose fill matches the wall`);
  assert.ok(hit.ends.length === 2 && Number.isFinite(hit.quality));
  worst = Math.max(worst, off(hit.angle, a));
  assert.ok(worst < 10, `frame ${k}: locked onto the shelf, ${worst.toFixed(1)}deg off`);
  assert.ok(Math.hypot(hit.cx - CX, hit.cy - CY) < 10, `frame ${k}: centre off`);
  prev = hit;
}
console.log(`tracked 6 frames through the clutter, worst ${worst.toFixed(1)}deg`);

// 3. Object gone, decoys left. A latched shelf spine is a swing the player never made.
for (let k = 0; k < 4; k++) {
  assert.strictEqual(detect(room(200 + k), W, H, model, prev), null, "hallucinated a sword");
}
console.log("object gone, decoys left: null");

// 4. Budget: this runs inside a 33ms camera frame next to Three.js.
const f = blade(room(9), ANG(4));
const t0 = process.hrtime.bigint();
for (let k = 0; k < 60; k++) detect(f, W, H, model, prev);
const ms = Number(process.hrtime.bigint() - t0) / 1e6 / 60;
assert.ok(ms < 4, `${ms.toFixed(2)}ms per detect exceeds the 4ms budget`);
console.log(`budget: ${ms.toFixed(2)}ms per detect`);
console.log("detectRidge: OK");
