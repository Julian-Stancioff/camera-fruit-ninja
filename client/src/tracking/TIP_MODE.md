# Tip mode

`detectTip.js` tracks ONLY THE TIP of the blade as a single moving point, instead of
fitting the blade's whole axis the way `detectAuto.js` does. It exists because axis
fitting is not robust enough under the motion blur of a real swing, where a smeared
blade stops being a line but still has a leading extremity.

The detector is self-contained (zero imports) so it can also be pasted into a live
page for testing. Its only importer in this repo is the node test
(`client/test/detectTip.test.mjs`); a mode wrapper is being wired by the
orchestrator separately.

## The failure this file must never repeat

The first deployed build of this detector scored foreground pixels on
distance-from-the-foreground-mass plus a tip-is-up prior — "the far end of the
foreground". Its synthetic acceptance scene had NO BODY in it, so the only
foreground was the blade and the extremity search was trivially right. In the live
game the PLAYER is foreground — head, shoulders, torso, a raised elbow, one swaying
mass — and the player reported, accurately: *"It's not even connected to the tip of
the blade at all."*

Reproduced after the fact by adding a synthetic player to the committed room
(measured against the deployed build):

| scene | deployed build |
|---|---|
| player alone, no sword, 310 frames | **302 reported a "tip", 208 of them on his head/elbow** |
| player + sword raised, pre-raise frames | 26/30 reports on the player |
| player + sword hanging idle (tip below his head) | 78/100 reports on the player |
| player + blurred swings | 2-3 reports/run stolen by the head |

The one screenshot where the deployed build looked right had the sword raised high
above his head against the ceiling — the only pose where "topmost extremity" and
"tip" coincide. That lucky pose is what sent earlier rounds chasing the wrong bug.

## How it works now

One luminance background model (fast `bg` + slow room memory `bgS`, the two
highest-value mechanisms of the whole katana effort), then:

- **Mass map**: strict novelty (|lum-bg| > 16) plus ABSORBED novelty (|bg-bgS| > 24)
  — a standing body is swallowed by the fast background in ~12 frames and must
  still count as bulk for the gates below.
- **Thinness gate** (every strict candidate): mass on a 9px probe perpendicular to
  the candidate's outward direction must be ≤ 6. A 1-2px blade reads 2-5; a head
  rim, torso edge or arm reads 7-9. The single strongest body-vs-blade
  discriminator measured here.
- **Protrusion gate** (winners not carried by a reporting lock's continuity): the
  local mass mean-offset must be one-sided (a tip has all its mass on one side)
  and 5px-narrow rows 3 and 6px behind it must continue thinly (total ≤ 12 — a 5px
  forearm reads 15+). Gated winners fall through to the next-best of a top-8
  shortlist. A blooded fast lock's heavily-moving winner is exempt from the
  continuation requirement (a blurred tip has no strict shaft behind it — that is
  what blur IS).
- **Acquisition by blooding**: NO reports until a candidate earns the lock. Up to 3
  candidate locks track independently (the per-frame winner ping-pongs between the
  blade and body flicker, so the top few gate-surviving candidates all feed the
  tracker, one per feature). A candidate bloods only with: a coherent streak (2+
  same-direction steps of 1.5px+, decaying not resetting on quiet frames,
  surviving 6-frame gaps — the blade vanishes crossing the contrast-dead bed
  band), 8px+ of net travel from a windowed origin, travel UPWARD-dominant (|dy| ≥
  1.5|dx|, dy<0 — you acquire a katana by RAISING it, and every measured false
  blood travelled along the head's horizontal hair band), and a shaft behind it:
  walking back along the travel (the shaft is what the tip left behind), 4 of 5
  rows at 3px spacing must be blade-like — 1-4px of CONTIGUOUS mass (a 4px forearm
  reads as two edge strips split 4 apart; the shoulder line crosses at full
  width), totalling 9-14 (flicker crumbs measured 4-8; a real 2px shaft 10).
- **Continuity is earned**: the LOCK_W bonus, the faint-evidence window, the freeze
  disc and velocity coasting only exist for a blooded lock. An unblooded squatter
  on a head rim must not outscore the real tip rising past it (measured costing
  entire acquisitions).
- A coasted report that lands in thick mass (3x3 mass ≥ 8) is suppressed — dead
  reckoning must not paint the cursor onto the player.

Deadbanded reporting, velocity coasting and the speed-gated faint window carry the
blooded lock through blur and misses exactly as before.

## Measured (committed scene, 192x108; player scenes include head, shoulders, torso and a raised elbow, swaying, plus the room's 37-44% raw-lit clutter)

| case | result |
|---|---|
| bare room: held still, 300 frames | 100% found, tip err med 2.5px, movement med 0.02px |
| bare room: fast swing, sharp | 100% tracked, med 2.9px, p90 6.1px, worst 10.6px |
| bare room: no sword, 300 frames | 0 hallucinations |
| bare room: lowered out of frame | reports stop ≤16 frames, 0 ghosts, re-acquires 100% (med 2.5px) |
| **player + sword held still** | pre-sword reports 0/30; found 99.7%, med 2.5px, worst 3.9px, **0 stolen** |
| **player + full swing** | 100% tracked, 100% within 10px, med 2.6px, **0 stolen** |
| **player, NO sword, 340 frames** | **0 reports** (deployed build: 302) |
| **player + sword hanging idle** | 0 reports — silent by design (never raised), **0 on the player** (deployed: 78) |
| budget | median 0.42ms, p99 0.45ms bare; 0.43ms / 0.47ms with the player (node) |

Motion blur (peak tip smear per 33ms exposure), WITH the player in frame, versus
the axis detector's known curve on the same harness:

| blur | tracked | within 10px | err med / p90 / worst | stolen | axis mode tracked |
|---|---|---|---|---|---|
| 8px  | 100%  | 100%  | 3.4 / 6.2 / 9.8px    | 0 | 91.7% |
| 16px | 100%  | 86.1% | 5.4 / 13.9 / 39.6px  | 0 | 68.1% |
| 24px | 100%  | 77.8% | 6.6 / 15.1 / 39.3px  | 0 | 45.8% |

Bare-room blur is unchanged from the pre-fix detector (100/100, 100/86.1,
98.6/76.4) — the player fix cost the blur bet nothing. "Stolen" = a report >15px
from truth, on the player, and >4px off the blade's axis; reports that retreat
along a smeared blade while it crosses the raised arm are the documented
blur inward-pull, not steals.

Robustness sweep (20 grain seeds x sway phases, not part of the committed suite):
player-alone and idle-hang scenes reported **0 frames on 20/20 seeds**; still-pose
tracking ≥98.6% found on 19/20 (one seed acquired late: 71.9% found, still 0
stolen); median err 2.4-3.7px; 0 stolen anywhere.

## Wiring it in later

1. `enroll`/`detect` keep detectAuto's signatures; `detect` returns
   `{x, y, quality} | null` (small-canvas px) instead of an axis.
2. `ObjectBlade.update()` equivalent: `{ tipNorm: {x: hit.x/f.SW, y: hit.y/f.SH},
   conf: hit.quality }` — no `angle`, no `gripNorm`, no `endsNorm`.
3. `main.js` (katana branch): map through `mapPoint(tipNorm.x, tipNorm.y)` and
   drive the game the way solo hand mode drives its fingertip cursor.

## Known weaknesses — honest, current

- **No angle.** It drives a cursor, not a blade segment. That is the entire trade.
- **Acquisition REQUIRES a raise.** The lock only bloods on upward-dominant
  coherent travel with a visible shaft behind the tip. A sword held perfectly
  still from frame 0, hanging idle, or entering horizontally is deliberately NOT
  reported until first raised (~0.2s of raise). Silence was chosen over the
  deployed build's behaviour of reporting the head. A sword raised behind the
  player's silhouette (no clean shaft rows) bloods late or not at all — measured
  once in 20 seeds as 72% found instead of ~100%.
- **A bare fast-moving thin limb can in principle still blood** — a pointing
  finger swept upward is shaped and moves like a blade. Both hands are on a
  katana, so this is accepted; it did not occur in 20 seeds of swaying player.
- **The synthetic player is one body.** One geometry, one shirt, one sway model —
  built to match the measured room (head above the tip's rest height, raised
  elbow, crushed lower half). A live player remains the real test; the mechanisms
  (thinness, protrusion, blooding) are geometric, not tuned to this silhouette,
  but the exact caps (W0=6, PROT=12, LONG rows 1-4/tot 9-14) are calibrated at
  192x108 scale.
- **Contrast-dead zones are blind**, same physics as axis mode: the blade over the
  crushed lower half, the bed, the skateboards, or the player's own dark shirt
  simply is not there. The still pose leaves ~19px of visible shaft above the bed
  band; the blood walk needs ~15px of it.
- **A multi-minute perfectly-still dwell** lets the slow room memory absorb blade
  and body; the mass map then fades and gates lean on strict flicker only.
  Blooding still requires a raise, so the failure mode is silence, not theft.
- **A blade already in frame at frame 0 and never moving** is learned as furniture
  and recovered on first motion — same trade as axis mode.
