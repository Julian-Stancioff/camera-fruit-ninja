# Demo Script 2 — "What I Changed Since the First Submission"

A companion to `DEMO_SCRIPT.md`. That one walks through *what the game is*; this one is
for a **technical walkthrough of the upgrades I made after the first version** — the
quality-of-life and depth changes that turned a working prototype into a polished game.

**How to use it:** you drive the walkthrough (show each thing on screen); the lines below
are what you say. Each item is 1–2 sentences: *what it is* + *how I built it technically*.
Read straight through, or jump to whatever you're demoing.

---

## 1. Controls & hand tracking (the feel)

- **Smooth, responsive blade.** I run the raw fingertip through a One-Euro filter — an
  adaptive low-pass that smooths when your hand is still but barely lags on fast swipes —
  and I do it in *screen-pixel space*, not the camera's 0-to-1 coordinates, so the filter's
  tuning actually bites.
- **60fps that never looks choppy.** The webcam only updates ~30 times a second, so I
  render the game at 60fps with `requestAnimationFrame` and only re-run the hand model on
  an actual new camera frame — the fruit and blade stay buttery even though tracking is half
  the rate.
- **Reach the whole screen.** A hand only comfortably covers the middle of the frame, so I
  apply a *centered sensitivity gain* that expands a small hand motion to the full screen,
  and exposed it as a live Sensitivity slider in Settings.
- **No dropouts.** If the model briefly loses the hand, I "coast" the blade on its last
  position for a few frames instead of snapping it away, so a single bad frame doesn't break
  your swipe.

## 2. Keeping it locked on *your* hand

- **Hand lock.** The tracker watches up to two hands, so I lock the blade onto the hand
  you started with by always picking the one nearest its last position — a stranger's hand
  wandering into frame can't hijack your blade.
- **See the tracking.** During play I draw your hand's full skeleton right on the camera
  thumbnail, with the index finger to the fingertip highlighted, by mapping the model's
  landmarks onto the little video box — so you can always see it's locked on the right hand.
- **"Bring your hand back."** If your locked hand leaves the frame for about a quarter
  second, I flag it as lost, pop up a prompt, and ease the fruit down to a crawl until you
  return — then it re-acquires automatically and speeds back up.
- **Per-side, not global.** In two-player that slow-down only happens on the half that lost
  its hand; the other player keeps going at full speed, because each side tracks its own
  lock and its own slow factor.
- **Ready gate.** Before every match I show the camera big with the live hand skeleton drawn
  on it and only start once it actually sees the required hands for about half a second — in
  2-player each side lights up in its own color (red / blue) so you know both are detected.

## 3. Game modes

- **Online 1v1.** I added a Node + Socket.io server that's *authoritative* — it generates
  one shared fruit stream in normalized coordinates and decides the score — so both players
  race the exact same fruit; each client predicts its own cut instantly for feel, and **no
  video ever goes over the wire**, just tiny "I sliced fruit #47" messages.
- **Same-screen 2-player.** Two players, two hands, one screen: I split the canvas into two
  viewports that share a single WebGL renderer (using scissor regions), and assign each
  detected hand to a side by which half of the camera it's in.
- **Pause & quit.** I added a pause button and the Esc key; in solo and 2-player it truly
  freezes — the loop, the timer, and the music all stop and the timer is offset on resume so
  it doesn't jump — while online 1v1 only offers "keep playing or quit" since you can't
  freeze a live networked match.

## 4. Difficulty & balance (making it skillful)

- **Combos.** Slicing several fruit in a short window chains into a combo worth escalating
  points; in the online server I track each player's slice chain and award the bonus there,
  so combos count even in multiplayer.
- **Anti-"just sweep side-to-side."** I cut the fruit count so the screen never floods, but
  added occasional tight 2–3 fruit *clusters* (a combo opportunity) and *cross-court*
  launches from the edges, so mindlessly swiping straight across misses.
- **Penalties that escalate.** Slicing a bomb or letting fruit drop costs more and more the
  longer the match runs — the server computes each fruit's air-time and docks points if no
  one slices it, so letting things fall genuinely hurts late game.
- **Bombs come in early.** I gate bombs by *time* now (eligible from ~4 seconds, with a
  forced first bomb by ~6.5s if the dice are quiet), so a bomb reliably shows up in the first
  5–10 seconds instead of way later.
- **Forgiving where it counts.** I lowered the swipe-speed threshold and widened the slice
  hit-radius so gentle cuts still register, and added a short grace window after any hit so
  you don't lose three lives at once when fruit fall together.

## 5. Progression

- **Belt ranks.** Every game banks its score as XP, and I level you up through martial-arts
  belts (White → Black) on the game-over screen, persisted in the browser's localStorage so
  your rank carries across sessions.

## 6. Audio

- **Original arcade music.** All the music is generated live with the Web Audio API — no
  sound files — using a lookahead scheduler that layers drums, bass, and a lead riff into a
  loop at a fixed tempo.
- **It starts instantly and you can mix it.** I kick the music off on your first tap (browsers
  require a gesture for audio), and added separate volume sliders for menu vs in-game music.
- **Game-over sting.** When you lose, the music cuts out and a short descending "nuh-nuh-nuh"
  sound plays, and the soundtrack only restarts on a new game or back at the menu.

## 7. UI & polish

- **Full-screen arcade look.** I rebuilt the home and mode-select as full-screen arcade
  screens with a neon title, drifting fruit, and panels that light up on hover.
- **Clearer HUD.** A count-up timer up top, bigger strike "X" marks, combo call-outs, and a
  softer "edge vignette" red flash when you get hit instead of covering the whole screen.
- **Juicier slicing.** On a cut I spray particle "juice" along the direction of the blade
  with a quick flash, and the fruit use a glossier 3D material so they read as real fruit.
- **Pick your scene.** Selectable backgrounds (dojo, sunset, neon, night, sakura), saved to
  localStorage.

---

### One-line wrap
"So between the first version and now, most of the work went into *feel and reliability* —
keeping the blade locked on your hand, smoothing the tracking, and recovering gracefully when
the camera loses you — plus real depth: online and local multiplayer, combos, escalating
risk, progression, and an original soundtrack."
