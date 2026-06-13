# Brainlift — Learning Log & AI Methodology

How an unfamiliar stack (3D rendering + in-browser computer-vision input +
real-time authoritative netcode) went from zero to a deployed, polished multiplayer
game, using AI as the learning and building engine.

> This is a working draft assembled from the actual build history — personalize the
> daily notes and add your own prompts/screenshots before submission.

---

## Methodology: how AI was used

The whole project was driven through an **AI coding agent (Claude)** acting as
researcher, architect, pair-programmer, tester, and deployer. The repeatable loop:

1. **Research → decide.** Ask the AI to research the unfamiliar domain and produce an
   *implementation-ready* brief with concrete library names, versions, and trade-offs
   (the result is `docs/camera-fruit-ninja-build-guide.md`).
2. **Grill before building.** Before any code, the AI interviewed me one decision at a
   time ("renderer? multiplayer scope? assets? hosting?") with a *recommended answer +
   rationale* for each. This front-loaded the architecture and avoided rework. The
   locked decisions live in `docs/PLAN.md` and `docs/DECISIONS.md`.
3. **Build in vertical slices, deploy continuously.** Camera → tracking → core game →
   polish → multiplayer, with a live HTTPS URL updated after every slice so the real
   webcam could be tested on real devices throughout.
4. **Adversarial self-testing.** Every change was verified headlessly (Playwright +
   a fake camera + a `?test=1` hook exposing game internals) before deploy — slicing,
   combos, bombs, belts, and full 2-browser multiplayer matches.

### AI techniques that accelerated learning
- **"Recommendation-first" decisions:** ask the AI to *decide and justify*, not just
  list options — turns analysis paralysis into a reviewable choice.
- **Generated, runnable proofs:** instead of reading docs, have the AI write a tiny
  proof (e.g. render landmark 8 as a dot) to validate understanding immediately.
- **Root-cause prompting over symptom-patching:** when feel was off, the winning
  prompt wasn't "make it faster" but "*why* is it laggy — trace the signal path." That
  surfaced the real bug (below).
- **Test hooks for an un-testable input:** you can't give a headless browser a hand,
  so we exposed `window.__fn` to spawn/slice fruit programmatically and drove two
  browser contexts to validate netcode.

---

## Daily progress

### Day 1–2 — Research & architecture
- Used AI to produce a full technical guide for camera-controlled browser games
  (MediaPipe vs TF.js, Three.js vs Phaser, netcode options, deployment).
- Grilled the design to lock: **Three.js 3D**, **MediaPipe** input, **procedural
  assets**, **deploy on existing VPS**, single-player Classic first.
- **Proof-of-concept:** camera + MediaPipe + a blade trail dot — validated that
  in-browser hand tracking was viable in ~one sitting.

### Day 3–5 — Core game
- Built the single-player game: orthographic Three.js scene in screen-pixel space,
  procedural 3D fruit (watermelon, apple, orange, lemon, strawberry, kiwi, pineapple)
  + bombs, gravity physics, segment-vs-circle slicing, combos, 3-strike lives, score,
  procedural Web Audio SFX, dojo background + webcam PiP.
- Deployed early so the camera could be tested over HTTPS on a phone.

### Day 5–6 — The "feel" saga (the real engineering)
The features worked; the *feel* didn't. This was the hardest and most instructive part:
- **"Blade lags / too slow."** Root cause (found by tracing the signal path): the One
  Euro smoothing filter ran on **normalized [0,1]** coordinates, but its speed term
  `beta` is tuned for pixel-scale values — so it never engaged and acted as a constant
  heavy low-pass. *Lesson: a filter's parameters are unit-dependent.*
- **"Can't reach the screen edges / still too slow."** A hand only covers the middle
  ~60% of the camera frame. Added a **centered sensitivity gain** so a comfortable hand
  range sweeps the whole screen — fixed reach *and* perceived speed at once.
- **"Too jittery / messes up cuts / clunky."** The previous fix overcorrected (gain +
  aggressive smoothing + a prediction hack amplified the camera's natural noise).
  Rebalanced properly: **smooth in pixel space** with sane params, **drop the
  prediction hack**, and **decouple 60fps rendering from 30fps detection**. Added a
  player-facing **Settings panel** (Sensitivity + Smoothing) so feel is tunable without
  a redeploy.
- *Takeaway: in a motion game, the input-feel tuning is a real engineering problem,
  separate from the gameplay code — and AI is great at proposing the signal-processing
  fixes once you prompt for root cause.*

### Day 6–7 — Multiplayer + progression + polish
- Added the case-study requirements: **competitive 1v1 over Socket.io** (authoritative
  server, shared synced fruit stream, opponent ghost blade, 90s match, shareable join
  link) and a **belt-rank progression** system.
- Reused the existing Scene/Fruit/blade machinery for the networked game — the
  screen-pixel + normalized-coord design made multiplayer a thin layer, not a rewrite.
- Verified full 2-browser matches headlessly and live on the deployed infrastructure.
- Wrote setup/deploy/architecture docs.

---

## Challenges & solutions (quick reference)

| Challenge | Solution |
|---|---|
| Blade felt laggy | One Euro filter was on normalized coords; moved smoothing to pixel space |
| Couldn't reach screen edges | Centered sensitivity gain mapping a comfy hand range to the full screen |
| Jittery / unreliable cuts | Pixel-space smoothing + removed prediction hack + decoupled render/detect |
| Choppy ("clunky") motion | 60fps rAF render loop independent of the 30fps camera |
| Testing a camera game headlessly | Fake-camera Chromium + `?test=1` hook to script slices/spawns |
| Real-time multiplayer w/o lag | Never send video; sync ~16-byte intent; server authoritative on score |
| HTTPS required for camera | Caddy auto-TLS; deploy behind it; localhost exempt for dev |

---

## Reflection

The differentiator wasn't writing game code — it was **using AI to get productive in
three unfamiliar domains at once and to debug a *feel* problem by reasoning about the
signal path rather than guessing.** The architecture decisions made up front (screen-
pixel coordinate space, normalized network coords, procedural assets) are what let
multiplayer and progression land quickly at the end instead of forcing a rewrite.
