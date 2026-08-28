// Self-check for the endpoint bookkeeping: node client/src/tracking/ObjectBlade.test.mjs
// The detectors have their own tests and a benchmark; what is only testable here is
// pairEnds — the thing that stops the blade flipping end-over-end between frames.
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
