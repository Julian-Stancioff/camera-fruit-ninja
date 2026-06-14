# Key Technical Decisions & Rationale

Each decision below was reached by analyzing the requirement with AI, weighing
options, and committing — the case study rewards *informed* choices, so the
reasoning is recorded here.

### 1. Renderer: Three.js (3D) over Phaser/PixiJS (2D)
The brief's browser path allows Phaser (2D) or Three.js (3D). We chose **Three.js**
to match the original Fruit Ninja's glossy 3D fruit. Risk: 3D collision is harder.
**Mitigation:** an **orthographic camera mapped to screen pixels** — fruit are 3D
meshes but move on a camera-facing plane, so collision stays a 2D segment-vs-circle
test. Best of both: 3D look, 2D-simple hit detection.

### 2. Input: MediaPipe hand tracking, client-side only
The novel hook is controlling the blade with your hand via webcam. **MediaPipe
HandLandmarker** is pre-trained, runs in-browser on the GPU (WASM), and needs no
training data or server. We use **landmark 8 (index fingertip)** as the blade.

### 3. Smoothing: One Euro filter, in *pixel* space
Raw hand landmarks jitter. The **One Euro filter** is adaptive (smooth at rest,
responsive in motion). Critical lesson: it must run on **pixel-space** values, not
the normalized [0,1] coords — its speed term is tuned for large values, so on
normalized input it never engaged and the blade felt laggy (see Brainlift, Day "feel").

### 4. Sensitivity gain
A hand only comfortably covers the middle ~60% of the camera frame, so a 1:1 mapping
can't reach the screen edges. We apply a **centered gain (~1.8×)** so a comfortable
hand range sweeps the whole screen — this fixed both "can't reach the edges" and
"feels too slow." Exposed as a player-tunable slider.

### 5. Render loop decoupled from camera
The camera is 30fps but displays are 60fps+. We render with `requestAnimationFrame`
(60fps, smooth fruit/trail) and run MediaPipe only on **new camera frames** (guarded
by `video.currentTime`). This removed the "clunky/choppy" feel.

### 6. Multiplayer: Socket.io, authoritative server, shared fruit stream
The brief names **Socket.io** for the browser path. The server **owns the fruit
spawn stream** (sent in normalized coords so any screen size stays in sync) and is
**authoritative on slice claiming + score**, so two players race for the same fruit
fairly. Clients **predict their own cut instantly** for feel but take the score from
the server. **Video never crosses the network** — only ~16-byte slice/blade messages.
We chose Socket.io over the heavier Colyseus (from our research) for alignment with
the brief and because a 2-player race needs nothing more than spawn/slice/score events.

### 7. Progression: dojo belt ranks
The brief requires "levels or progression." **Belt ranks (White→Black)** by cumulative
fruit sliced are thematic to the dojo, persist across sessions (localStorage), and
work in both solo and versus — a clean "sense of advancement."

### 8. Hosting: Dokploy + Caddy on a VPS
`getUserMedia` requires HTTPS. **Caddy** provides automatic TLS (on-demand) and proxies
the Socket.io WebSocket with zero per-app config; **Dokploy** builds/deploys the two
Docker images from git. Self-hosting the MediaPipe model/wasm avoids a third-party CDN
dependency at runtime.

### 9. Versus balance: skill over spam
Early play-testing showed the 1v1 devolved into "just sweep side-to-side" once fruit got
dense. Fixes, all server-side (authoritative): **fewer fruit on screen** (mostly singles,
no end-game flood) but occasional **2–3 fruit clusters** that one aimed swipe can combo;
**combos award escalating points** (server tracks the chain per player); **cross-court
launches** from the edges so horizontal sweeping misses; **a touch faster** fall; and
**penalties that grow over the match** — a sliced bomb costs 3→18 points and a *dropped*
fruit costs 1→5 the later it happens, so blind swiping actively loses. A combo cluster
never contains a bomb (combos stay rewarding, not punishing).

### 10. Pause / quit-to-menu
Solo and 2-player **truly pause** (the loop, the timer, and the music all freeze; the timer
is offset on resume so it never jumps). Versus **can't** freeze a live networked match, so
its overlay only offers "keep playing" or "quit" (which leaves the match). Reachable by the
on-screen button or the **Esc** key.

### 11. Assets: procedural first, AI-art later
Fruit are **procedural Three.js meshes** (textured spheres/cones + accents); SFX are
**synthesized with the Web Audio API**. Zero asset files, no licensing issues, fully
tunable. AI image tools (Higgsfield) are reserved for later visual polish if needed.
