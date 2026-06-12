# Camera-Controlled Fruit Ninja Clone — Complete Technical Build Guide

> **Target audience:** Claude Code and developers implementing a production-ready browser game.
> Everything in this guide is implementation-ready: concrete library names, version numbers, landmark indices, API call signatures, and architectural decisions with rationale.

---

## Executive Summary

This guide covers every layer of a browser-based, camera-controlled Fruit Ninja clone — from webcam capture and in-browser hand tracking to multiplayer netcode, VPS deployment, and AI asset generation. The game tracks the player's hand via Google MediaPipe Hand Landmarker running entirely on the client side; no model training, no server-side CV, no proprietary hardware. The viral demos circulating on social platforms in 2025 all use exactly this stack. Online multiplayer is feasible through a thin authoritative server (Colyseus or Socket.IO) that synchronises slice events and fingertip positions but never touches video frames.

---

## 1. Viral Demos and Prior Art

The wave of hand-tracked Fruit Ninja clones that went viral in 2024–2025 consistently used MediaPipe running inside the browser with a vanilla-JavaScript or Three.js game layer on top. The most-referenced open-source implementation is [collidingScopes/fruit-ninja on GitHub](https://github.com/collidingScopes/fruit-ninja) — a MIT-licensed project that went live in April 2025 and was announced on the [/r/webdev subreddit](https://www.reddit.com/r/webdev/comments/1k2utux/i_remade_fruit_ninja_using_the_mediapipe/). Its stack is **MediaPipe Hands + Three.js + vanilla JavaScript**, no build step, no framework. The player positions their hand in front of the webcam feed shown on the left side of the screen, and fruits appear on the right; moving the hand quickly triggers a slice.

An earlier and slightly more complex implementation by Charlie Gerard used **PoseNet (TensorFlow.js) + Three.js + Howler.js** and is fully documented in a [dev.to build log from May 2020](https://dev.to/devdevcharlie/motion-controlled-fruit-ninja-game-using-three-js-tensorflow-js-18de). That article documents every challenge: mapping 2D landmark coordinates into Three.js 3D space, raycasting for collision detection, and TrailRendererJS for the blade trail.

A Python/OpenCV-based variant (MediaPipe + OpenCV + Pygame) was shared on LinkedIn by Tuba Khan ([original post](https://www.linkedin.com/posts/tubakhxn_webcamfruitninja-python-opencv-activity-7408794992015683584-0snD)), demonstrating that the same fingertip-as-blade concept works across all environments. A related YouTube tutorial — [Play Fruit Ninja using Hand Gestures with 30 lines of code](https://www.youtube.com/watch?v=LzXzwWi_JF8) — shows a minimal Python implementation in under 15 minutes.

For a JavaScript browser target (which this guide covers), [collidingScopes/fruit-ninja](https://github.com/collidingScopes/fruit-ninja) is the canonical reference. All demos use standard consumer laptop webcams — no depth sensors, no specialised hardware. The tracking technology in every viral demo is **MediaPipe-class computer vision, not generative AI**.

---

## 2. Hand Tracking Models — No Training Required

### 2.1 Confirmed: Zero Custom Model Training Needed

This project uses **pre-trained, in-browser inference only**. Google MediaPipe ships a bundled `.task` model file that was trained on ~30,000 real-world images plus synthetic data. You download the binary, point the API at it, and start detecting in three lines of JavaScript. There is no dataset to collect, no GPU cluster to rent, no training loop to write.

### 2.2 The 21-Landmark Hand Skeleton

MediaPipe detects 21 landmarks per hand, numbered 0–20 ([Google AI Edge documentation](https://developers.google.com/edge/mediapipe/solutions/vision/hand_landmarker)). The layout follows the anatomical finger structure:

| Index | Name | Usage in Fruit Ninja |
|---|---|---|
| 0 | WRIST | Anchor point |
| 4 | THUMB_TIP | Optional second blade point |
| 5 | INDEX_FINGER_MCP | Knuckle |
| **8** | **INDEX_FINGER_TIP** | **Primary blade point** |
| 12 | MIDDLE_FINGER_TIP | Alternative blade |
| 16 | RING_FINGER_TIP | — |
| 20 | PINKY_TIP | — |

In JavaScript, landmark 8 is `results.landmarks[handIndex][8]`, which returns `{ x, y, z }` normalised to `[0, 1]` range by image width/height. Multiply `x` by `canvas.width` and `y` by `canvas.height` to get pixel coordinates. The `z` value is depth relative to the wrist; smaller values are closer to the camera. For a 2D Fruit Ninja game, only `x` and `y` are needed.

### 2.3 Option A — `@mediapipe/tasks-vision` (Recommended)

The current production API from Google is the Tasks Vision package ([npm: `@mediapipe/tasks-vision`](https://www.npmjs.com/package/@mediapipe/tasks-vision), latest: `0.10.22-rc.20250304`). This is the **recommended choice** for a new project.

**Installation:**
```bash
npm install @mediapipe/tasks-vision
```

**Or via CDN (no build step):**
```html
<script src="https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision/vision_bundle.mjs"
        crossorigin="anonymous" type="module"></script>
```

**Minimal setup (VIDEO / LIVE_STREAM mode):**
```javascript
import { HandLandmarker, FilesetResolver } from "@mediapipe/tasks-vision";

const vision = await FilesetResolver.forVisionTasks(
  "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm"
);

const handLandmarker = await HandLandmarker.createFromOptions(vision, {
  baseOptions: {
    modelAssetPath:
      "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task",
    delegate: "GPU",          // fall back to "CPU" if WebGPU unavailable
  },
  runningMode: "VIDEO",       // use detectForVideo() in render loop
  numHands: 2,                // track both hands for local multiplayer
  minHandDetectionConfidence: 0.5,
  minHandPresenceConfidence:  0.5,
  minTrackingConfidence:      0.5,
});
```

**Per-frame detection (inside requestAnimationFrame loop):**
```javascript
const nowMs = performance.now();
if (video.currentTime !== lastVideoTime) {
  const results = handLandmarker.detectForVideo(video, nowMs);
  lastVideoTime = video.currentTime;
  processLandmarks(results);
}
```

`results.landmarks` is an array with one entry per detected hand. `results.handedness` gives `"Left"` / `"Right"`. With `numHands: 2`, both arrays can contain up to two elements simultaneously.

**Configuration options** ([official docs](https://developers.google.com/edge/mediapipe/solutions/vision/hand_landmarker/web_js)):

| Option | Range | Default | Notes |
|---|---|---|---|
| `numHands` | `> 0` | `1` | Set to `2` for local/same-camera multiplayer |
| `minHandDetectionConfidence` | 0–1 | 0.5 | Palm detector threshold |
| `minHandPresenceConfidence` | 0–1 | 0.5 | Controls when re-detection fires |
| `minTrackingConfidence` | 0–1 | 0.5 | IoU threshold for bounding-box tracking |
| `delegate` | `"GPU"` / `"CPU"` | `"CPU"` | Use `"GPU"` for WASM/WebGPU acceleration |

**Model file:** The `.task` bundle is a float16-quantised archive containing both a palm detection model (192×192 or 224×224 input) and a 21-landmark regression model. Total size on disk is approximately **6.75 MB** for the palm detector and **7.70 MB** for the landmark detector, per [Qualcomm AI Hub specs](https://aihub.qualcomm.com/models/mediapipe_hand) — roughly 14–15 MB total download, loaded once and cached by the browser.

**Performance:** On a Pixel 6 mobile device, latency is 17.12 ms (CPU) / 12.27 ms (GPU), per [Google's benchmark table](https://developers.google.com/edge/mediapipe/solutions/vision/hand_landmarker). On a mid-range consumer laptop with WASM/WebGPU, real-world measurements reported in a [2026 research paper on MediaPipe visualisation](https://wjarr.com/sites/default/files/fulltext_pdf/WJARR-2026-0860.pdf) show consistent 28–30 FPS at under 35 ms end-to-end latency. On older hardware with CPU-only WASM, expect 15–20 FPS.

**Licence:** Apache 2.0 — free for commercial use.

### 2.4 Option B — TensorFlow.js `hand-pose-detection`

The `@tensorflow-models/hand-pose-detection` package wraps the same MediaPipe model through the TF.js runtime ([npm](https://www.npmjs.com/package/@tensorflow-models/handpose), [TF.js blog post](https://blog.tensorflow.org/2021/11/3D-handpose.html)). It gained two-hand support in 2021. It provides identical 21 landmarks through the TF.js backend system, which supports WebGL, WASM, and WebGPU.

### 2.5 Model Comparison Table

| Criterion | `@mediapipe/tasks-vision` (Tasks API) | `@tensorflow-models/hand-pose-detection` (TF.js) |
|---|---|---|
| **Package** | `@mediapipe/tasks-vision` | `@tensorflow-models/hand-pose-detection` + `@tensorflow/tfjs-backend-webgl` |
| **API style** | Google Tasks API, `detectForVideo()` | TF.js model, `estimateHands()` |
| **Landmarks** | 21 per hand, `results.landmarks[i][j]` | 21 per hand, `hands[i].keypoints[j]` |
| **Multi-hand** | `numHands: 2` | `maxHands: 2` in estimator config |
| **GPU backend** | WebGPU delegate, `delegate: "GPU"` | WebGL (`@tensorflow/tfjs-backend-webgl`) |
| **Model file size** | ~15 MB total bundle | ~13 MB (MediaPipe backend) |
| **Benchmark (laptop)** | 28–30 FPS mid-range | 20–25 FPS typical |
| **Licence** | Apache 2.0 | Apache 2.0 |
| **Maintenance** | Actively updated by Google, v0.10.x | Active, but Tasks API is the strategic direction |
| **WASM offthread** | Via Web Worker (manual) | Via Web Worker (manual) |
| **Recommendation** | ✅ **Use this** | Acceptable fallback |

**Verdict:** Use `@mediapipe/tasks-vision` with `delegate: "GPU"`. It is the API Google is actively developing, has the best performance, and is what all 2024–2025 viral demos use. TF.js `hand-pose-detection` is a viable fallback if you need deeper integration with other TF.js models.

---

## 3. Game Engine and Browser Stack

### 3.1 Camera Setup (`getUserMedia`)

`navigator.mediaDevices.getUserMedia` is gated behind a [secure context (HTTPS)](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia) in all modern browsers — `localhost` is the only HTTP exception. This has a direct implication for deployment (see Section 6).

```javascript
const stream = await navigator.mediaDevices.getUserMedia({
  audio: false,
  video: {
    facingMode: "user",    // front camera
    width: { ideal: 1280 },
    height: { ideal: 720 },
    frameRate: { ideal: 30 },
  },
});
const video = document.getElementById("webcam");
video.srcObject = stream;
await new Promise(resolve => (video.onloadedmetadata = resolve));
video.play();
```

**Mirror the video for natural UX:** Apply CSS `transform: scaleX(-1)` to the `<video>` element. Apply the same flip to your canvas overlay so landmark positions match what the player sees. If you flip only the video and not the canvas, landmark 8 will appear on the wrong side. Note that MediaPipe `handedness` labels are **mirrored** by default when the camera is front-facing — `"Right"` from the API means the player's right hand.

### 3.2 Render Loop — `requestVideoFrameCallback` vs `requestAnimationFrame`

The standard [MDN page on `requestVideoFrameCallback`](https://developer.mozilla.org/en-US/docs/Web/API/HTMLVideoElement/requestVideoFrameCallback) explains that this API fires a callback **when a new video frame arrives at the compositor**, with frame metadata (timestamp, presentedFrames). This makes it superior to `requestAnimationFrame` for video-synchronised processing.

| Approach | Pro | Con |
|---|---|---|
| `requestAnimationFrame` | Universal support, simple | Fires at display refresh (60/144 Hz), not video frame rate (usually 30 fps); wastes CPU running MediaPipe on duplicate frames |
| `requestVideoFrameCallback` | Fires exactly once per new video frame; provides accurate `presentedFrames` counter | Safari partial support; need polyfill or fallback |

**Recommended pattern:**
```javascript
function processFrame(now, metadata) {
  const results = handLandmarker.detectForVideo(video, now);
  updateGameState(results, now);
  renderScene();
  video.requestVideoFrameCallback(processFrame);
}
video.requestVideoFrameCallback(processFrame);
```

Fall back to `requestAnimationFrame` with a `video.currentTime !== lastTime` guard on unsupported browsers, as shown in the [Google Developers article](https://web.dev/articles/requestvideoframecallback-rvfc).

### 3.3 Rendering: Canvas 2D vs PixiJS vs Three.js

| Library | Bundle Size | Performance | Good for Fruit Ninja if… |
|---|---|---|---|
| **Canvas 2D API** | 0 KB (native) | ~1,000 sprites at 60 FPS | Simple prototype; no particles needed |
| **[PixiJS v8](https://pixijs.com)** | ~400 KB | 10,000+ sprites GPU-accelerated | You want sprites, particles, WebGL perf without 3D |
| **[Three.js r170+](https://threejs.org)** | ~600 KB | Full 3D; 60 FPS with proper culling | You want 3D fruit models like collidingScopes |

**Recommendation:** For a faithful Fruit Ninja clone with 3D fruit models and particle explosions, **Three.js** is the proven choice (used by collidingScopes, Charlie Gerard's demo). For a 2D sprite-based version that is easier to implement for multiplayer, **PixiJS** is better — its WebGL renderer handles hundreds of sprites, particle trails, and UI at 60 FPS on integrated graphics, and its API is simpler than Three.js. Canvas 2D is sufficient for a prototype but particle effects will cause frame drops at high object counts.

For this guide, the **PixiJS path** is recommended for the full game because:
- Multiplayer synchronisation is easier with 2D sprites (no 3D projection needed for opponent positions).
- Blade trail rendering is straightforward with PixiJS Graphics or the `@pixi/particle-emitter` plugin.
- No need for a coordinate mapping step (unlike the 3D path where 2D landmarks must be unprojected into Three.js world space).

### 3.4 Slice Detection Algorithm

Slice detection is the core gameplay mechanic. The correct approach is **line-segment vs. circle intersection**, not point-in-circle.

**Step 1 — Fingertip velocity.** Compute pixel-space velocity between the current and previous frame positions of landmark 8. Only register a slice if the velocity magnitude exceeds a threshold (empirically ~150–300 pixels/second). This prevents accidental slices from a stationary hand.

```javascript
const dx = currX - prevX;
const dy = currY - prevY;
const speed = Math.sqrt(dx*dx + dy*dy) / deltaTime; // pixels per ms
const isSlicing = speed > 0.15;  // 150 px/s threshold
```

**Step 2 — Line-segment vs. circle intersection.** The line segment runs from the previous fingertip position `(x0, y0)` to the current `(x1, y1)`. Each fruit is a circle at `(cx, cy)` with radius `r`. The algorithm ([Stack Overflow reference](https://stackoverflow.com/questions/10957689/collision-detection-between-a-line-and-a-circle-in-javascript), [mattdesl/line-circle-collision npm module](https://github.com/mattdesl/line-circle-collision)) finds the closest point on the segment to the circle centre and checks if that distance is less than `r`:

```javascript
function lineCircleIntersects(x0, y0, x1, y1, cx, cy, r) {
  const dx = x1 - x0, dy = y1 - y0;
  const fx = x0 - cx, fy = y0 - cy;
  const a = dx*dx + dy*dy;
  const b = 2*(fx*dx + fy*dy);
  const c = fx*fx + fy*fy - r*r;
  let discriminant = b*b - 4*a*c;
  if (discriminant < 0) return false;
  discriminant = Math.sqrt(discriminant);
  const t1 = (-b - discriminant) / (2*a);
  const t2 = (-b + discriminant) / (2*a);
  return (t1 >= 0 && t1 <= 1) || (t2 >= 0 && t2 <= 1);
}
```

**Step 3 — Slice event.** When intersection is detected AND `isSlicing` is true, fire a slice event: split the fruit sprite, spawn juice particles, increment score, play sound. Attach `sliced = true` to the fruit object to prevent double-counting.

### 3.5 Landmark Smoothing — One Euro Filter

Raw MediaPipe output jitters by ±2–5 pixels per frame due to sensor noise. For a game where the blade trail must look smooth, this jitter is visible and distracting. The [One Euro Filter](https://github.com/casiez/OneEuroFilter) is the standard solution in interactive CV applications.

The 1€ filter is a low-pass filter with an **adaptive cutoff frequency**: at low speeds (stationary hand), the cutoff is low (heavy smoothing); at high speeds (slicing), the cutoff rises (low lag). This dual behaviour is exactly what Fruit Ninja needs — a steady hand should show a stable blade point, but a fast swipe should respond instantly.

```javascript
class OneEuroFilter {
  constructor(freq, minCutoff = 1.0, beta = 0.007, dCutoff = 1.0) {
    this.freq = freq;
    this.minCutoff = minCutoff;
    this.beta = beta;
    this.dCutoff = dCutoff;
    this.x = null;
    this.dx = 0;
  }
  _alpha(cutoff) {
    const te = 1.0 / this.freq;
    const tau = 1.0 / (2 * Math.PI * cutoff);
    return 1.0 / (1.0 + tau / te);
  }
  filter(x) {
    if (this.x === null) { this.x = x; return x; }
    const prev = this.x;
    const dxRaw = (x - prev) * this.freq;
    this.dx += this._alpha(this.dCutoff) * (dxRaw - this.dx);
    const cutoff = this.minCutoff + this.beta * Math.abs(this.dx);
    this.x += this._alpha(cutoff) * (x - this.x);
    return this.x;
  }
}

// Instantiate one filter per coordinate per hand
const filterX = new OneEuroFilter(30, 1.0, 0.007);
const filterY = new OneEuroFilter(30, 1.0, 0.007);

// Apply each frame
const smoothX = filterX.filter(rawX);
const smoothY = filterY.filter(rawY);
```

Alternatively, a simpler **Exponential Moving Average (EMA)** works for a prototype: `smoothed = alpha * raw + (1 - alpha) * prev` with `alpha ≈ 0.4`. EMA adds lag at high speeds, so 1€ is preferred for release quality.

### 3.6 Blade Trail Rendering

The blade trail is visually essential for Fruit Ninja feel. The canonical canvas technique is to **not fully clear the canvas on each frame** but instead overdraw with a semi-transparent fill:

```javascript
// At the start of each frame instead of ctx.clearRect:
ctx.fillStyle = "rgba(0, 0, 0, 0.15)";  // adjust alpha for trail length
ctx.fillRect(0, 0, canvas.width, canvas.height);
```

For a more polished trail, maintain a **ring buffer** of the last N fingertip positions and draw a tapered polyline:

```javascript
const trail = [];  // [{x, y}, ...]
const TRAIL_LEN = 20;

function drawTrail(ctx) {
  for (let i = 1; i < trail.length; i++) {
    const t = i / trail.length;
    ctx.lineWidth = t * 8;
    ctx.strokeStyle = `hsla(50, 100%, 70%, ${t})`;
    ctx.beginPath();
    ctx.moveTo(trail[i-1].x, trail[i-1].y);
    ctx.lineTo(trail[i].x, trail[i].y);
    ctx.stroke();
  }
}
```

In PixiJS, use a `Graphics` object with `lineTo` per frame, or integrate `@pixi/particle-emitter` (v5+) for GPU-accelerated spark particles along the trail. Three.js projects use `TrailRendererJS` (referenced in Charlie Gerard's [dev.to tutorial](https://dev.to/devdevcharlie/motion-controlled-fruit-ninja-game-using-three-js-tensorflow-js-18de)) or a custom `TubeGeometry` built from the last N positions.

### 3.7 Fruit Physics — Spawn Arcs and Gravity

Fruit Ninja's original mechanics are straightforward projectile motion ([YouTube physics analysis](https://www.youtube.com/watch?v=ER_YHs29tXQ)): each fruit launches from the bottom edge with an initial velocity `(vx, vy)` and is subject to constant downward gravity `g`. Each frame:

```javascript
class Fruit {
  constructor() {
    this.x = Math.random() * GAME_WIDTH;
    this.y = GAME_HEIGHT + 50;
    this.vx = (Math.random() - 0.5) * 400;   // px/s
    this.vy = -(500 + Math.random() * 300);   // upward
    this.radius = 45 + Math.random() * 20;
    this.sliced = false;
    this.type = pickRandom(["watermelon", "apple", "banana", "bomb"]);
  }
  update(dt) {  // dt in seconds
    this.vy += GRAVITY * dt;   // GRAVITY ≈ 980 px/s²
    this.x += this.vx * dt;
    this.y += this.vy * dt;
  }
  isOffScreen() { return this.y > GAME_HEIGHT + 100; }
}
```

**Spawner:** A timer function fires every 1.0–0.5 seconds (decreasing with score, for difficulty). Each spawn picks 1–3 fruits at slightly different angles to create a fan. Bombs appear with ~15% probability.

**Sliced fruit animation:** On slice, replace the fruit with two half-sprites (or Two.js/PixiJS sprites with a clip mask) that fly apart with opposite horizontal velocities, decelerating under gravity. Juice particle burst: 8–12 particles at random angles with short lifetime (~0.3 s), colour-coded to the fruit type.

**Lives system:** If a fruit exits the bottom without being sliced, decrement lives. 5 lives standard, game-over at 0.

**Combo:** Track the number of fruits sliced within a 0.5 s window. Combo multiplier: 2× for 3 simultaneous, 3× for 4, etc. Display combo text with a large, fading label.

### 3.8 Web Worker Offloading

`detectForVideo()` runs synchronously on the main thread and can consume 20–30 ms per frame. On slow hardware this blocks UI rendering. Move MediaPipe inference to a Web Worker via `OffscreenCanvas` to keep the main thread free for rendering:

```javascript
// worker.js
importScripts("https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision/vision_bundle.mjs");
let handLandmarker;
// ... init ...
self.onmessage = async ({ data: { bitmap, ts } }) => {
  const results = handLandmarker.detectForVideo(bitmap, ts);
  self.postMessage({ landmarks: results.landmarks, handedness: results.handedness });
  bitmap.close();
};

// main.js
const worker = new Worker("worker.js");
worker.onmessage = ({ data }) => updateGameFromLandmarks(data);
video.requestVideoFrameCallback((now, meta) => {
  const bitmap = video.captureStream
    ? canvas.transferControlToOffscreen()
    : await createImageBitmap(video);
  worker.postMessage({ bitmap, ts: now }, [bitmap]);
});
```

This pattern adds ~1 frame of latency but prevents MediaPipe from blocking the game render loop.

---

## 4. Multiplayer Architecture

### 4.1 Local Same-Camera Multiplayer (Two Hands)

The simplest form of multiplayer uses two tracked hands on one webcam. Set `numHands: 2` in HandLandmarker options. The `results.handedness` array gives `"Left"` or `"Right"` for each detected hand (mirror-flipped for front cameras). Assign Player 1 to the left hand and Player 2 to the right hand. No networking required — both blades are driven by the same MediaPipe output array, and the game engine applies slice detection independently for each fingertip. This is identical to the local multiplayer mode in the original Fruit Ninja tablet version.

### 4.2 Online Multiplayer Architecture Overview

Online multiplayer requires a thin server. The critical design constraint is:

> **NEVER transmit video frames over the network. Hand tracking runs client-side on each player's machine. Only slice events and (optionally) smoothed fingertip positions are synced.**

Video frames are 1280×720 × 3 bytes × 30 fps ≈ 83 MB/s uncompressed. Even H.264-compressed, streaming a webcam feed to every opponent is untenable latency-wise and resource-intensive. MediaPipe produces two `(x, y)` coordinates per hand per frame: that is 16 bytes — five orders of magnitude smaller.

**What to sync:**
- `SLICE_EVENT { handId, fruitId, timestamp, scoreInc }` — authoritative slice confirmation
- `BLADE_POS { handId, x, y, timestamp }` — fingertip position (for opponent's ghost blade trail)
- `FRUIT_SPAWN { fruitId, type, x, y, vx, vy, spawnTs }` — server-driven spawn so both clients show the same fruits

**What NOT to sync:**
- Video frames
- Raw landmark arrays (21 × 2 floats per hand is 336 bytes/frame × 30 fps = ~10 KB/s per player — acceptable if needed, but only `landmark[8]` is needed for slicing)

### 4.3 Netcode Options Comparison

| Framework | Transport | Architecture | Latency | Complexity | Best For |
|---|---|---|---|---|---|
| **[Socket.IO v4](https://socket.io)** | WS + HTTP fallback | Flexible | ~30–80 ms | Low | Prototyping, small player counts |
| **[Colyseus v0.15](https://colyseus.io)** | WS (uWS under hood) | Authoritative rooms + schema state sync | ~20–60 ms | Medium | Production game servers with rooms, matchmaking |
| **[uWebSockets.js](https://github.com/uNetworking/uWebSockets.js)** | Raw WS, C++ binding | DIY | ~10–40 ms | High | Max throughput, 10 000+ connections |
| **WebRTC Data Channel** | UDP (DTLS) | P2P or SFU | ~10–30 ms | High | P2P; complex NAT traversal (~20% need TURN) |

**Recommendation:** Use **Colyseus** for a production build. It provides authoritative room management, schema-based delta state synchronisation (only diffs are sent), built-in matchmaking (`joinOrCreate`), and a clean JS/TS SDK for the browser client — all through a single `npm create colyseus-app@latest` scaffold ([Colyseus docs](https://docs.colyseus.io)). Socket.IO is faster to get started with but lacks built-in room state synchronisation.

WebRTC data channels offer lower latency (UDP, not TCP), but ~20% of connections require a TURN server due to NAT traversal failures, and the setup complexity is significant ([Reddit analysis](https://www.reddit.com/r/gamedev/comments/1eijh7t/webrtc_vs_websockets_for_browserbased_coop_game/)). For a Fruit Ninja clone where 20–60 ms latency is perfectly fine (slicing a fruit is a 200–400 ms motion), WebSockets via Colyseus or Socket.IO are the right choice.

### 4.4 Authoritative Server vs. Shared-Seed Deterministic Spawning

**Authoritative server (recommended):**
The server owns the canonical game state: which fruits exist, their current positions, scores. Clients send `SLICE_ATTEMPT` messages; the server validates and broadcasts confirmed `SLICE_EVENT`. Fruit spawns are triggered by the server with a timestamp so both clients start animating from the same initial position. This is standard game netcode as documented in the [Authoritative Multiplayer series](https://archive.jlongster.com/Making-Web-Games--5--Authoritative-Server).

```typescript
// Colyseus Room (server-side, TypeScript)
import { Room, Client } from "@colyseus/core";
import { Schema, MapSchema, ArraySchema, type } from "@colyseus/schema";

class Fruit extends Schema {
  @type("string") id: string = "";
  @type("string") fruitType: string = "apple";
  @type("number") x: number = 0;
  @type("number") y: number = 0;
  @type("number") vx: number = 0;
  @type("number") vy: number = 0;
  @type("number") spawnTs: number = 0;
  @type("boolean") sliced: boolean = false;
}

class Player extends Schema {
  @type("number") score: number = 0;
  @type("number") lives: number = 5;
  @type("number") bladeX: number = -1;
  @type("number") bladeY: number = -1;
}

class GameState extends Schema {
  @type({ map: Player }) players = new MapSchema<Player>();
  @type({ map: Fruit }) fruits = new MapSchema<Fruit>();
}

export class FruitNinjaRoom extends Room {
  maxClients = 2;
  state = new GameState();
  private spawnTimer!: ReturnType<typeof setInterval>;

  onCreate() {
    this.setSimulationInterval((dt) => this.gameLoop(dt), 1000 / 20); // 20 Hz tick
    this.spawnTimer = setInterval(() => this.spawnFruit(), 1200);

    this.onMessage("slice_attempt", (client, { fruitId, bladeX, bladeY }) => {
      const fruit = this.state.fruits.get(fruitId);
      if (fruit && !fruit.sliced) {
        fruit.sliced = true;
        const player = this.state.players.get(client.sessionId)!;
        player.score += 1;
      }
    });

    this.onMessage("blade_pos", (client, { x, y }) => {
      const player = this.state.players.get(client.sessionId)!;
      player.bladeX = x;
      player.bladeY = y;
    });
  }

  gameLoop(dt: number) {
    // Remove sliced or offscreen fruits
    this.state.fruits.forEach((fruit, id) => {
      if (fruit.sliced || this.isOffscreen(fruit)) {
        this.state.fruits.delete(id);
      }
    });
  }

  spawnFruit() {
    const fruit = new Fruit();
    fruit.id = Math.random().toString(36).slice(2);
    fruit.fruitType = Math.random() < 0.15 ? "bomb" : "apple";
    fruit.x = 0.1 + Math.random() * 0.8;
    fruit.y = 1.1;
    fruit.vx = (Math.random() - 0.5) * 0.4;
    fruit.vy = -(0.5 + Math.random() * 0.3);
    fruit.spawnTs = this.clock.currentTime;
    this.state.fruits.set(fruit.id, fruit);
  }

  onJoin(client: Client) {
    this.state.players.set(client.sessionId, new Player());
  }

  onLeave(client: Client) {
    this.state.players.delete(client.sessionId);
  }

  isOffscreen(fruit: Fruit): boolean {
    const elapsed = (this.clock.currentTime - fruit.spawnTs) / 1000;
    const y = fruit.y + fruit.vy * elapsed + 0.5 * 0.98 * elapsed * elapsed;
    return y > 1.5;
  }
}
```

**Shared-seed deterministic approach (alternative):**
Both clients share an initial PRNG seed and run identical simulation code. No server-side fruit positions needed — only slice confirmations are exchanged. This reduces server bandwidth but requires bitwise-identical float arithmetic (avoid `Math.random()`, use a seeded PRNG like `mulberry32`). Harder to implement correctly; the authoritative approach is recommended unless you specifically need P2P.

### 4.5 Tick Rate, Latency Compensation, and Interpolation

**Server tick rate:** 20 Hz is sufficient for Fruit Ninja. Unlike an FPS, fruit positions are deterministic given spawn parameters — the client can simulate physics locally and the server only needs to validate slices. Blade positions can be sent at 30 Hz on the client without requiring server processing each frame.

**Latency for opponent blade trail:** When rendering the opponent's blade trail, apply **linear interpolation** between the last two received positions, delayed by one packet interval (e.g., 50 ms buffer). This smooths the trail despite jitter:

```javascript
// Store received opponent positions with timestamps
const opponentHistory = []; // [{x, y, ts}, ...]

function getInterpolatedOpponentBlade(renderTs) {
  const target = renderTs - 50; // 50 ms render delay
  for (let i = 0; i < opponentHistory.length - 1; i++) {
    const a = opponentHistory[i];
    const b = opponentHistory[i+1];
    if (a.ts <= target && target <= b.ts) {
      const t = (target - a.ts) / (b.ts - a.ts);
      return { x: a.x + t*(b.x-a.x), y: a.y + t*(b.y-a.y) };
    }
  }
  return opponentHistory.at(-1) ?? { x: -1, y: -1 };
}
```

**Client-side prediction for own blade:** Do not delay the local player's blade — it must feel instant. Apply One Euro filtering locally and send `blade_pos` to the server at 30 Hz as a background task. The server state is used only for validation, not for driving local rendering.

### 4.6 Spectating Opponent's Blade Trail

Each player receives the opponent's `bladeX`, `bladeY` updates from the Colyseus state diff. Render a second, visually distinct trail (e.g., blue instead of yellow, with a ghost/transparent tint) using the same polyline technique but with the interpolated opponent position. Label the trail with the opponent's name or score.

---

## 5. VPS Deployment

### 5.1 HTTPS Is Non-Negotiable

`getUserMedia` returns a `NotAllowedError` on any non-localhost HTTP origin ([MDN security note](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia)). HTTPS is mandatory for production. Use [Let's Encrypt](https://letsencrypt.org) with Certbot — free TLS certificates with auto-renewal.

### 5.2 Server Sizing

Because hand tracking is fully client-side, the server does not process any video or CV workload. Its only jobs are:
1. Serving static files (HTML, JS, model `.task` file)
2. Running the Colyseus WebSocket server (~2–5 KB RAM per connection)
3. Maintaining room state (fruit positions, scores)

**Recommended spec:** A $6–12/month VPS with 1 vCPU, 1–2 GB RAM is sufficient for 100+ concurrent players. The bottleneck will be WebSocket connections (file descriptor limit), not CPU.

### 5.3 Project Structure

```
fruit-ninja/
├── client/
│   ├── index.html
│   ├── src/
│   │   ├── main.js          # Entry point, getUserMedia, MediaPipe init
│   │   ├── game.js          # Game loop, fruit spawner, scoring
│   │   ├── tracking.js      # HandLandmarker wrapper, One Euro filter
│   │   ├── renderer.js      # PixiJS scene, blade trail, particles
│   │   ├── netcode.js       # Colyseus client, state sync
│   │   └── worker.js        # Optional Web Worker for MediaPipe
│   └── assets/
│       ├── sprites/         # Fruit PNG sprites (see Section 7)
│       └── sounds/          # Slice, combo, bomb sounds
├── server/
│   ├── src/
│   │   ├── index.ts         # Colyseus server entry
│   │   └── rooms/
│   │       └── FruitNinjaRoom.ts
│   ├── package.json
│   └── tsconfig.json
├── nginx/
│   └── default.conf
├── docker-compose.yml
└── package.json             # Root monorepo or workspace scripts
```

### 5.4 Nginx WebSocket Reverse Proxy Configuration

The [NGINX WebSocket proxying guide](https://www.f5.com/company/blog/nginx/websocket-nginx) and [Socket.IO reverse proxy docs](https://socket.io/docs/v3/reverse-proxy/) specify the required headers to upgrade HTTP connections to WebSocket:

```nginx
# /etc/nginx/sites-available/fruit-ninja
server {
    listen 80;
    server_name yourdomain.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl;
    server_name yourdomain.com;

    ssl_certificate     /etc/letsencrypt/live/yourdomain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/yourdomain.com/privkey.pem;

    # Serve static client files
    root /var/www/fruit-ninja/client/dist;
    index index.html;
    location / {
        try_files $uri $uri/ /index.html;
    }

    # Serve the MediaPipe .task model file with caching
    location ~* \.(task|wasm)$ {
        expires 30d;
        add_header Cache-Control "public, immutable";
    }

    # Proxy Colyseus WebSocket server
    location /colyseus/ {
        proxy_pass http://localhost:2567/;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 86400s;   # Keep WS alive
        proxy_send_timeout 86400s;
    }
}
```

### 5.5 Docker Compose Setup

```yaml
# docker-compose.yml
version: "3.9"
services:
  server:
    build: ./server
    restart: unless-stopped
    ports:
      - "2567:2567"
    environment:
      - NODE_ENV=production
  nginx:
    image: nginx:alpine
    restart: unless-stopped
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./nginx/default.conf:/etc/nginx/conf.d/default.conf
      - ./client/dist:/var/www/fruit-ninja/client/dist
      - /etc/letsencrypt:/etc/letsencrypt:ro
    depends_on:
      - server
```

**Certbot:** Run once on the host before starting Docker:
```bash
certbot certonly --standalone -d yourdomain.com
```
Then mount `/etc/letsencrypt` into the nginx container as shown above. Auto-renew via cron: `0 3 * * * certbot renew --quiet`.

### 5.6 Node.js Server Package

The Colyseus server (`server/package.json`):
```json
{
  "dependencies": {
    "colyseus":       "^0.15.0",
    "@colyseus/core": "^0.15.0",
    "@colyseus/schema": "^2.0.0"
  },
  "devDependencies": {
    "typescript": "^5.4.0"
  },
  "scripts": {
    "start": "ts-node src/index.ts",
    "build": "tsc"
  }
}
```

---

## 6. Higgsfield AI — Role in This Project

### 6.1 What Higgsfield Is

[Higgsfield AI](https://higgsfield.ai) is a **web-based AI video and image generation platform** — not a computer vision library, not a hand tracking system, and not a game engine. It provides access to 15+ image models (Soul, Nano Banana Pro, FLUX, Seedream, GPT Image) and 16+ video models (Sora 2, Veo 3.1, Kling 3.0, Seedance 2.0) through a unified web UI and API ([Higgsfield AI image generator page](https://higgsfield.ai/ai-image)).

The viral hand-tracking Fruit Ninja demos have **nothing to do with Higgsfield**. Those demos use MediaPipe or TensorFlow.js for computer vision, as documented in every source in this guide.

### 6.2 Does a Higgsfield MCP Exist?

Yes. Higgsfield shipped an official MCP (Model Context Protocol) server on April 30, 2026, at `https://mcp.higgsfield.ai/mcp` ([Higgsfield CLI/MCP documentation](https://higgsfield.ai/cli), [claudefa.st writeup](https://claudefa.st/blog/tools/mcp-extensions/higgsfield-mcp)). It works with Claude Code, Cursor, Codex, and any MCP-compatible agent. A community wrapper also exists at [geopopos/higgsfield_ai_mcp on GitHub](https://github.com/geopopos/higgsfield_ai_mcp).

**Setup in Claude Code:**
1. Open Settings → Connectors
2. Add connector name `Higgsfield`, URL `https://mcp.higgsfield.ai/mcp`
3. Authenticate with your Higgsfield account (no API key needed)
4. Credits from your existing plan are usable immediately

### 6.3 Higgsfield's Legitimate Role in This Project

Higgsfield is appropriate for **generative art assets and trailers**, not for game logic:

| Asset Type | Prompt Example | Best Higgsfield Model |
|---|---|---|
| Watermelon sprite sheet | "Cartoon watermelon, transparent PNG, multiple sliced states, game art style" | Nano Banana Pro (4K, text/transparency support) |
| Bomb sprite | "Round black bomb with fuse, game sprite, white background" | Soul 2.0 or FLUX |
| Background images | "Dojo interior, Japanese style, soft bokeh, game background" | Seedream 4.0 |
| Juice particle texture | "Splatter of red juice, isolated on white, vector-style" | Nano Banana Pro |
| Game trailer | "Hands slicing fruit in a glowing neon dojo, cinematic, 4K" | Kling 3.0 or Veo 3.1 |
| App store screenshots | "Browser game UI mockup with watermelon and score counter" | Soul 2.0 |

**Important:** Higgsfield generates still images and short video clips. The real-time hand tracking in your game is performed by MediaPipe running in the player's browser. Do not attempt to route webcam frames through Higgsfield — it is a batch generation service, not a real-time CV pipeline.

---

## 7. Claude Code Workflow

### 7.1 Recommended Repository Structure

```
fruit-ninja/
├── client/                   # Vite (or no-build) browser app
│   ├── index.html
│   ├── vite.config.js        # If using Vite
│   ├── public/
│   │   └── models/
│   │       └── hand_landmarker.task   # Downloaded once, committed to repo
│   └── src/
│       ├── main.js
│       ├── tracking/
│       │   ├── HandTracker.js         # HandLandmarker wrapper
│       │   ├── OneEuroFilter.js       # 1€ smoothing
│       │   └── tracking.worker.js    # Optional offthread Worker
│       ├── game/
│       │   ├── GameLoop.js            # rVFC loop, delta time
│       │   ├── Fruit.js               # Fruit entity, physics
│       │   ├── FruitSpawner.js        # Spawn timer, difficulty curve
│       │   ├── SliceDetector.js       # Line-circle intersection
│       │   ├── ScoreManager.js        # Combos, lives, high score
│       │   └── SoundManager.js        # Howler.js wrapper
│       ├── rendering/
│       │   ├── Renderer.js            # PixiJS Application wrapper
│       │   ├── BladeTrail.js          # Trail ring buffer + draw
│       │   └── ParticleSystem.js      # Juice particles
│       └── net/
│           ├── ColyseusClient.js      # Room join, state callbacks
│           └── schema.js              # Client-side schema mirrors
├── server/
│   ├── src/
│   │   ├── index.ts
│   │   ├── app.config.ts
│   │   └── rooms/
│   │       ├── FruitNinjaRoom.ts
│   │       └── GameState.ts           # Colyseus Schema definitions
│   ├── tsconfig.json
│   └── package.json
├── assets/
│   ├── sprites/              # Fruit PNGs (Higgsfield-generated)
│   └── sounds/               # Slice/combo/bomb audio
├── nginx/
│   └── default.conf
├── docker-compose.yml
└── README.md
```

### 7.2 Build Order (Milestones)

**Milestone 1 — Camera + Tracking (1–2 days)**
- `index.html` with `<video>` (mirrored) + `<canvas>` overlay
- `getUserMedia` setup with 720p constraint
- `HandTracker.js`: init HandLandmarker, `detectForVideo` in rVFC loop
- Render landmark 8 as a small dot on canvas to verify tracking works
- One Euro filter applied to (x, y)

**Milestone 2 — Single-Player Prototype (2–3 days)**
- `Fruit.js` with physics update; `FruitSpawner.js` timed spawning
- `SliceDetector.js` with line-circle intersection
- Score/lives display; game-over screen
- `BladeTrail.js` ring buffer rendering
- Juice particle burst on slice

**Milestone 3 — Full Single-Player Polish (1–2 days)**
- PixiJS integration (replace Canvas 2D)
- Fruit sprites (Higgsfield-generated PNGs or placeholders)
- Bomb mechanic (subtract life, no score)
- Combo detection and display
- Sound effects (Howler.js)
- Progressive difficulty (spawn rate increases)

**Milestone 4 — Local Two-Hand Multiplayer (0.5 days)**
- `numHands: 2` in HandLandmarker
- Split-screen or shared-screen two-blade mode
- Assign colours per hand

**Milestone 5 — Online Multiplayer (3–5 days)**
- Scaffold Colyseus server
- `FruitNinjaRoom.ts`: schema, spawn timer, slice validation
- `ColyseusClient.js`: `joinOrCreate`, state listeners
- Opponent blade trail rendering with interpolation
- Room lobby / matchmaking UI

**Milestone 6 — Deployment (1 day)**
- VPS provisioned, domain DNS configured
- Certbot + Let's Encrypt
- Nginx config with WebSocket proxy
- Docker Compose deployment
- Cache headers for `.task` / `.wasm` files

### 7.3 Claude Code Spec — Ready-to-Paste Prompt

Paste the following directly into a Claude Code session to begin implementation:

---

```
Build a browser-based, camera-controlled Fruit Ninja clone.

## Stack
- Client: Vanilla JavaScript (ES modules) + Vite, PixiJS v8, @mediapipe/tasks-vision (npm)
- Server: Node.js, TypeScript, Colyseus v0.15
- Deploy: nginx reverse proxy, Let's Encrypt TLS, Docker Compose

## Hand Tracking (client-side only, no server CV)
- Use @mediapipe/tasks-vision HandLandmarker
- CDN wasm: https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm
- Model URL: https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task
- runningMode: "VIDEO", numHands: 2, delegate: "GPU"
- Blade point = landmark index 8 (INDEX_FINGER_TIP), coords normalised 0-1
- Apply One Euro filter to x and y (minCutoff=1.0, beta=0.007)
- Mirror the webcam canvas (CSS transform: scaleX(-1))
- Use requestVideoFrameCallback for the detection loop (rAF fallback)
- detectForVideo(video, performance.now())

## Game Mechanics
- Fruits spawn from bottom edge with random (vx, vy), gravity 980 px/s²
- Spawner: every 1200 ms initially, decreasing to 500 ms at score 50
- Slice detection: line-circle intersection between (prevX,prevY)→(currX,currY) and fruit circle
  - Only fire if fingertip speed > 150 px/s
- On slice: split sprite animation, 8-12 juice particles, increment score
- Bomb hit: lose 1 life, screen flash red
- Missed fruit (exits bottom): lose 1 life
- Lives: 5 total, game over at 0
- Combo: 3 fruits in 0.5 s window = 2x multiplier, display combo text

## Blade Trail
- Ring buffer of last 20 smoothed fingertip positions
- Tapered polyline, warm yellow/white gradient
- Use PixiJS Graphics drawn each frame

## Single-Player
- Full single-player game loop with start screen, game screen, game-over screen
- Local high score in localStorage

## Local Two-Hand Multiplayer
- numHands: 2; left hand = Player 1 (yellow trail), right hand = Player 2 (blue trail)
- Shared screen, combined score visible, separate lives

## Online Multiplayer (Colyseus)
Server-side (server/src/rooms/FruitNinjaRoom.ts):
- Schema: Player { score, lives, bladeX, bladeY }, Fruit { id, fruitType, x, y, vx, vy, spawnTs, sliced }
- GameState: MapSchema<Player>, MapSchema<Fruit>
- maxClients: 2
- 20 Hz simulation tick via setSimulationInterval
- Server authoritative fruit spawning every 1200-500 ms
- Message handlers: "slice_attempt" { fruitId } → validate + set sliced=true + increment score
- Message handlers: "blade_pos" { x, y } → update player.bladeX/Y
- On fruit sliced or offscreen: delete from map

Client-side (client/src/net/ColyseusClient.js):
- Colyseus JS SDK: new Client("wss://yourdomain.com/colyseus/")
- joinOrCreate("fruit_ninja")
- On state change: reconcile local fruit list with server map
- Send "blade_pos" at 30 Hz (throttled with setInterval)
- Send "slice_attempt" when local line-circle intersection fires
- Render opponent bladeX/Y as ghost trail (50 ms interpolation delay)

## File Layout (create all files)
client/src/main.js — entry, getUserMedia, HandTracker init, game loop
client/src/tracking/HandTracker.js — HandLandmarker wrapper + One Euro filter
client/src/game/Fruit.js — entity class, physics, is-offscreen
client/src/game/FruitSpawner.js — timer, random spawn, difficulty
client/src/game/SliceDetector.js — lineCircleIntersects + speed gate
client/src/game/ScoreManager.js — score, lives, combo, localStorage
client/src/rendering/Renderer.js — PixiJS Application, layers
client/src/rendering/BladeTrail.js — ring buffer, draw method
client/src/rendering/ParticleSystem.js — juice burst
client/src/net/ColyseusClient.js — room connect, state sync
server/src/index.ts — Colyseus server startup
server/src/rooms/FruitNinjaRoom.ts — room + schema + game logic
nginx/default.conf — HTTPS, WS proxy to :2567
docker-compose.yml — nginx + colyseus containers

## Constraints
- No React, no Vue — vanilla JS modules only on client
- getUserMedia MUST be called from user gesture (button click)
- webcam <video> and <canvas> must be absolutely positioned and layered (canvas on top)
- All fruit positions in server state are normalised 0-1; multiply by canvas dimensions on client
- NEVER send video frames over network
- HTTPS required in production (localhost exempt)
```

---

## 8. Additional Implementation Notes

### 8.1 MediaPipe Handedness and Mirroring

When `facingMode: "user"` (selfie camera), MediaPipe reports `handedness` relative to the **image coordinate system**, not the player's perspective. This means the API returns `"Right"` for what the player perceives as their left hand. When assigning hands to players (local multiplayer), flip the interpretation: `handedness === "Right"` → Player 1 in mirrored view. Verify this empirically by logging and waving one hand.

### 8.2 GPU vs CPU Delegate Selection

Use `delegate: "GPU"` as the default. The GPU path uses WebGPU (where available) or falls back to WebGL via WASM. If the user's browser does not support WebGPU (e.g., older Firefox), the SDK silently falls back. To check:

```javascript
const supportsWebGPU = "gpu" in navigator;
const delegate = supportsWebGPU ? "GPU" : "CPU";
```

On CPU-only with WASM, expect 15–20 FPS on a modern laptop. This is playable but noticeably less smooth. Consider showing a performance warning if frame time consistently exceeds 50 ms.

### 8.3 Model File Serving and Caching

The `.task` model file (~15 MB) should be committed to the repository and served from your own origin (not fetched from Google Storage on every load). This eliminates a third-party CDN dependency, works offline after first load, and allows the browser to cache it aggressively. Serve with `Cache-Control: public, max-age=2592000, immutable`.

### 8.4 Audio with Howler.js

```javascript
import { Howl } from "howler";

const sliceSound = new Howl({ src: ["assets/sounds/slice.mp3", "assets/sounds/slice.ogg"] });
const bombSound  = new Howl({ src: ["assets/sounds/bomb.mp3"] });
const comboSound = new Howl({ src: ["assets/sounds/combo.mp3"] });

// Fire on slice:
sliceSound.play();
```

Preload all sounds during the start screen to avoid first-play latency.

### 8.5 Mobile Considerations

On mobile browsers, `getUserMedia` with `facingMode: "user"` uses the front-facing camera, which is typically 12 MP / 30 fps. MediaPipe works well on modern mobile hardware. Key differences from desktop:
- Canvas rendering must account for device pixel ratio: `canvas.width = clientWidth * devicePixelRatio`
- Touch events replace mouse events for UI buttons
- Performance is tighter on mobile; keep particle counts lower

### 8.6 Colyseus Production Notes

- Default port is `2567`. This can be configured via environment variable.
- Each Colyseus room instance is a single-threaded JS context. The fruit-ninja room has negligible CPU cost (no physics simulation — physics runs client-side, server only maintains spawn state).
- Use `this.clock.currentTime` (Colyseus's internal clock) for timestamps rather than `Date.now()`, to ensure consistent timing across reconnections.
- On disconnect, clients can rejoin within 5 seconds by default — set `this.allowReconnection(client, 5)` in `onLeave` for smoother handling of brief network drops.

---

## Key Library Reference

| Library | Version | Install | Purpose |
|---|---|---|---|
| `@mediapipe/tasks-vision` | `0.10.22+` | `npm i @mediapipe/tasks-vision` | Hand landmark detection |
| `pixi.js` | `^8.0.0` | `npm i pixi.js` | 2D WebGL renderer |
| `colyseus` | `^0.15.0` | `npm i colyseus` (server) | Multiplayer game server |
| `@colyseus/sdk` | `^0.15.0` | `npm i @colyseus/sdk` (client) | Colyseus browser client |
| `@colyseus/schema` | `^2.0.0` | `npm i @colyseus/schema` | Shared state schemas |
| `howler` | `^2.2.4` | `npm i howler` | Audio playback |
| `vite` | `^5.0.0` | `npm i -D vite` | Dev server + bundler |
| `three` | `^0.170.0` | `npm i three` | Alternative: 3D renderer |
| `mattdesl/line-circle-collision` | `^1.0.2` | `npm i line-circle-collision` | Optional: collision util |
