# 🍉 Camera Fruit Ninja

A browser-based **Fruit Ninja you play with your hand in the air.** Your webcam
tracks your hand (Google MediaPipe, 100% client-side) and your **index fingertip
becomes the blade** — swipe to slice 3D fruit, dodge bombs, and rank up through
martial-arts belts. Includes **real-time competitive 1v1 multiplayer** over the
internet. No special hardware: any laptop or phone webcam works.

**▶ Play it:** https://fruitninja-51-81-34-160.nip.io
**Multiplayer server:** https://fnmp-51-81-34-160.nip.io (Socket.io)

> Built for "Game Week" — ship polished, production-quality software in an
> unfamiliar tech stack (3D + browser hand-tracking + real-time netcode), learned
> and built end-to-end with AI assistance. See [`docs/BRAINLIFT.md`](docs/BRAINLIFT.md)
> for the learning log and AI methodology.

---

## How to play

1. Open the link on any device with a camera and click **Start camera** → **Allow**.
2. **Solo:** slice fruit, build combos, avoid bombs (3 strikes = game over). Slice
   enough fruit over time to advance your **belt rank** (White → Black).
3. **Versus 1v1:** pick *Versus*, **Create a game** and share the code/link, or
   **Join** your friend's code. You both slice the *same* fruit stream from your own
   cameras — whoever slices a fruit first claims it. Highest score after 90 seconds wins.

Tip: good lighting on your hand matters more than anything. A **⚙ Settings** panel
(in-game) tunes Sensitivity and Smoothing to taste.

---

## Architecture

```
                          ┌─────────────────────────────────────────┐
   Your webcam ──frames──▶ │  BROWSER (client, never sends video)     │
                          │                                          │
                          │  MediaPipe HandLandmarker (WASM/GPU)     │
                          │     └─ index fingertip (landmark 8)      │
                          │  One Euro filter (pixel-space smoothing) │
                          │  Three.js scene (orthographic, screen px)│
                          │     └─ 3D fruit, physics, slice detect   │
                          └───────────────┬──────────────────────────┘
                                          │  Socket.io (WSS)
                                          │  • slice {fruitId}
                                          │  • blade {nx, ny}     (versus only)
                                          ▼
                          ┌─────────────────────────────────────────┐
                          │  SERVER (Node + Socket.io, authoritative)│
                          │  • owns the fruit spawn stream           │
                          │  • validates slices, owns the score      │
                          │  • 90s match timer, rooms by 4-char code │
                          └─────────────────────────────────────────┘
```

**Key idea — hand tracking is local, only intent is networked.** Each client runs
MediaPipe on its own machine and sends ~16 bytes of fingertip/slice data, never
video (which would be ~80 MB/s raw). The server is authoritative on the fruit
stream and scoring, so two players genuinely race for the same fruit with no way to
cheat the count.

**Coordinate trick.** The Three.js camera is **orthographic, mapped so world (x,y)
== screen (x,y) with y pointing down.** The tracked fingertip (screen pixels) and
the fruit therefore live in the same coordinate system, so slice collision is a
plain 2D *segment-vs-circle* test while the fruit still render as lit 3D meshes.
Multiplayer spawns are sent in **normalized [0,1] coords** and converted to each
client's pixels, so different screen sizes stay in sync.

---

## Tech stack & why

| Layer | Choice | Why |
|---|---|---|
| Renderer | **Three.js r170** | Real 3D fruit (the brief's Path 2 "3D" option); orthographic camera keeps collision 2D-simple. |
| Hand tracking | **@mediapipe/tasks-vision** | Pre-trained, in-browser, GPU-accelerated 21-landmark hand model — no training, no server CV. |
| Smoothing | **One Euro filter** | Adaptive: steady at rest (no jitter), low-lag when swiping. |
| Build | **Vite** | Fast dev + bundling for the npm deps; zero-config. |
| Multiplayer | **Socket.io v4** | The brief's named real-time layer for the browser path; simple, reliable WS for syncing spawns + slices. |
| Server | **Node 22** | Authoritative game server; tiny footprint (no CV/video work). |
| Audio | **Web Audio API** | Procedural SFX — no asset files to ship. |
| Hosting | **Dokploy + Caddy** on a VPS | HTTPS (mandatory for `getUserMedia`) + WebSocket proxy with zero per-app config. |

Full rationale: [`docs/DECISIONS.md`](docs/DECISIONS.md). Original research that
informed the stack: [`docs/camera-fruit-ninja-build-guide.md`](docs/camera-fruit-ninja-build-guide.md).

---

## Project structure

```
client/                      # Vite browser app
  index.html
  src/
    main.js                  # conductor: camera, loop, modes, HUD wiring
    tracking/                # HandTracker (MediaPipe) + OneEuroFilter
    game/                    # Fruit, FruitSpawner, SliceDetector, ScoreManager,
                             #   Game (solo), belts (progression)
    rendering/               # Scene (Three.js), fruitFactory, effects
    net/                     # net.js (Socket.io client) + NetGame (versus controller)
    audio/sfx.js             # procedural sound
  scripts/fetch-assets.mjs   # downloads MediaPipe model + wasm at build time
server/                      # Node + Socket.io authoritative game server
  index.js
docs/                        # research, plan, decisions, brainlift, demo script
Dockerfile                   # client build (Vite → nginx static)
```

---

## Run locally

**Client** (http://localhost:5173):
```bash
cd client
npm install          # also fetches the MediaPipe model + wasm into public/
npm run dev
```
`localhost` is exempt from the HTTPS-camera rule, so the camera works in dev.

**Server** (ws://localhost:2567) — only needed for multiplayer:
```bash
cd server
npm install
npm start
```
Then point the client at it: open `http://localhost:5173/?mp=http://localhost:2567`.

**Two-player local test:** open the client in two windows; create a game in one,
join with the code in the other.

---

## Deployment

Both pieces deploy as Docker images. They currently run on a single VPS via
**Dokploy**, behind **Caddy** which terminates TLS and proxies WebSockets:

- **Client** — `Dockerfile` (repo root): multi-stage Vite build → `nginx:alpine`
  serving static files. MediaPipe model + wasm are fetched at build time and served
  from our own origin with long cache headers. Domain `fruitninja-51-81-34-160.nip.io`.
- **Server** — `server/Dockerfile`: `node:22-alpine` running `index.js` on port
  2567. Domain `fnmp-51-81-34-160.nip.io`.

HTTPS is mandatory (`getUserMedia` refuses non-localhost HTTP). Caddy provides it
automatically via on-demand TLS, and proxies the Socket.io WebSocket with no extra
config. Any host that gives you HTTPS + WebSocket support works (Render, Fly,
Railway, a VPS with nginx/Caddy, etc.).

---

## What makes it interesting (case-study notes)

- **Unfamiliar stack, shipped fast:** 3D rendering, in-browser computer-vision input,
  and real-time authoritative netcode — none of it boilerplate — designed and built
  with AI as the learning engine (see the Brainlift).
- **Performance:** rendering runs at 60fps decoupled from the 30fps camera; hand
  tracking is GPU-accelerated; the network carries only tiny intent messages, so the
  server stays light and latency is dominated by the ~30ms camera pipeline, not the wire.
- **Progression:** belt-rank system (White→Black) gives a persistent sense of advancement.
- **The hard part was *feel*,** not features — see the Brainlift for the jitter/lag
  debugging saga and how it was resolved.
