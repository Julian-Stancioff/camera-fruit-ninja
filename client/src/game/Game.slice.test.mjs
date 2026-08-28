// node client/src/game/Game.slice.test.mjs
// Game.js can't be imported here (Fruit -> three), so this covers the geometry
// contract Game.update() rests on: the hit test, the speed units, and the
// per-segment gate that katana mode depends on.
import assert from "node:assert/strict";
import { segmentHitsCircle, bladeSpeed } from "./slice.js";

const SPEED_GATE = 180;  // mirrors Game.js
const HIT_MARGIN = 1.3;

// Gate each segment on its OWN speed, then take the first that reaches the fruit —
// this is the predicate Game.update() runs (replicated because Game.js won't load).
const cutBy = (segs, f) => segs
  .filter((s) => s.speed > SPEED_GATE)
  .find((s) => segmentHitsCircle(s.a.x, s.a.y, s.b.x, s.b.y, f.x, f.y, f.radius * HIT_MARGIN));

// --- segmentHitsCircle -------------------------------------------------------
assert.ok(segmentHitsCircle(0, 100, 200, 100, 100, 100, 20), "crosses the circle");
assert.ok(!segmentHitsCircle(0, 100, 200, 100, 100, 400, 20), "passes well below it");
assert.ok(!segmentHitsCircle(0, 100, 30, 100, 100, 100, 20), "stops short of it");
assert.ok(segmentHitsCircle(0, 0, 0, 0, 5, 0, 20), "degenerate point inside still hits");

// --- bladeSpeed --------------------------------------------------------------
assert.equal(bladeSpeed({ x: 0, y: 0 }, { x: 30, y: 40 }, 100), 500, "50px in 100ms = 500px/s");
assert.equal(bladeSpeed(null, { x: 1, y: 1 }, 16), 0, "no previous sample = no speed");
assert.equal(bladeSpeed({ x: 0, y: 0 }, { x: 9, y: 9 }, 0), 0, "zero dt = no speed");

// --- per-segment gate --------------------------------------------------------
const fruit = { x: 300, y: 300, radius: 40 };

// The fast segment misses; the one that WOULD hit is below the gate. Nothing cuts.
// Averaging or max-ing the speeds would wrongly slice here — that's the whole point.
const lazyBase = { a: { x: 290, y: 300 }, b: { x: 300, y: 302 }, speed: 60 };
const whipMiss = { a: { x: 0, y: 900 }, b: { x: 400, y: 900 }, speed: 2000 };
assert.equal(cutBy([lazyBase, whipMiss], fruit), undefined, "slow hit + fast miss = no slice");

// Tip whips through the fruit → cut, and by the TIP's segment (not the base's).
const whipHit = { a: { x: 200, y: 300 }, b: { x: 400, y: 300 }, speed: 2000 };
assert.equal(cutBy([lazyBase, whipHit], fruit), whipHit, "gated tip cuts, direction is the tip's");

// A lone segment behaves exactly as solo hand mode always has.
assert.equal(cutBy([whipHit], fruit), whipHit, "single fast segment on target cuts");
assert.equal(cutBy([{ ...whipHit, speed: 60 }], fruit), undefined, "single slow segment does not");

console.log("Game.slice.test.mjs: all assertions passed");
