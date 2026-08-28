// Self-check for the blob detector: node client/test/detectBlob.test.mjs
// No framework. The scene is built the way a camera sees one: a smooth lit wall, a
// blade lit unevenly along its length, and a FAT arm blob that also moves — enrolment
// has to reject the arm on shape, which is the whole point of ranking by elongation.
import assert from "node:assert";
import { NAME, enroll, detect } from "../src/tracking/detectBlob.js";

const W = 192, H = 108, PIV = { x: 58, y: 74 }, R0 = 22, R1 = 64;
const TRUE_LEN = R1 - R0;
let seed = 7;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const put = (p, x, y, r, g, b) => {
  x = Math.round(x); y = Math.round(y);
  if (x < 0 || y < 0 || x >= W || y >= H) return;
  const i = (y * W + x) * 4;
  p[i] = r; p[i + 1] = g; p[i + 2] = b; p[i + 3] = 255;
};

function frame(a, bar = true) {
  seed = 7;
  const p = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const v = 55 + x * 0.3 + y * 0.45 + rnd() * 10;
    put(p, x, y, v, v * 0.6, v * 0.85);
  }
  if (!bar) return p;
  for (let y = -6; y <= 6; y++) for (let x = -7; x <= 7; x++) put(p, PIV.x + x, PIV.y + y + 9 * a, 120, 92, 78);
  const dx = Math.cos(a), dy = Math.sin(a);
  for (let r = R0; r <= R1; r += 0.4) for (let t = -1.5; t <= 1.5; t += 0.4) {
    const g = 205 + 30 * Math.sin(r / 8); // specular gradient up the blade
    put(p, PIV.x + r * dx - t * dy, PIV.y + r * dy + t * dx, g, g * 0.97, g * 0.92);
  }
  return p;
}

const ANGLES = [-0.95, -0.82, -0.68, -0.55, -0.42, -0.3, -0.18, -0.05];
const frames = ANGLES.map((a) => frame(a));
const degOff = (got, want) => {
  const d = Math.abs(Math.atan2(Math.sin(got - want), Math.cos(got - want)));
  return (Math.min(d, Math.PI - d) * 180) / Math.PI; // the axis is 180-ambiguous
};

// 1. Enrolment picks the blade out of the moving set, not the arm.
const model = enroll(frames, W, H);
assert.ok(model, "enroll found nothing object-like");
assert.ok(model.elong >= 4, `elongation ${model.elong.toFixed(1)} is not blade-shaped`);
assert.ok(Math.abs(model.len - TRUE_LEN) < 0.25 * TRUE_LEN,
  `enrolled len ${model.len.toFixed(1)} is not near ${TRUE_LEN} — the motion smear leaked in`);
console.log(`${NAME}: enrolled len ${model.len.toFixed(1)} (want ${TRUE_LEN}), wid ${model.wid.toFixed(1)}, elong ${model.elong.toFixed(1)}`);

// 2. Detection recovers the angle and length on a frame it did not enrol from.
const A = -0.62, hit = detect(frame(A), W, H, model, null);
assert.ok(hit, "detect lost the blade");
assert.ok(degOff(hit.angle, A) < 5, `angle off by ${degOff(hit.angle, A).toFixed(2)}°`);
assert.ok(Math.abs(hit.len - TRUE_LEN) < 0.25 * TRUE_LEN, `len ${hit.len.toFixed(1)} vs ${TRUE_LEN}`);
assert.ok(Math.abs(Math.hypot(...hit.ends[1].map((v, i) => v - hit.ends[0][i])) - hit.len) < 1e-6, "ends do not span len");
console.log(`${NAME}: ${degOff(hit.angle, A).toFixed(2)}° off, len ${hit.len.toFixed(1)}, quality ${hit.quality.toFixed(2)}`);

// 3. Continuity: feeding the previous result back must not break the next frame.
const nxt = detect(frame(-0.5), W, H, model, hit);
assert.ok(nxt && degOff(nxt.angle, -0.5) < 5, "tracking with prev lost the blade");
console.log(`${NAME}: tracked ${degOff(nxt.angle, -0.5).toFixed(2)}° off, quality ${nxt.quality.toFixed(2)}`);

// 4. Bare wall — no object present — must be null, not a stretch of wall.
assert.strictEqual(detect(frame(0, false), W, H, model, hit), null, "a blank wall was called a blade");
console.log(`${NAME}: empty frame -> null`);

// 5. Budget. Warm and best-of-5: in a running game the JIT has long since settled,
// and on a shared laptop the fastest batch is the least contaminated estimate.
const f = frame(A);
let ms = Infinity;
for (let r = 0; r < 5; r++) {
  for (let k = 0; k < 300; k++) detect(f, W, H, model, hit); // let the JIT settle
  const t0 = process.hrtime.bigint();
  for (let k = 0; k < 300; k++) detect(f, W, H, model, hit);
  ms = Math.min(ms, Number(process.hrtime.bigint() - t0) / 1e6 / 300);
}
assert.ok(ms < 4, `${ms.toFixed(3)}ms per detect blows the 4ms budget`);
console.log(`${NAME}: ${ms.toFixed(3)}ms per detect (budget 4ms)`);
console.log("detectBlob: OK");
