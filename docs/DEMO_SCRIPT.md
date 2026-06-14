# 5-Minute Demo — Read-Off Script

Everything in **plain text is what you say** (just read it). Lines in `[brackets]` are
*stage directions* — what to do on screen, don't read them out loud. Aim for a relaxed
pace; the whole thing is about 5 minutes. Have a second device or a friend ready for the
1v1 part.

> Tip: warm up one solo round before recording so your belt rank isn't on Level 1 — it
> shows the progression system off better.

---

## PART 1 — Show the game first (~1 min 30s)

`[Start on your face/cam, game open on the home screen.]`

"This is Fruit Ninja — but watch: there's no mouse, no controller, no touchscreen. My
webcam is tracking my hand, and my fingertip is the blade."

`[Click PLAY → Solo. Hold your hand up so the ready screen confirms it, let the 3-2-1 run,
then slice.]`

"So I just hold my hand up, it confirms it can see me, and now I'm slicing real fruit in
3D with my finger in the air."

`[Slice a few. Then deliberately swipe through a cluster of fruit at once.]`

"When I cut several at once, that's a combo — and combos are worth a lot more points."

`[Let a bomb hit, or miss three, to trigger game over and show the score screen.]`

"And there's progression. Every game earns XP and ranks me up through martial-arts belts —
White Belt all the way to Black — so there's a reason to keep playing and get better."

`[Back to mode select. Briefly show the three modes.]`

"There are three ways to play: Solo, two players on one screen with two hands, and the big
one — real-time online 1v1."

`[Click Versus → Create. Show the code/link. On the second device, join. Play a few seconds.]`

"This is the same game over the internet. We both get the exact same fruit, we race to
slice it, and there's a live score and a countdown. First one to out-slice the other wins."

---

## PART 2 — How I built it (~2 min 30s)

`[You can talk to camera here, or screen-share the repo / a simple diagram.]`

"Here's the interesting part — how this actually works, because all of this was new to me
this week.

**The hand tracking** is the foundation. I'm using Google's MediaPipe — it's a computer-vision
model that finds 21 points on your hand in every camera frame. I take one specific point,
the tip of the index finger, and that becomes the blade. The big decision here: I run the
whole model **on your own device, in the browser**. Nothing is ever uploaded — no video
leaves your computer. That keeps it private and it keeps it fast, because there's no server
round-trip just to know where your hand is.

**The game world** is where I made the choice I'm most proud of. The fruit are real 3D
models rendered with Three.js, but I set the camera up so that the 3D world lines up
one-to-one with the flat screen — a pixel on screen is the same coordinate as a point in
the game. That means checking 'did my finger slice this fruit?' is just simple 2D
geometry: did the line my fingertip drew cross the circle of the fruit? It looks 3D but the
math stays simple and runs fast.

**For feel** — and this was the hardest part — raw hand tracking is jittery. I smooth the
fingertip with something called a One-Euro filter, and I render the game at 60 frames a
second even though the camera only updates about 30 times a second, so the blade always
feels smooth instead of choppy. There's also a live sensitivity slider so the controls can
be dialed in.

**For multiplayer**, I built a server with Socket.io. The decision that made it work: the
server is the single source of truth. It generates the fruit and decides the score, so
nobody can cheat and both players stay perfectly in sync. But — and this is the key part —
**the video never goes over the network.** Each player tracks their own hand locally, and
we only send tiny messages, like 'I sliced fruit number 47.' That's why it's fair and has
no lag.

And I made the game itself reward skill — bombs and dropped fruit cost you more and more
points as the match goes on, and the fruit come in from different angles, so you can't just
swipe back and forth to win."

`[Optional: show the deployment — it's live on a URL, running in Docker behind a reverse proxy.]`

"It's fully deployed and live on the internet — anyone can open the link and play."

---

## PART 3 — Working with AI (~45s)

`[Back to camera.]`

"The whole point of this week was learning an unfamiliar stack fast. I'd never done 3D
graphics, never done camera-based input, never done real-time networking. AI was my
learning engine. I used it to compare the technology options and pick the stack, I had it
explain and justify each architectural decision before I committed to it, and when the
controls felt wrong, instead of asking for a quick patch I pushed it to find the root
cause — which turned out to be a smoothing filter tuned for the wrong units. The result is
a deployed, multiplayer, 3D, camera-controlled game, built in a week, in a stack I started
from zero."

`[End on one more satisfying slice, with the live URL on screen.]`

---

### Quick reference — the decisions you made (in case you get asked)
- **Path 2 — Three.js + Socket.io (browser game).** No install, instant to share by link,
  and the docs/AI support are excellent.
- **On-device MediaPipe hand tracking.** Private (no video uploaded) and low-latency.
- **3D world mapped to screen pixels.** Fruit look 3D; collision stays simple + fast; and
  single-player and multiplayer share the exact same engine.
- **Authoritative server, video stays local.** Fair, cheat-proof, and tiny network traffic.
- **Everything procedural** (fruit, juice, sound, music) — no art/audio pipeline to manage.
- **Belt/XP progression** for a sense of advancement, persisted across sessions.
