# Tip mode (spare part — not wired in)

`detectTip.js` tracks ONLY THE TIP of the blade as a single moving point, instead of
fitting the blade's whole axis the way `detectAuto.js` does. It exists as a fallback
for the day axis fitting is not robust enough — above all under motion blur, where a
smeared blade stops being a line but still has a leading extremity.

**Nothing imports it, and that is deliberate.** Vite only bundles what the
`index.html` module graph reaches, so leaving these files unimported is exactly what
keeps them out of the shipped app. The only importer anywhere is the node test
(`client/test/detectTip.test.mjs`), which never gets bundled. The detector is
self-contained (zero imports) so it can also be pasted into a live page for testing.

## How it works

One luminance background model (the single highest-value mechanism from the axis
effort — it took the real room from 37% of the frame lit to ~0%), a slow room memory
that kills the ghosts a luma background leaves behind, and a scored extremity search:
foreground pixels compete on distance-from-the-foreground-mass, a strong tip-is-up
prior (the same bet `ObjectBlade.hiltEnd` hard-codes), per-pixel motion, contiguity,
and continuity with the predicted tip. No line vote, no axis, no hilt/tip
disambiguation. Deadbanded reporting, velocity coasting, and a speed-gated
faint-evidence window carry it through blur and misses.

## Measured (same synthetic build of the real room the axis suite uses, 192x108)

| case | result |
|---|---|
| held still, 300 frames | 100% found, tip err med 2.5px, movement med 0.02px / worst 0.07px |
| fast swing, sharp, ~6deg/frame peak | 100% tracked, err med 2.9px, p90 6.1px, worst 10.6px |
| no sword, 300 frames | 0 hallucinations |
| lowered out of frame | reports stop within 13 frames (3-13 across seeds; the mechanism's bound is COAST_MAX+MISS_MAX = 16), 0 ghosts after, re-acquires 100% |
| budget | median 0.19ms, p99 0.26-0.58ms in node (axis mode: 3.01ms node, 6.5ms live browser) |

Motion blur (peak tip smear per 33ms exposure), versus the axis detector's known
curve on the same harness:

Committed-seed numbers, with the spread over a sweep of 14 grain seeds and 9
re-rolled rooms in brackets — read the bracket, not the headline:

| blur | tip mode tracked | within 10px | err med / p90 / worst | axis mode tracked |
|---|---|---|---|---|
| 8px  | 100%  | 100%  [94-100%] | 3.3 [2.9-3.4] / 5.9 / 9.9px   | 91.7% |
| 16px | 100%  | 86.1% [76-94%]  | 5.7 [4.4-6.1] / 14.1 / 39.5px | 68.1% |
| 24px | 98.6% | 76.4% [38-82%]  | 7.0 [6.2-15.5] / 16.3 / 43.2px | 45.8% |

The blur bet holds at 8 and 16px: where axis fitting drops a third of its frames and
its median angle error hits 28.7deg (~35px of tip position on a 74px blade), tip mode
reports every frame and puts 8 in 10 of them within 10px. Note that tracked% is a soft
metric here — a coasting point always has something to say — so within-10px is the
number that matters. At 24px the physics runs out: a 2px blade at 45 luma smeared over
24px leaves ~4 luma of tip, at the grain floor, and the seed spread (38-82% within
10px) says so. The cost throughout is honest position error, not a lost frame: the
report pulls inward to the outermost still-visible pixel, then snaps back out as the
stroke slows.

## Wiring it in later

1. `ObjectBlade.js`: add the import (`import * as tipDetector from "./detectTip.js";`)
   and a mode switch, or make a small `TipBlade` clone of `ObjectBlade`. `_grab()`
   stays as is; `enroll`/`detect` have the same signatures as `detectAuto`, but
   `detect` returns `{x, y, quality} | null` (small-canvas px) instead of an axis.
2. What `ObjectBlade.update()` would return in this mode:
   `{ tipNorm: { x: hit.x / f.SW, y: hit.y / f.SH }, conf: hit.quality }` — no
   `angle`, no `gripNorm`, no `endsNorm`. Endpoint pairing, hilt hysteresis and the
   cos/sin angle filters are all unused; the detector already deadbands and coasts.
3. `main.js` (katana branch): map the point through `mapPoint(tipNorm.x, tipNorm.y)`
   — the exact same mapping the solo-mode index fingertip goes through
   (`mapPoint(blade.x, blade.y)`) — and drive the game the way solo hand mode does:
   a point cursor with a trail, through the existing fingertip smoothing. There is
   no angle, so the two-endpoint blade draw does not apply.

## Known weaknesses

- **No angle.** It cannot draw a blade segment; it drives a cursor. That is the
  entire trade.
- **Tip-is-up prior is strong.** A sword held tip-DOWN cold-acquires the wrong end
  until the first swing (continuity then carries the correct end through horizontal
  and beyond). Same bet `hiltEnd` makes.
- **The player is untested.** The synthetic room has no body. In a real scene the
  body is foreground; its mass anchors the extremity search (probably helps), but a
  head or raised elbow could steal cold acquisition while the sword hangs idle.
  Enrolment waves the sword, motion and continuity recover it — unmeasured.
- **Contrast-dead zones are blind**, same physics as axis mode: where the room sits
  at blade luma (the crushed-black lower half, the door, the skateboards) there is
  no foreground to find. The tip is only tracked where it differs from its backdrop.
- **A multi-minute perfectly-still dwell** lets the slow room memory absorb the
  blade; if it is then removed, a ghost tip can linger under the freeze disc until
  real motion breaks it. A 2s dwell is measured clean; real hands tremble.
- **A blade already in frame at frame 0 and never moving** is learned as furniture
  (indistinguishable from it) and recovered on first motion — same trade as axis
  mode.
