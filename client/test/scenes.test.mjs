// Self-check for the bench's ground truth: node client/test/scenes.test.mjs
// The referee's scenes are only worth anything if the truth matches the pixels, so
// every assertion here is measured OUT of the rendered frames, never taken on faith
// from the generator that drew them.
import assert from "node:assert";
import { scenes } from "./scenes.mjs";

const all = scenes();
const lum = (p, x, y, W) => { const i = ((y | 0) * W + (x | 0)) * 4; return (p[i] + p[i + 1] + p[i + 2]) / 3; };

// A pose is only useful if something is actually THERE. Walk the truth axis and compare
// each step against its own flanks: the biggest gap must clear the room's noise floor.
function axisContrast(p, W, H, t) {
  const [[x0, y0], [x1, y1]] = t.ends;
  const dx = (x1 - x0) / t.len, dy = (y1 - y0) / t.len;
  let best = 0;
  for (let r = 2; r < t.len - 2; r++) {
    const x = x0 + r * dx, y = y0 + r * dy;
    if (x < 7 || y < 7 || x > W - 8 || y > H - 8) continue;
    const a = lum(p, x, y, W);
    const l = lum(p, x - 7 * dy, y + 7 * dx, W), rr = lum(p, x + 7 * dy, y - 7 * dx, W);
    best = Math.max(best, Math.abs(a - (l + rr) / 2));
  }
  return best;
}

assert.strictEqual(all.length, 7, "expected 7 scenes");
for (const s of all) {
  const px = s.SW * s.SH * 4;
  assert.strictEqual(s.truth.length, s.frames.length, `${s.name}: one truth per frame`);
  assert.ok(s.enrollFrames.length > 1, `${s.name}: enrolment needs several frames`);
  for (const f of [...s.frames, ...s.enrollFrames]) assert.strictEqual(f.length, px, `${s.name}: wrong buffer size`);

  // Enrolment must show the object being WAVED: consecutive frames have to differ by
  // far more than sensor noise, or motion is not available as a cue.
  const a = s.enrollFrames[0], b = s.enrollFrames.at(-1);
  let moved = 0;
  for (let i = 0; i < px; i += 4) if (Math.abs(a[i] - b[i]) > 12) moved++;
  if (s.name === "empty") assert.ok(moved < 60, `${s.name}: the room itself is moving (${moved} px) — furniture must hold still`);
  else assert.ok(moved > 150, `${s.name}: enrolment frames barely move (${moved} px)`);

  for (let k = 0; k < s.frames.length; k++) {
    const t = s.truth[k];
    if (s.name === "empty") { assert.strictEqual(t, null, "empty scene must have null truth"); continue; }
    assert.ok(t && t.len > 20, `${s.name}[${k}]: no truth`);
    for (const [x, y] of t.ends) {
      assert.ok(x >= -0.01 && y >= -0.01 && x <= s.SW - 0.99 && y <= s.SH - 0.99, `${s.name}[${k}]: truth end off-frame`);
    }
    // ends, angle and len are three views of one segment; they must agree exactly.
    const [[x0, y0], [x1, y1]] = t.ends;
    assert.ok(Math.abs(Math.hypot(x1 - x0, y1 - y0) - t.len) < 1e-9, `${s.name}[${k}]: len != |ends|`);
    assert.ok(Math.abs(Math.atan2(y1 - y0, x1 - x0) - t.angle) < 1e-9, `${s.name}[${k}]: angle != atan2(ends)`);
    const c = axisContrast(s.frames[k], s.SW, s.SH, t);
    assert.ok(c > 12, `${s.name}[${k}]: nothing visible on the truth axis (${c.toFixed(1)}) — unsolvable scene`);
  }
}

// The clipped scene has to actually clip, or it is just another baseline.
const clip = all.find((s) => s.name === "clipped");
assert.ok(clip.truth.some((t) => t.len < 95), "clipped scene never loses an endpoint");

// Seeded, so a bench run today and a bench run tomorrow compare the same numbers.
assert.deepStrictEqual(scenes()[3].frames[5], all[3].frames[5], "scenes are not deterministic");

console.log(`scenes: OK — ${all.length} scenes, ${all.reduce((n, s) => n + s.frames.length + s.enrollFrames.length, 0)} frames`);
for (const s of all) {
  const c = s.truth[6] ? axisContrast(s.frames[6], s.SW, s.SH, s.truth[6]).toFixed(0) : "-";
  console.log(`  ${s.name.padEnd(14)} truth ${s.truth[6] ? "yes" : "NULL"}  peak axis contrast ${c}`);
}
