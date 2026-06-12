# Camera Fruit Ninja — Build Plan (v1)

> Locked with Julian via grill on 2026-06-12. This is the contract for the MVP.
> Build does not start until this plan is approved.

## Vision

A browser game that **looks and plays like the original Fruit Ninja mobile game**
(3D fruit, bamboo dojo, blade trail, juicy splatter) but is **controlled by the
player's hand via the webcam** instead of a touchscreen. The index fingertip is
the blade. Any laptop/phone webcam works — no special hardware, all tracking runs
client-side.

## Locked decisions

| # | Decision | Choice |
|---|----------|--------|
| 1 | Scope (first ship) | **Single-player MVP** — guide Milestones 1–3. Multiplayer decided later. |
| 2 | Renderer / look | **Three.js 3D**, styled to match original Fruit Ninja. |
| 3 | Assets | **Procedural 3D + free/CC0 first.** Higgsfield only if procedural falls short / for later polish (Julian has no Higgsfield account yet — maximize work before needing it). |
| 4 | Hosting | **VPS via Dokploy behind Caddy**, at `fruitninja-51-81-34-160.nip.io`, set up **early** (HTTPS → real-device camera testing). |
| 5 | Game mode | **Classic** — slice fruit; miss 3 or hit a bomb = game over. Combos, score, local high score. |
| 6 | Webcam on screen | **Dojo background + small toggleable webcam PiP** in a corner for hand orientation. |

### Defaults I'll apply (not separately grilled — flag if any are wrong)

- **Build tooling:** Vite (needed to bundle `three` + `@mediapipe/tasks-vision`).
- **Tracking:** `@mediapipe/tasks-vision` HandLandmarker, `runningMode:"VIDEO"`,
  `numHands:1` (single-player), `delegate:"GPU"` with CPU fallback, blade =
  landmark 8, **One Euro filter** smoothing, `requestVideoFrameCallback` loop
  (rAF fallback).
- **Model files self-hosted** (`hand_landmarker.task` + wasm committed to repo)
  with long cache headers — no third-party CDN dependency at runtime.
- **Camera requires a user gesture** → a "Start" button calls `getUserMedia`.
- **Mirror** the video + overlay (`scaleX(-1)`) so movement feels natural.

## Look & feel (reference)

Target aesthetic captured in `docs/reference/` (bing_gameplay / bing_fruit /
bing_dojo_trail): glossy 3D fruit (watermelon, apple, orange, pineapple, banana,
strawberry, kiwi, coconut), **bamboo/wood dojo** background, **white→fading blade
trail**, **juice splatter + half-fruit split** on slice, score top-corner,
bombs (black with lit fuse). We build **original-style** models/textures (not
Halfbrick's exact assets — same feel, legally clean).

## Gameplay spec (Classic, tuned to the original)

- **Fruit physics:** launch from below the bottom edge with random `(vx, vy)`,
  constant gravity, arc up and fall. Spawn 1–3 at a time in a fan.
- **Spawn cadence:** ~1200 ms, tightening toward ~500 ms as score climbs.
- **Slice:** fingertip must be **moving** (speed gate ~150 px/s) AND its motion
  segment crosses a fruit → slice. Slicing splits the fruit into two halves that
  fly apart under gravity, spawns 8–12 juice particles, +score, plays a sound.
- **Combos:** ≥3 fruit in a ~0.5 s window → multiplier + a big fading "Combo!"
  label, like the original.
- **Bombs:** ~10–15% of spawns. Slicing one = **game over** (screen flash + sound).
- **Lives:** **3 strikes** — a fruit that falls off-screen unsliced costs a strike;
  0 strikes = game over. (Classic uses the "X" strikes; bomb is instant out.)
- **Score / high score:** running score; best score saved in `localStorage`.
- **Screens:** Start (with camera permission + a "show your hand" calibration
  beat) → Game → Game Over (score, best, replay).

## Tracking → slicing pipeline (3D models, screen-space collision)

To keep collisions simple and accurate, **fruit are 3D meshes but move within a
plane facing the camera.** Each frame:
1. MediaPipe gives landmark 8 normalized `(x,y)`; map to screen px, mirror, smooth
   (One Euro). Keep previous point → motion segment + speed.
2. Project each fruit's center to screen space (it's on a known plane) → 2D circle.
3. **Line-segment vs circle** test (from `docs` guide §3.4) between the fingertip
   segment and each fruit; if hit AND speed-gated → slice that fruit.
4. Render: dojo bg, 3D fruit with gloss lighting, blade trail (tapered ribbon),
   particles, HUD (score, strikes, combo), webcam PiP.

Heavy MediaPipe inference can move to a Web Worker if the main thread can't hold
60fps; start simple, add the worker only if frames drop (guide §3.8).

## Project structure (within this repo)

```
client/
  index.html
  vite.config.js
  public/models/        hand_landmarker.task + wasm (self-hosted)
  public/assets/        textures, sounds (procedural/CC0)
  src/
    main.js             entry, start button, getUserMedia, loop wiring
    tracking/HandTracker.js   HandLandmarker wrapper + One Euro filter
    game/Fruit.js             fruit entity (3D mesh + plane physics)
    game/FruitSpawner.js      spawn timing + difficulty curve
    game/SliceDetector.js     segment-circle test + speed gate
    game/ScoreManager.js      score, strikes, combo, high score
    game/GameLoop.js          rVFC loop, delta time, state machine
    rendering/Scene.js        Three.js scene, camera, lights, dojo bg
    rendering/FruitModels.js  procedural fruit meshes + textures
    rendering/BladeTrail.js   trail ribbon
    rendering/Particles.js    juice burst + fruit halves
    rendering/Hud.js          score/strikes/combo/PiP overlay (DOM or canvas)
    audio/Sound.js            slice/combo/bomb/miss (Howler or native)
Dockerfile               static build served by a tiny server / nginx:alpine
```

## Milestones (single-player MVP)

**M1 — Camera + tracking (foundation)**
Vite app, Start button → `getUserMedia` (720p, mirrored), HandLandmarker init,
rVFC loop, One Euro filter, render the fingertip as a dot + blade trail to prove
tracking is smooth. Deploy this skeleton to `fruitninja-51-81-34-160.nip.io` so
camera works over HTTPS on real devices.

**M2 — Core game (the fun)**
Three.js dojo scene; procedural fruit + gravity arcs; spawner; segment-circle
slice with speed gate; split halves + juice particles; score + 3 strikes; bomb =
game over; start/game/game-over screens; high score.

**M3 — Polish to "feels like Fruit Ninja"**
Better fruit models/textures + lighting gloss; blade trail tuning; combos + combo
text; sound effects; progressive difficulty; webcam PiP toggle; performance pass
(Web Worker if needed); deploy.

## Deployment plan

Static client (Vite `build` → `dist/`) in a Docker image, deployed as a **new
Dokploy app** at domain `fruitninja-51-81-34-160.nip.io`, **HTTPS toggle OFF**
(Caddy terminates TLS via the on-demand catch-all — zero Caddy edits needed).
Long cache headers on `.task`/`.wasm`. No backend for v1. When multiplayer comes,
add a Colyseus service; Caddy already proxies WebSockets.

## Deferred (explicitly out of v1)

- Online multiplayer (Colyseus) and local two-hand mode.
- Arcade / Zen modes + power-ups.
- Higgsfield-generated art (revisit for polish; needs Julian's account).

## Top risks & mitigations

- **Tracking jitter/latency** → One Euro filter; GPU delegate; Worker fallback.
- **"Exact original look" in 3D is art-heavy** → procedural first, iterate; this is
  the most likely place we later reach for Higgsfield.
- **Camera UX on varied lighting/devices** → calibration beat + PiP; test early on
  the live HTTPS URL.
