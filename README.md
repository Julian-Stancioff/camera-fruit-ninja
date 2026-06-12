# Camera Fruit Ninja

A browser-based, **camera-controlled Fruit Ninja** clone. The player's hand is
tracked via the webcam (Google MediaPipe, entirely client-side) and the index
fingertip becomes the blade. No special hardware — any laptop webcam works.

> **Status:** planning. Design is being scoped before any build work begins.
> The full technical research that informs this build lives in
> [`docs/camera-fruit-ninja-build-guide.md`](docs/camera-fruit-ninja-build-guide.md).

## Intended stack (per research, subject to planning)

- **Client:** vanilla JS (ES modules) + Vite, PixiJS v8 renderer
- **Hand tracking:** `@mediapipe/tasks-vision` HandLandmarker (landmark 8 = blade),
  One Euro filter smoothing, `requestVideoFrameCallback` loop
- **Multiplayer (optional):** local two-hand, and/or online via Colyseus
  (slice + blade events synced; webcam frames never leave the client)
- **Deploy:** on the existing VPS behind Caddy (HTTPS is mandatory for camera access)

## Layout

```
docs/    research + design notes
```

More structure will be added once the plan is approved.
