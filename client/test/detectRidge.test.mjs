// Self-check for the structure detector: node client/test/detectRidge.test.mjs
// The scene is the case this detector exists for: a MIRROR blade whose face sits 2 RGB
// units from the wall behind it — only its thin rim betrays it — over a wall that also
// carries a permanent shelf edge, to prove motion (not brightness) picks the object.
import assert from "node:assert";
import { NAME, enroll, detect } from "../src/tracking/detectRidge.js";

const W = 192, H = 108, CX = 96, CY = 54, LEN = 64, HW = 2, ANGLE = -Math.PI / 6;
let seed = 7;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const off = (a, b) => {
  const t = (((a - b) % Math.PI) + Math.PI) % Math.PI;
  return (Math.abs(t > Math.PI / 2 ? t - Math.PI : t) * 180) / Math.PI;
};

function scene(angle) {
  seed = 7;
  const p = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 4, v = 112 + x * 0.04 + y * 0.05 + rnd() * 4; // lit wall + noise
    p[i] = v; p[i + 1] = v * 0.98; p[i + 2] = v * 0.95; p[i + 3] = 255;
  }
  for (let x = 0; x < W; x++) { // a shelf edge that never moves
    const i = (18 * W + x) * 4;
    p[i] -= 44; p[i + 1] -= 44; p[i + 2] -= 44;
  }
  if (angle === null) return p;
  const bg = p.slice(), dx = Math.cos(angle), dy = Math.sin(angle);
  for (let r = -LEN / 2; r <= LEN / 2; r += 0.4) for (let t = -HW - 1.2; t <= HW + 1.2; t += 0.25) {
    const x = Math.round(CX + r * dx - t * dy), y = Math.round(CY + r * dy + t * dx);
    if (x < 0 || y < 0 || x >= W || y >= H) continue;
    const i = (y * W + x) * 4, d = Math.abs(t) <= HW ? 2 : -26; // mirror face vs. dark rim
    p[i] = bg[i] + d; p[i + 1] = bg[i + 1] + d; p[i + 2] = bg[i + 2] + d;
  }
  return p;
}

assert.strictEqual(NAME, "ridge");

// 1. Enrolment: 10 frames of the blade sweeping. Motion must pick the blade, not the shelf.
const frames = [];
for (let k = 0; k < 10; k++) frames.push(scene(ANGLE + (k / 9 - 0.5) * 0.7));
const model = enroll(frames, W, H);
assert.ok(model, "enroll found nothing");
assert.ok(Math.abs(model.len - LEN) < 0.3 * LEN, `enrolled len ${model.len.toFixed(1)} vs ${LEN}`);
assert.ok(model.halfW >= 2 && model.halfW <= 4, `enrolled halfW ${model.halfW}`);
assert.ok(!("ref" in model) && !("colour" in model), "model must not carry colour");
console.log(`model: len ${model.len.toFixed(1)} (true ${LEN}), halfW ${model.halfW}, edgeMag ${model.edgeMag.toFixed(0)}`);

// 2. The mirror case: recover the axis of a blade the same colour as the wall.
const frame = scene(ANGLE);
const hit = detect(frame, W, H, model, null);
assert.ok(hit, "lost a blade whose fill matches the wall");
assert.ok(off(hit.angle, ANGLE) < 5, `angle off by ${off(hit.angle, ANGLE).toFixed(2)}deg`);
assert.ok(Math.hypot(hit.cx - CX, hit.cy - CY) < 8, `centre off by ${Math.hypot(hit.cx - CX, hit.cy - CY).toFixed(1)}px`);
assert.ok(hit.len > 0.7 * LEN && hit.len < 1.4 * LEN, `len ${hit.len.toFixed(1)} vs ${LEN}`);
assert.strictEqual(hit.ends.length, 2);
console.log(`detect: ${off(hit.angle, ANGLE).toFixed(2)}deg off, len ${hit.len.toFixed(1)}, centre err ` +
  `${Math.hypot(hit.cx - CX, hit.cy - CY).toFixed(1)}px, quality ${hit.quality.toFixed(2)}`);

// 3. Wall + shelf edge, no object: a single background line has only ONE flank and must
//    not be mistaken for a bar.
assert.strictEqual(detect(scene(null), W, H, model, null), null, "the shelf edge was called a blade");
console.log("empty frame: null");

// 4. Budget: this runs inside a 33ms camera frame next to Three.js. Warm the JIT first —
//    untimed, or the first 20 calls dominate the average and the number is fiction.
for (let k = 0; k < 40; k++) detect(frame, W, H, model, hit);
const t0 = process.hrtime.bigint();
for (let k = 0; k < 200; k++) detect(frame, W, H, model, hit);
const ms = Number(process.hrtime.bigint() - t0) / 1e6 / 200;
assert.ok(ms < 4, `${ms.toFixed(2)}ms per detect exceeds the 4ms budget`);
console.log(`budget: ${ms.toFixed(2)}ms per detect (enroll ran once)`);
console.log("detectRidge: OK");
