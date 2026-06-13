# 5-Minute Demo Video — Script & Shot List

Goal: show a fun, working multiplayer game + a technical walkthrough + reflection on
AI-augmented development. Record at **1080p**, screen + webcam. Keep energy up; the
game is visual, so *show* more than you tell.

**Prep:** good lighting on your hand; have a second device/browser ready for the 1v1;
pre-open the Settings panel once so you know where it is; do a warm-up round so your
belt isn't White (shows progression).

---

### 0:00–0:30 — Hook (play first, talk second)
- **Show:** you, on camera, slicing fruit in the air with your hand — a few satisfying
  combos and a bomb dodge. No narration for the first ~8 seconds; let it land.
- **Say:** "This is Fruit Ninja — but there's no mouse, no touchscreen. My webcam tracks
  my hand and my fingertip is the blade. It's a browser game, and it has real-time
  online multiplayer. I built it this week in a stack I'd never touched."

### 0:30–1:45 — Solo gameplay + progression
- **Show:** a full short solo round — combos (slice several at once), the combo text,
  a bomb ending the run, the game-over/score screen.
- **Point out:** the **belt rank** badge ranking up ("White → Yellow…") — "this is the
  progression system: you advance belts the more you slice, across sessions."
- **Show:** open the **⚙ Settings** panel, nudge Sensitivity — "feel is tunable live."

### 1:45–3:00 — Multiplayer 1v1 (the headline)
- **Show:** click **Versus → Create a game**, reveal the code/link. On a second device
  (or split screen), **join with the link**. Countdown → match.
- **Show:** both players slicing the **same** fruit; the live **You vs Opponent** score;
  the opponent's **ghost blade trail**; the timer ticking down; the **win/lose** screen.
- **Say:** "Both players see the exact same fruit stream from the server. We each track
  our own hand locally — **no video is ever sent**, just tiny slice and fingertip
  messages — and the server decides who claimed each fruit, so it's fair and lag-free."

### 3:00–4:15 — Technical walkthrough
Screen-share the repo / a simple diagram. Hit these:
- **Stack:** Three.js (3D) + MediaPipe hand tracking + Socket.io netcode + Node server,
  deployed behind Caddy/Docker. "All new to me this week."
- **The clever bit:** orthographic camera mapped to screen pixels → fruit are 3D but
  collision is a simple 2D test, and the *same* coordinate space holds the fingertip.
- **Netcode:** authoritative server owns spawns + score; clients predict their own cut
  instantly; multiplayer reused the single-player engine because of the coordinate design.
- **The hard part — feel:** briefly tell the lag→jitter→reach story and the fix
  (smoothing in pixel space, sensitivity gain, 60fps decoupled from the 30fps camera).

### 4:15–5:00 — AI-augmented development reflection
- **Say:** "I'd never done 3D, computer-vision input, or real-time netcode. AI was the
  learning engine: it researched the stack, I had it **decide and justify** each
  architecture choice, it wrote runnable proofs to validate concepts fast, and — the
  most valuable part — when the controls felt wrong, prompting for **root cause instead
  of a quick patch** found the real bug (a filter tuned for the wrong units). I shipped
  a deployed, multiplayer 3D game in a week in a stack I started from zero."
- **End on:** a final fun slice + the live URL on screen.

---

### B-roll / safety shots to capture
- Clean solo combo montage (5–10s) for the intro.
- Both-players-on-screen moment during versus.
- The belt-up toast firing.
- The repo README / architecture diagram.
- The Settings sliders moving.
